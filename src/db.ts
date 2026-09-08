import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { apply_schema } from './schema.ts';

export class Database {
	readonly db: DatabaseSync;
	readonly path: string;
	constructor(path: string) {
		this.path = path;
		if (path !== ':memory:')
			mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		try {
			this.db.exec(
				'PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;',
			);
			apply_schema(this.db);
			this.db.exec('PRAGMA journal_mode = WAL');
		} catch (error) {
			this.db.close();
			throw error;
		}
	}
	run(sql: string, ...values: SQLInputValue[]) {
		return this.db.prepare(sql).run(...values);
	}
	all(sql: string, ...values: SQLInputValue[]) {
		return this.db.prepare(sql).all(...values);
	}
	get(sql: string, ...values: SQLInputValue[]) {
		return this.db.prepare(sql).get(...values);
	}
	close() {
		this.db.close();
	}
	transaction<T>(fn: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const result = fn();
			this.db.exec('COMMIT');
			return result;
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}
	stats() {
		const count = (table: string) =>
			Number(this.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n);
		const counts = {
			sessions: count('sessions'),
			turns: count('turns'),
			messages: count('messages'),
			usage_records: count('usage_records'),
		};
		// The same response can appear in a fork's copied history. Count it once.
		const tokens = this.get(`WITH ranked AS (
		 SELECT *, ROW_NUMBER() OVER (PARTITION BY COALESCE(response_id, session_id || ':' || id) ORDER BY inherited, timestamp, session_id) AS rank
		 FROM usage_records
		) SELECT SUM(input_tokens) AS input, SUM(cached_input_tokens) AS cached_input,
		 SUM(cache_write_input_tokens) AS cache_write_input, SUM(output_tokens) AS output,
		 SUM(reasoning_output_tokens) AS reasoning_output, SUM(total_tokens) AS total
		 FROM ranked WHERE rank = 1 AND inherited = 0`);
		return {
			...counts,
			tool_counts: this.all(
				'SELECT kind, COUNT(*) AS count FROM tool_calls GROUP BY kind',
			),
			tokens,
			cost_total: null,
			usage_coverage: this.get(
				`SELECT COUNT(*) AS turns, SUM(CASE WHEN EXISTS(SELECT 1 FROM usage_records u WHERE u.session_id=t.session_id AND u.turn_id=t.id) THEN 1 ELSE 0 END) AS turns_with_usage FROM turns t`,
			),
		};
	}
	sessions(
		options: {
			project?: string;
			limit?: number;
			offset?: number;
			state?: string;
		} = {},
	) {
		return this.all(
			`SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id AND m.type IN ('user','assistant')) AS message_count,
		 (SELECT content_text FROM messages m WHERE m.session_id=s.id AND m.type='user' ORDER BY source_order LIMIT 1) AS first_message,
		 COALESCE((SELECT state FROM session_sources src WHERE src.session_id=s.id ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'archived' THEN 1 ELSE 2 END LIMIT 1),'missing') AS source_state
		 FROM sessions s WHERE (? IS NULL OR s.project_path = ?) AND (? IS NULL OR EXISTS(SELECT 1 FROM session_sources src WHERE src.session_id=s.id AND src.state=?))
		 ORDER BY s.last_timestamp DESC, s.id LIMIT ? OFFSET ?`,
			options.project ?? null,
			options.project ?? null,
			options.state ?? null,
			options.state ?? null,
			options.limit ?? 20,
			options.offset ?? 0,
		);
	}
	search(
		term: string,
		options: {
			project?: string;
			limit?: number;
			include_rolled_back?: boolean;
		} = {},
	) {
		if (!term.trim()) return [];
		const query = '"' + term.replaceAll('"', '""') + '"';
		return this.all(
			`SELECT m.*, s.project_path, s.name, bm25(messages_fts) AS relevance,
		 snippet(messages_fts,0,'>>>','<<<','…',32) AS snippet
		 FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid JOIN sessions s ON s.id=m.session_id
		 WHERE messages_fts MATCH ? AND (? IS NULL OR s.project_path=?)
		 AND (?=1 OR NOT EXISTS(SELECT 1 FROM turns t WHERE t.session_id=m.session_id AND t.id=m.turn_id AND t.rolled_back=1))
		 ORDER BY relevance, m.timestamp DESC, m.source_order LIMIT ?`,
			query,
			options.project ?? null,
			options.project ?? null,
			options.include_rolled_back ? 1 : 0,
			options.limit ?? 20,
		);
	}
	recall(
		term: string,
		options: {
			project?: string;
			limit?: number;
			context?: number;
		} = {},
	) {
		const context = options.context ?? 2;
		return {
			term,
			matches: this.search(term, {
				...options,
				limit: options.limit ?? 5,
			}).map((match) => {
				const fetch = (before: boolean) =>
					this.all(
						`SELECT m.id,m.type,m.content_text,m.timestamp,m.source_order FROM messages m
			 WHERE session_id=? AND source_order ${before ? '<' : '>'} ?
			 AND NOT EXISTS(SELECT 1 FROM turns t WHERE t.session_id=m.session_id AND t.id=m.turn_id AND t.rolled_back=1)
			 ORDER BY source_order ${before ? 'DESC' : 'ASC'} LIMIT ?`,
						match.session_id,
						match.source_order,
						context,
					).map((row) => ({
						...row,
						content_text: String(row.content_text ?? '').slice(
							0,
							4000,
						),
					}));
				return {
					...match,
					content_text: String(match.content_text ?? '').slice(
						0,
						4000,
					),
					before: fetch(true).reverse(),
					after: fetch(false),
				};
			}),
		};
	}
	tools(kind = 'operation', limit = 20) {
		return this.all(
			`SELECT tool_name,kind,COUNT(*) AS count FROM tool_calls WHERE kind=? GROUP BY tool_name,kind ORDER BY count DESC,tool_name LIMIT ?`,
			kind,
			limit,
		);
	}
	compact(days: number, dry_run: boolean) {
		const cutoff = Date.now() - days * 86_400_000;
		const eligible = Number(
			this.get(
				'SELECT COUNT(*) AS n FROM tool_results WHERE timestamp < ? AND compacted=0 AND length(content)>200',
				cutoff,
			)?.n,
		);
		if (!dry_run)
			this.transaction(() => {
				this.run(
					"UPDATE tool_results SET content='[compacted tool output]',compacted=1 WHERE timestamp < ? AND compacted=0 AND length(content)>200",
					cutoff,
				);
			});
		return { dry_run, older_than_days: days, tool_results: eligible };
	}
}
