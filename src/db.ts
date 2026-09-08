import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { apply_schema } from './schema.ts';

// Match pirecall's FTS syntax while quoting punctuation in ordinary terms.
function escape_fts5_query(term: string): string {
	// Preserve explicit expressions, including phrases combined with operators.
	if (term.includes('"') || /\b(?:AND|OR|NOT|NEAR)\b/.test(term))
		return term;
	const prefix = term.endsWith('*');
	const base = prefix ? term.slice(0, -1) : term;
	if (!/[./\-:()^+']/.test(base) && !base.includes('"')) return term;
	return '"' + base.replaceAll('"', '""') + '"' + (prefix ? '*' : '');
}
export interface SearchOptions {
	project?: string;
	limit?: number;
	session?: string;
	after?: number;
	sort?: 'relevance' | 'time' | 'time-asc';
	include_rolled_back?: boolean;
}

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
			tool_calls: count('tool_calls'),
			tool_results: count('tool_results'),
			model_changes: count('model_changes'),
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
		 (SELECT SUM(u.total_tokens) FROM usage_records u WHERE u.session_id=s.id AND u.inherited=0) AS total_tokens,
		 NULL AS total_cost, (s.last_timestamp-s.first_timestamp)/60000.0 AS duration_mins,
		 COALESCE((SELECT state FROM session_sources src WHERE src.session_id=s.id ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'archived' THEN 1 ELSE 2 END LIMIT 1),'missing') AS source_state
		 FROM sessions s WHERE (? IS NULL OR instr(lower(COALESCE(s.project_path,'')),lower(?))>0) AND (? IS NULL OR EXISTS(SELECT 1 FROM session_sources src WHERE src.session_id=s.id AND src.state=?))
		 ORDER BY s.last_timestamp DESC, s.id LIMIT ? OFFSET ?`,
			options.project ?? null,
			options.project ?? null,
			options.state ?? null,
			options.state ?? null,
			options.limit ?? 10,
			options.offset ?? 0,
		);
	}
	rebuild_fts() {
		this.transaction(() => {
			this.db.exec(
				"INSERT INTO messages_fts(messages_fts) VALUES('rebuild')",
			);
		});
	}
	search(term: string, options: SearchOptions = {}) {
		if (!term.trim()) return [];
		const sort = options.sort ?? 'relevance';
		if (!['relevance', 'time', 'time-asc'].includes(sort))
			throw new Error('sort must be relevance, time, or time-asc');
		if (
			options.after !== undefined &&
			!Number.isFinite(options.after)
		)
			throw new Error('Invalid after date');
		const order =
			sort === 'time'
				? 'm.timestamp DESC, m.session_id, m.source_order DESC'
				: sort === 'time-asc'
					? 'm.timestamp ASC, m.session_id, m.source_order ASC'
					: 'relevance, m.timestamp DESC, m.session_id, m.source_order';
		return this.all(
			`SELECT m.*, s.project_path, s.name, bm25(messages_fts) AS relevance,
   snippet(messages_fts,0,'>>>','<<<','…',32) AS snippet
   FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid JOIN sessions s ON s.id=m.session_id
   WHERE messages_fts MATCH ? AND (? IS NULL OR instr(lower(COALESCE(s.project_path,'')),lower(?))>0)
   AND (? IS NULL OR substr(m.session_id,1,length(?))=?)
   AND (? IS NULL OR m.timestamp>=?)
   AND (?=1 OR NOT EXISTS(SELECT 1 FROM turns t WHERE t.session_id=m.session_id AND t.id=m.turn_id AND t.rolled_back=1))
   ORDER BY ${order} LIMIT ?`,
			escape_fts5_query(term),
			options.project ?? null,
			options.project ?? null,
			options.session ?? null,
			options.session ?? null,
			options.session ?? null,
			options.after ?? null,
			options.after ?? null,
			options.include_rolled_back ? 1 : 0,
			options.limit ?? 20,
		);
	}
	get_context_around(
		session_id: string,
		source_order: number,
		count: number,
		include_rolled_back = false,
	) {
		const fetch = (before: boolean) =>
			this.all(
				`SELECT m.id,m.type,m.content_text,m.timestamp,m.source_order FROM messages m
   WHERE session_id=? AND source_order ${before ? '<' : '>'} ?
   AND length(trim(COALESCE(m.content_text,''), char(9,10,11,12,13,32))) > 0
   AND (?=1 OR NOT EXISTS(SELECT 1 FROM turns t WHERE t.session_id=m.session_id AND t.id=m.turn_id AND t.rolled_back=1))
   ORDER BY source_order ${before ? 'DESC' : 'ASC'},m.id LIMIT ?`,
				session_id,
				source_order,
				include_rolled_back ? 1 : 0,
				count,
			).map((row) => ({
				...row,
				content_text: String(row.content_text ?? '').slice(0, 4000),
				date: new Date(Number(row.timestamp)).toISOString(),
			}));
		return { before: fetch(true).reverse(), after: fetch(false) };
	}

	recall(
		term: string,
		options: {
			project?: string;
			limit?: number;
			context?: number;
		} = {},
	) {
		const matches = this.search(term, {
			...options,
			limit: options.limit ?? 5,
		}).map((match) => ({
			...match,
			content_text: String(match.content_text ?? '').slice(0, 4000),
			date: new Date(Number(match.timestamp)).toISOString(),
			match: {
				id: match.id,
				content_text: String(match.content_text ?? '').slice(0, 4000),
				timestamp: match.timestamp,
			},
			...this.get_context_around(
				String(match.session_id),
				Number(match.source_order),
				options.context ?? 2,
			),
		}));
		return { term, total: matches.length, matches };
	}

	tools(kind = 'operation', limit = 10, project?: string) {
		return this.all(
			`WITH counts AS (
   SELECT tc.tool_name,tc.kind,COUNT(*) AS count FROM tool_calls tc JOIN sessions s ON s.id=tc.session_id
   WHERE tc.kind=? AND (? IS NULL OR instr(lower(COALESCE(s.project_path,'')),lower(?))>0)
   GROUP BY tc.tool_name,tc.kind
  ) SELECT *, 100.0*count/SUM(count) OVER () AS percentage FROM counts ORDER BY count DESC,tool_name LIMIT ?`,
			kind,
			project ?? null,
			project ?? null,
			limit,
		);
	}
	get_schema(table_name?: string) {
		const quote = (name: string) =>
			'"' + name.replaceAll('"', '""') + '"';
		const rows = this.all(
			"SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' AND (? IS NULL OR name=?) ORDER BY name",
			table_name ?? null,
			table_name ?? null,
		);
		return {
			tables: rows.map((row) => {
				const name = String(row.name);
				const columns = this.all(
					`PRAGMA table_info(${quote(name)})`,
				).map((column) => ({
					name: column.name,
					type: column.type,
					notnull: column.notnull === 1,
					default_value: column.dflt_value,
					pk: Number(column.pk) > 0,
				}));
				const indexes = this.all(
					`PRAGMA index_list(${quote(name)})`,
				).map((index) => ({
					name: index.name,
					sql:
						this.get(
							'SELECT sql FROM sqlite_master WHERE name=?',
							index.name,
						)?.sql ?? '',
				}));
				const foreign_keys = this.all(
					`PRAGMA foreign_key_list(${quote(name)})`,
				).map((key) => ({
					from: key.from,
					table: key.table,
					to: key.to,
				}));
				return {
					...row,
					name,
					type: String(row.type),
					sql: row.sql,
					row_count: Number(
						this.get(`SELECT COUNT(*) AS n FROM ${quote(name)}`)?.n,
					),
					columns,
					indexes,
					foreign_keys,
				};
			}),
		};
	}
	compact(days: number, dry_run: boolean) {
		const cutoff = Date.now() - days * 86_400_000;
		const disk_bytes = () =>
			[this.path, this.path + '-wal'].reduce(
				(sum, path) =>
					sum + (existsSync(path) ? statSync(path).size : 0),
				0,
			);
		const bytes_before = disk_bytes();
		const groups = this.all(
			`SELECT COALESCE(tc.kind,'unknown') AS kind,COALESCE(tc.tool_name,'unknown') AS tool_name,COUNT(*) AS count,
   SUM(length(CAST(tr.content AS BLOB))) AS output_bytes
   FROM tool_results tr LEFT JOIN tool_calls tc ON tc.session_id=tr.session_id AND tc.id=tr.tool_call_id
   WHERE tr.timestamp<? AND tr.compacted=0 AND length(tr.content)>200 GROUP BY tc.kind,tc.tool_name`,
			cutoff,
		);
		const eligible = groups.reduce(
			(sum, row) => sum + Number(row.count),
			0,
		);
		if (!dry_run && eligible) {
			this.transaction(() => {
				this.run(
					"UPDATE tool_results SET content='[compacted tool output]',compacted=1 WHERE timestamp<? AND compacted=0 AND length(content)>200",
					cutoff,
				);
			});
			this.db.exec('VACUUM');
			this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		}
		return {
			dry_run,
			older_than_days: days,
			cutoff_date: new Date(cutoff).toISOString().split('T')[0],
			tool_results: eligible,
			tool_results_compacted: groups,
			bytes_before,
			bytes_after: disk_bytes(),
		};
	}
}
