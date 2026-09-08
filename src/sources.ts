import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { read_lines } from './parser.ts';
import { object, string } from './types.ts';

export function codex_home(value?: string) {
	return resolve(
		value ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
	);
}
export function database_path(home: string, value?: string) {
	return value ? resolve(value) : join(home, 'ocrecall.db');
}

/** Unlike permissive globs, propagate unreadable subdirectories. */
export async function discover(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await discover(path)));
		else if (entry.isFile() && entry.name.endsWith('.jsonl'))
			files.push(path);
	}
	return files.sort();
}
export async function fingerprint(path: string, size: number) {
	const handle = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(size);
		const { bytesRead } = await handle.read(buffer, 0, size, 0);
		return createHash('sha256')
			.update(buffer.subarray(0, bytesRead))
			.digest('hex');
	} finally {
		await handle.close();
	}
}
export async function session_names(home: string) {
	const names = new Map<
		string,
		{ name: string; updated_at: number }
	>();
	try {
		for await (const { line } of read_lines(
			join(home, 'session_index.jsonl'),
		)) {
			try {
				const row = object(JSON.parse(line));
				const id = string(row.id);
				const name = string(row.thread_name);
				const updated_at = Date.parse(string(row.updated_at) ?? '');
				if (
					id &&
					name !== null &&
					Number.isFinite(updated_at) &&
					updated_at >= (names.get(id)?.updated_at ?? 0)
				)
					names.set(id, { name, updated_at });
			} catch {
				/* An incomplete or invalid index entry is not a transcript failure. */
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
			throw error;
	}
	return names;
}

export interface SessionMetadata {
	id: string;
	name: string | null;
	updated_at: number;
	git_branch: string | null;
}

/** Optional enrichment; rollout parsing never depends on Codex's state schema. */
export async function state_metadata(directory: string) {
	const { DatabaseSync } = await import('node:sqlite');
	const result: {
		sessions: SessionMetadata[];
		links: Array<{ parent: string; child: string }>;
		warnings: string[];
	} = { sessions: [], links: [], warnings: [] };
	let names: string[];
	try {
		names = (await readdir(directory))
			.filter((name) => /^state_\d+\.sqlite$/.test(name))
			.sort(
				(a, b) =>
					Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]),
			);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
			result.warnings.push(String(error));
		return result;
	}
	for (const name of names) {
		let db: InstanceType<typeof DatabaseSync> | undefined;
		try {
			db = new DatabaseSync(join(directory, name), {
				readOnly: true,
			});
			db.exec('PRAGMA busy_timeout=1000');
			const columns = new Set(
				db
					.prepare('PRAGMA table_info(threads)')
					.all()
					.map((row) => String(row.name)),
			);
			if (!columns.has('id')) {
				result.warnings.push(`${name}: unsupported threads schema`);
				continue;
			}
			const select = (column: string) =>
				columns.has(column) ? column : `NULL AS ${column}`;
			const selected = [
				'id',
				'name',
				'title',
				'updated_at_ms',
				'updated_at',
				'git_branch',
			]
				.map(select)
				.join(',');
			for (const row of db
				.prepare(`SELECT ${selected} FROM threads`)
				.all()) {
				const updated_at = Number(
					row.updated_at_ms ?? Number(row.updated_at ?? 0) * 1000,
				);
				result.sessions.push({
					id: String(row.id),
					name: string(row.name) ?? string(row.title),
					updated_at,
					git_branch: string(row.git_branch),
				});
			}
			const edges = new Set(
				db
					.prepare('PRAGMA table_info(thread_spawn_edges)')
					.all()
					.map((row) => String(row.name)),
			);
			if (
				edges.has('parent_thread_id') &&
				edges.has('child_thread_id')
			)
				for (const row of db
					.prepare(
						'SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges',
					)
					.all())
					result.links.push({
						parent: String(row.parent_thread_id),
						child: String(row.child_thread_id),
					});
			break;
		} catch (error) {
			result.warnings.push(`${name}: ${String(error)}`);
		} finally {
			db?.close();
		}
	}
	return result;
}
