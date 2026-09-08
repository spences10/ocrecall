import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from './db.ts';
import { codex_home, database_path } from './sources.ts';

export const RESUMABLE_API_SCHEMA_VERSION = 1 as const;
export const RESUMABLE_API_CAPABILITIES = [
	'archive-preserving-source-liveness',
	'cwd-scope',
	'server-side-search',
	'pagination',
	'codex-thread-id',
	'resume-support-unverified',
] as const;
export interface ListResumableSessionsOptions {
	db_path?: string;
	codex_home?: string;
	cwd?: string;
	scope?: 'project' | 'all';
	query?: string;
	limit?: number;
	offset?: number;
	signal?: AbortSignal;
}
export interface ResumableSession {
	id: string;
	path: string;
	codex_home: string;
	cwd: string;
	name?: string;
	created_at: string;
	modified_at: string;
	message_count: number;
	first_message: string;
	history_mode: 'paginated';
	source_exists: true;
	resume_status: 'unverified';
}
export interface ResumableSessionsResult {
	schema_version: typeof RESUMABLE_API_SCHEMA_VERSION;
	capabilities: typeof RESUMABLE_API_CAPABILITIES;
	sessions: ResumableSession[];
}
export async function list_resumable_sessions(
	options: ListResumableSessionsOptions = {},
): Promise<ResumableSessionsResult> {
	options.signal?.throwIfAborted();
	const scope = options.scope ?? (options.cwd ? 'project' : 'all');
	if (!['project', 'all'].includes(scope))
		throw new Error('scope must be project or all');
	if (scope === 'project' && !options.cwd)
		throw new Error('cwd is required for project scope');
	const limit = options.limit ?? 100;
	const offset = options.offset ?? 0;
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > 1000 ||
		!Number.isSafeInteger(offset) ||
		offset < 0
	)
		throw new Error('Invalid limit or offset');
	const result: ResumableSessionsResult = {
		schema_version: RESUMABLE_API_SCHEMA_VERSION,
		capabilities: RESUMABLE_API_CAPABILITIES,
		sessions: [],
	};
	const home = codex_home(options.codex_home);
	const path = database_path(home, options.db_path);
	if (!existsSync(path)) return result;
	const db = new Database(path);
	try {
		const cwd = scope === 'project' ? resolve(options.cwd!) : null;
		const query = options.query?.trim() ?? '';
		const rows = db.all(
			`SELECT s.*,src.path,src.codex_home,
		 (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.type IN ('user','assistant')) AS message_count,
		 (SELECT content_text FROM messages m WHERE m.session_id=s.id AND m.type='user' ORDER BY source_order LIMIT 1) AS first_message
		 FROM sessions s JOIN session_sources src ON src.session_id=s.id AND src.state='active'
		 WHERE (? IS NULL OR s.cwd=?) AND (?='' OR instr(lower(COALESCE(s.name,'') || ' ' || COALESCE(s.cwd,'')),lower(?))>0
		 OR EXISTS(SELECT 1 FROM messages m WHERE m.session_id=s.id AND m.type IN ('user','assistant') AND instr(lower(m.content_text),lower(?))>0))
		 ORDER BY s.last_timestamp DESC,s.id,src.path`,
			cwd,
			cwd,
			query,
			query,
			query,
		);
		const seen = new Set<string>();
		// Check current file existence before pagination; stale paths do not consume slots.
		for (const row of rows) {
			options.signal?.throwIfAborted();
			const id = String(row.id);
			if (seen.has(id) || !existsSync(String(row.path))) continue;
			seen.add(id);
			if (seen.size <= offset) continue;
			result.sessions.push({
				id,
				path: String(row.path),
				codex_home: String(row.codex_home),
				cwd: String(row.cwd ?? ''),
				name: row.name === null ? undefined : String(row.name),
				created_at: new Date(
					Number(row.first_timestamp),
				).toISOString(),
				modified_at: new Date(
					Number(row.last_timestamp),
				).toISOString(),
				message_count: Number(row.message_count),
				first_message: String(
					row.first_message ?? '(no messages)',
				).slice(0, 500),
				history_mode: 'paginated',
				source_exists: true,
				resume_status: 'unverified',
			});
			if (result.sessions.length === limit) break;
		}
		return result;
	} finally {
		db.close();
	}
}
