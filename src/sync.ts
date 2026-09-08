import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Database } from './db.ts';
import { normalize, record_id } from './normalize.ts';
import { parse_entry, read_header, read_lines } from './parser.ts';
import {
	discover,
	fingerprint,
	session_names,
	state_metadata,
} from './sources.ts';
import {
	object,
	string,
	type Context,
	type SyncResult,
} from './types.ts';

const PARSER_VERSION = 1;
export async function sync(
	db: Database,
	home: string,
	sqlite_home = home,
): Promise<SyncResult> {
	const result: SyncResult = {
		warnings: [],
		files_scanned: 0,
		files_processed: 0,
		legacy_skipped: 0,
		unsupported_files: 0,
		malformed_records: 0,
		unsupported_records: {},
		records_added: 0,
		messages_added: 0,
		usage_records_added: 0,
		errors: [],
	};
	for (const state of ['active', 'archived'] as const) {
		const root = join(
			home,
			state === 'active' ? 'sessions' : 'archived_sessions',
		);
		let files: string[];
		try {
			files = await discover(root);
		} catch (error) {
			// A missing root could be an unavailable mount, so do not infer deletion.
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
				result.errors.push({ path: root, message: String(error) });
			continue;
		}
		result.files_scanned += files.length;
		const seen = new Set<string>();
		for (const path of files) {
			seen.add(path);
			try {
				const before = await stat(path);
				const header = await read_header(path, before.size);
				if (
					!header ||
					header.type !== 'session_meta' ||
					!string(header.payload.id)
				) {
					result.unsupported_files++;
					continue;
				}
				const meta = header.payload;
				if (meta.history_mode !== 'paginated') {
					if (meta.history_mode === 'legacy') result.legacy_skipped++;
					else result.unsupported_files++;
					continue;
				}
				const session = meta.id as string;
				const previous = db.get(
					'SELECT * FROM sync_state WHERE file_path=?',
					path,
				);
				const prefix_size = Number(previous?.prefix_size ?? 0);
				const can_resume =
					previous &&
					previous.session_id === session &&
					previous.parser_version === PARSER_VERSION &&
					String(before.dev) === previous.device &&
					String(before.ino) === previous.inode &&
					before.size >= Number(previous.byte_offset) &&
					(before.size > Number(previous.byte_offset) ||
						before.mtimeMs === previous.mtime_ms) &&
					(await fingerprint(path, prefix_size)) ===
						previous.prefix_hash;
				const start = can_resume ? Number(previous.byte_offset) : 0;
				const context: Context = can_resume
					? (JSON.parse(String(previous.context_json)) as Context)
					: {
							turn_id: null,
							model: null,
							provider: string(meta.model_provider),
							cwd: string(meta.cwd),
						};
				let offset = start;
				let added = 0;
				let malformed = 0;
				const unsupported: Record<string, number> = {};
				const message_before = Number(
					db.get(
						'SELECT COUNT(*) AS n FROM messages WHERE session_id=?',
						session,
					)?.n,
				);
				const usage_before = Number(
					db.get(
						'SELECT COUNT(*) AS n FROM usage_records WHERE session_id=?',
						session,
					)?.n,
				);
				db.db.exec('BEGIN IMMEDIATE');
				try {
					db.run(
						`INSERT INTO sessions(id,recording_session_id,cwd,project_path,originator,source,cli_version,history_mode,git_branch,first_timestamp,last_timestamp) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
						session,
						string(meta.session_id),
						string(meta.cwd),
						string(meta.cwd),
						string(meta.originator),
						typeof meta.source === 'string'
							? meta.source
							: JSON.stringify(meta.source ?? null),
						string(meta.cli_version),
						'paginated',
						string(object(meta.git).branch),
						header.timestamp,
						header.timestamp,
					);
					const parent = string(meta.forked_from_id);
					if (parent)
						db.run(
							'INSERT OR IGNORE INTO session_links VALUES(?,?,?)',
							parent,
							session,
							'fork',
						);
					const spawn = object(object(meta.source).subagent);
					const spawn_parent = string(
						object(spawn.thread_spawn).parent_thread_id,
					);
					if (spawn_parent)
						db.run(
							'INSERT OR IGNORE INTO session_links VALUES(?,?,?)',
							spawn_parent,
							session,
							'spawn',
						);
					for await (const record of read_lines(
						path,
						start,
						before.size,
					)) {
						offset = record.end;
						if (!record.line.trim()) continue;
						const entry = parse_entry(record.line);
						if (!entry) {
							malformed++;
							continue;
						}
						const id = record_id(entry, record.start);
						const inserted = db.run(
							'INSERT OR IGNORE INTO records VALUES(?,?,?,?,?)',
							session,
							id,
							entry.type,
							entry.timestamp,
							record.start,
						).changes;
						if (!inserted) {
							// Replaying a moved/replaced file still needs model/turn context.
							if (entry.type === 'turn_context') {
								context.turn_id = string(entry.payload.turn_id);
								context.model = string(entry.payload.model);
								context.provider =
									string(entry.payload.model_provider) ??
									context.provider;
								context.cwd =
									string(entry.payload.cwd) ?? context.cwd;
							}
							if (
								entry.type === 'event_msg' &&
								entry.payload.type === 'task_started'
							)
								context.turn_id = string(entry.payload.turn_id);
							if (
								entry.type === 'event_msg' &&
								['task_complete', 'turn_aborted'].includes(
									String(entry.payload.type),
								)
							)
								context.turn_id = null;
							continue;
						}
						const unknown = normalize(
							db,
							session,
							entry,
							record.start,
							context,
						);
						if (unknown)
							unsupported[unknown] = (unsupported[unknown] ?? 0) + 1;
						added++;
						db.run(
							'UPDATE sessions SET last_timestamp=MAX(last_timestamp,?) WHERE id=?',
							entry.timestamp,
							session,
						);
					}
					const after = await stat(path);
					if (
						before.ino !== after.ino ||
						after.size < before.size ||
						(after.size === before.size &&
							before.mtimeMs !== after.mtimeMs)
					)
						throw new Error(
							'Source changed while being read; retry sync',
						);
					const hash_size = Math.min(offset, 4096);
					const hash = await fingerprint(path, hash_size);
					db.run(
						`INSERT INTO sync_state VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(file_path) DO UPDATE SET session_id=excluded.session_id,byte_offset=excluded.byte_offset,device=excluded.device,inode=excluded.inode,mtime_ms=excluded.mtime_ms,prefix_hash=excluded.prefix_hash,prefix_size=excluded.prefix_size,context_json=excluded.context_json,parser_version=excluded.parser_version`,
						path,
						session,
						offset,
						String(before.dev),
						String(before.ino),
						before.mtimeMs,
						hash,
						hash_size,
						JSON.stringify(context),
						PARSER_VERSION,
					);
					db.run(
						`INSERT INTO session_sources VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET session_id=excluded.session_id,state=excluded.state,size_bytes=excluded.size_bytes,mtime_ms=excluded.mtime_ms,last_seen_at=excluded.last_seen_at`,
						path,
						session,
						root,
						home,
						state,
						before.size,
						before.mtimeMs,
						Date.now(),
					);
					db.db.exec('COMMIT');
				} catch (error) {
					db.db.exec('ROLLBACK');
					throw error;
				}
				result.records_added += added;
				result.malformed_records += malformed;
				for (const [type, count] of Object.entries(unsupported))
					result.unsupported_records[type] =
						(result.unsupported_records[type] ?? 0) + count;
				if (offset > start) result.files_processed++;
				result.messages_added +=
					Number(
						db.get(
							'SELECT COUNT(*) AS n FROM messages WHERE session_id=?',
							session,
						)?.n,
					) - message_before;
				result.usage_records_added +=
					Number(
						db.get(
							'SELECT COUNT(*) AS n FROM usage_records WHERE session_id=?',
							session,
						)?.n,
					) - usage_before;
			} catch (error) {
				result.errors.push({ path, message: String(error) });
			}
		}
		db.transaction(() => {
			for (const row of db.all(
				'SELECT path FROM session_sources WHERE root=?',
				root,
			))
				if (!seen.has(String(row.path)))
					db.run(
						"UPDATE session_sources SET state='missing' WHERE path=?",
						row.path,
					);
		});
	}
	try {
		const names = await session_names(home);
		db.transaction(() => {
			for (const [id, value] of names)
				db.run(
					'UPDATE sessions SET name=?,name_updated_at=? WHERE id=? AND (name_updated_at IS NULL OR name_updated_at<=?)',
					value.name,
					value.updated_at,
					id,
					value.updated_at,
				);
		});
	} catch (error) {
		result.errors.push({
			path: join(home, 'session_index.jsonl'),
			message: String(error),
		});
	}
	const metadata = await state_metadata(sqlite_home);
	result.warnings.push(...metadata.warnings);
	db.transaction(() => {
		for (const row of metadata.sessions) {
			if (row.name !== null)
				db.run(
					'UPDATE sessions SET name=?,name_updated_at=? WHERE id=? AND (name_updated_at IS NULL OR name_updated_at<?)',
					row.name,
					row.updated_at,
					row.id,
					row.updated_at,
				);
			if (row.git_branch !== null)
				db.run(
					'UPDATE sessions SET git_branch=? WHERE id=?',
					row.git_branch,
					row.id,
				);
		}
		for (const link of metadata.links)
			db.run(
				'INSERT OR IGNORE INTO session_links VALUES(?,?,?)',
				link.parent,
				link.child,
				'spawn',
			);
	});

	return result;
}
