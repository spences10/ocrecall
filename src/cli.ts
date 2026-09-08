import { defineCommand } from 'citty';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Database } from './db.ts';
import { codex_home, database_path } from './sources.ts';

const { version } = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
const shared_args = {
	db: {
		type: 'string',
		alias: 'd',
		description: 'Database path (default: <Codex home>/ocrecall.db)',
	},
	'codex-home': {
		type: 'string',
		description: 'Codex home (default: CODEX_HOME or ~/.codex)',
	},
	json: { type: 'boolean', description: 'Output JSON' },
} as const;
const list_args = {
	...shared_args,
	limit: {
		type: 'string',
		alias: 'l',
		description:
			'Maximum results (search: 20, sessions: 10, recall: 5)',
	},
	project: {
		type: 'string',
		alias: 'p',
		description: 'Filter by project path or partial name',
	},
} as const;
function integer(
	value: string | undefined,
	fallback: number,
	name: string,
	min = 0,
	max = 1000,
) {
	const n = value === undefined ? fallback : Number(value);
	if (!Number.isSafeInteger(n) || n < min || n > max)
		throw new Error(
			`${name} must be an integer between ${min} and ${max}`,
		);
	return n;
}
function path_for(args: { db?: string; 'codex-home'?: string }) {
	return database_path(codex_home(args['codex-home']), args.db);
}
function open_database(args: { db?: string; 'codex-home'?: string }) {
	const path = path_for(args);
	if (!existsSync(path))
		throw new Error('Archive not found. Run ocrecall sync first.');
	return new Database(path);
}
function json_text(value: unknown): string {
	return JSON.stringify(
		value,
		(_key, item: unknown) =>
			typeof item === 'bigint' ? item.toString() : item,
		2,
	);
}
function cell(value: unknown): string {
	if (value === null || value === undefined) return '';
	return typeof value === 'object'
		? JSON.stringify(value)
		: String(value as string | number | bigint | boolean);
}
function print_rows(
	rows: Record<string, unknown>[],
	format = 'table',
	wide = false,
	columns = Object.keys(rows[0] ?? {}),
) {
	if (format === 'json') {
		console.log(json_text(rows));
		return;
	}
	if (format === 'csv') {
		const escape = (value: unknown) => {
			const text = cell(value);
			return /[",\r\n]/.test(text)
				? '"' + text.replaceAll('"', '""') + '"'
				: text;
		};
		if (columns.length) console.log(columns.map(escape).join(','));
		for (const row of rows)
			console.log(
				columns.map((column) => escape(row[column])).join(','),
			);
		return;
	}
	if (!rows.length) {
		console.log('No results.');
		return;
	}
	const max_width = wide
		? Infinity
		: Math.max(
				20,
				Math.floor(
					(process.stdout.columns || 120) /
						Math.max(columns.length, 1),
				),
			);
	const display = (value: unknown) =>
		cell(value).replaceAll('\n', '\\n').replaceAll('\r', '\\r');
	const widths = columns.map((column) =>
		Math.min(
			max_width,
			rows.reduce(
				(width, row) => Math.max(width, display(row[column]).length),
				column.length,
			),
		),
	);
	const line = (values: string[]) =>
		values
			.map((value, i) =>
				(value.length > widths[i]
					? value.slice(0, Math.max(0, widths[i] - 1)) + '…'
					: value
				).padEnd(widths[i]),
			)
			.join(' | ');
	console.log(line(columns));
	console.log(widths.map((width) => '-'.repeat(width)).join('-+-'));
	for (const row of rows)
		console.log(line(columns.map((column) => display(row[column]))));
	console.log(`\n${rows.length} row(s)`);
}
function output(value: unknown, json: boolean | undefined) {
	if (json) console.log(json_text(value));
	else if (Array.isArray(value))
		print_rows(value as Record<string, unknown>[]);
	else
		print_rows(
			Object.entries(value as Record<string, unknown>).map(
				([name, item]) => ({ name, value: cell(item) }),
			),
		);
}
function search_term(value: string | string[]) {
	return Array.isArray(value) ? value.join(' ') : value;
}
function after_date(value?: string) {
	if (value === undefined) return undefined;
	const ms = Date.parse(value);
	if (
		!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) ||
		!Number.isFinite(ms) ||
		(value.length === 10 &&
			new Date(ms).toISOString().slice(0, 10) !== value)
	)
		throw new Error('--after must be a valid ISO date');
	return ms;
}
function print_search(results: Record<string, unknown>[]) {
	if (!results.length) {
		console.log('No matches found.');
		return;
	}
	const grouped = new Map<string, Record<string, unknown>[]>();
	for (const row of results) {
		const id = String(row.session_id);
		const group = grouped.get(id) ?? [];
		group.push(row);
		grouped.set(id, group);
	}
	console.log(
		`Found ${results.length} matches across ${grouped.size} session(s):\n`,
	);
	for (const [session, rows] of grouped) {
		console.log(
			`--- ${session.slice(0, 8)} | ${cell(rows[0].project_path)} ---`,
		);
		for (const row of rows) {
			const context = row.context as
				| {
						before: Array<Record<string, unknown>>;
						after: Array<Record<string, unknown>>;
				  }
				| undefined;
			const surrounding = (items: Array<Record<string, unknown>>) => {
				for (const item of items)
					console.log(
						`    [${cell(item.type)}] ${String(item.content_text).replaceAll('\n', ' ').slice(0, 200)}`,
					);
			};
			if (context) surrounding(context.before);
			console.log(
				`  [${Number(row.relevance).toFixed(2)}] ${String(row.snippet).replaceAll('\n', ' ')}`,
			);
			if (context) surrounding(context.after);
		}
		console.log();
	}
}

export const sync = defineCommand({
	meta: {
		name: 'sync',
		description: 'Incrementally import paginated Codex sessions',
	},
	args: {
		...shared_args,
		'sqlite-home': {
			type: 'string',
			description: 'Optional Codex state database directory',
		},
		verbose: {
			type: 'boolean',
			alias: 'v',
			description: 'Report sync errors on stderr',
		},
	},
	async run({ args }) {
		const { sync: sync_sessions } = await import('./sync.ts');
		const db = new Database(path_for(args));
		try {
			const result = await sync_sessions(
				db,
				codex_home(args['codex-home']),
				args['sqlite-home'],
			);
			if (args.json) output(result, true);
			else {
				console.log('Session sync complete');
				print_rows(
					Object.entries(result)
						.filter(([, value]) => typeof value === 'number')
						.map(([metric, value]) => ({ metric, value })),
				);
				for (const warning of result.warnings) console.error(warning);
				if (Object.keys(result.unsupported_records).length)
					console.error(
						'Unsupported records:',
						json_text(result.unsupported_records),
					);
				for (const error of result.errors)
					console.error(`${error.path}: ${error.message}`);
			}
			if (args.verbose)
				for (const error of result.errors)
					console.error(`${error.path}: ${error.message}`);
			if (result.errors.length) process.exitCode = 1;
		} finally {
			db.close();
		}
	},
});
export const stats = defineCommand({
	meta: {
		name: 'stats',
		description: 'Session counts and deduplicated token usage',
	},
	args: shared_args,
	run({ args }) {
		const db = open_database(args);
		try {
			const result = db.stats();
			if (args.json) output({ db_path: db.path, ...result }, true);
			else {
				console.log(`Database: ${db.path}`);
				print_rows(
					Object.entries(result)
						.filter(([, value]) => typeof value === 'number')
						.map(([metric, value]) => ({ metric, value })),
				);
				console.log(
					'\nToken usage (cached input and reasoning output are subsets):',
				);
				print_rows(
					Object.entries(result.tokens ?? {}).map(
						([metric, value]) => ({
							metric,
							value: value ?? 'unavailable',
						}),
					),
				);
				console.log('\nCost: unavailable');
				console.log(
					`Usage coverage: ${Number(result.usage_coverage?.turns_with_usage ?? 0)}/${Number(result.usage_coverage?.turns ?? 0)} turns`,
				);
				print_rows(result.tool_counts);
			}
		} finally {
			db.close();
		}
	},
});
export const sessions = defineCommand({
	meta: {
		name: 'sessions',
		description: 'List recent sessions, including archived history',
	},
	args: {
		...list_args,
		offset: { type: 'string', description: 'Pagination offset' },
		state: {
			type: 'string',
			description: 'Filter: active, archived, or missing',
		},
	},
	run({ args }) {
		if (
			args.state &&
			!['active', 'archived', 'missing'].includes(args.state)
		)
			throw new Error('Invalid state');
		const db = open_database(args);
		try {
			const results = db
				.sessions({
					project: args.project,
					limit: integer(args.limit, 10, 'limit', 1),
					offset: integer(
						args.offset,
						0,
						'offset',
						0,
						Number.MAX_SAFE_INTEGER,
					),
					state: args.state,
				})
				.map((row) => ({
					...row,
					id: row.id,
					project_path: row.project_path,
					message_count: row.message_count,
					total_tokens: row.total_tokens,
					duration_mins: row.duration_mins,
					source_state: row.source_state,
					first_date: new Date(
						Number(row.first_timestamp),
					).toISOString(),
					last_date: new Date(
						Number(row.last_timestamp),
					).toISOString(),
				}));
			if (args.json) output(results, true);
			else
				print_rows(
					results.map((row) => ({
						id: row.id,
						date: row.first_date.slice(0, 10),
						project: row.project_path,
						messages: row.message_count,
						tokens: row.total_tokens ?? 'unavailable',
						cost: 'unavailable',
						duration: `${Number(row.duration_mins).toFixed(1)}m`,
						state: row.source_state,
					})),
				);
		} finally {
			db.close();
		}
	},
});
export const search = defineCommand({
	meta: {
		name: 'search',
		description: 'Full-text search (AND, OR, NOT, "phrase", prefix*)',
	},
	args: {
		...list_args,
		_: {
			type: 'positional',
			required: true,
			description: 'Search expression',
		},
		context: {
			type: 'string',
			alias: 'c',
			description:
				'Readable items before/after each match (default: 0)',
		},
		rebuild: {
			type: 'boolean',
			description: 'Rebuild the FTS index before searching',
		},
		session: {
			type: 'string',
			description: 'Filter by session ID prefix',
		},
		after: {
			type: 'string',
			alias: 'a',
			description: 'Only results on or after an ISO date',
		},
		sort: {
			type: 'string',
			alias: 's',
			description: 'relevance (default), time, or time-asc',
		},
		'include-rolled-back': {
			type: 'boolean',
			description: 'Include abandoned turns',
		},
	},
	run({ args }) {
		const sort = args.sort ?? 'relevance';
		if (
			sort !== 'relevance' &&
			sort !== 'time' &&
			sort !== 'time-asc'
		)
			throw new Error('--sort must be relevance, time, or time-asc');
		const after = after_date(args.after);
		const count = integer(args.context, 0, 'context', 0, 20);
		const limit = integer(args.limit, 20, 'limit', 1);
		const db = open_database(args);
		try {
			if (args.rebuild) db.rebuild_fts();
			const results = db
				.search(search_term(args._), {
					project: args.project,
					limit,
					session: args.session,
					after,
					sort,
					include_rolled_back: args['include-rolled-back'],
				})
				.map((row) => ({
					...row,
					date: new Date(Number(row.timestamp)).toISOString(),
					...(count > 0
						? {
								context: db.get_context_around(
									String(row.session_id),
									Number(row.source_order),
									count,
									args['include-rolled-back'],
								),
							}
						: {}),
				}));
			if (args.json) output(results, true);
			else print_search(results);
		} finally {
			db.close();
		}
	},
});
export const recall = defineCommand({
	meta: {
		name: 'recall',
		description: 'Retrieve bounded context for an LLM (always JSON)',
	},
	args: {
		...list_args,
		_: {
			type: 'positional',
			required: true,
			description: 'Search phrase',
		},
		context: {
			type: 'string',
			alias: 'c',
			description: 'Items before/after each match (default: 2)',
		},
	},
	run({ args }) {
		const db = open_database(args);
		try {
			output(
				db.recall(search_term(args._), {
					project: args.project,
					limit: integer(args.limit, 5, 'limit', 1, 50),
					context: integer(args.context, 2, 'context', 0, 20),
				}),
				true,
			);
		} finally {
			db.close();
		}
	},
});
export const tools = defineCommand({
	meta: {
		name: 'tools',
		description:
			'Tool usage by completed operation or model invocation',
	},
	args: {
		...shared_args,
		top: {
			type: 'string',
			alias: 't',
			description: 'Number of tools (default: 10)',
		},
		limit: {
			type: 'string',
			alias: 'l',
			description: 'Alias for --top',
		},
		project: {
			type: 'string',
			alias: 'p',
			description: 'Filter by project path or partial name',
		},
		kind: {
			type: 'string',
			description: 'operation (default) or invocation',
		},
	},
	run({ args }) {
		const kind = args.kind ?? 'operation';
		if (!['operation', 'invocation'].includes(kind))
			throw new Error('kind must be operation or invocation');
		const limit = integer(args.top ?? args.limit, 10, 'top', 1);
		if (
			args.top &&
			args.limit &&
			Number(args.top) !== Number(args.limit)
		)
			throw new Error(
				'Use either --top or --limit, or specify equal values',
			);
		const db = open_database(args);
		try {
			const results = db.tools(kind, limit, args.project);
			if (args.json) output(results, true);
			else
				print_rows(
					results.map((row) => ({
						...row,
						percentage: Number(row.percentage).toFixed(1) + '%',
					})),
				);
		} finally {
			db.close();
		}
	},
});
export const query = defineCommand({
	meta: {
		name: 'query',
		description: 'Run read-only SQL against the archive',
	},
	args: {
		...shared_args,
		sql: {
			type: 'positional',
			required: true,
			description: 'SQL query',
		},
		format: {
			type: 'string',
			alias: 'f',
			description: 'table (default), json, or csv',
		},
		limit: {
			type: 'string',
			alias: 'l',
			description:
				'Maximum rows returned, including queries with LIMIT',
		},
		wide: {
			type: 'boolean',
			alias: 'w',
			description: 'Do not truncate table columns',
		},
	},
	run({ args }) {
		const format = args.json ? 'json' : (args.format ?? 'table');
		if (!['table', 'json', 'csv'].includes(format))
			throw new Error('--format must be table, json, or csv');
		const limit =
			args.limit === undefined
				? undefined
				: integer(args.limit, 0, 'limit', 0, Number.MAX_SAFE_INTEGER);
		const db = new DatabaseSync(path_for(args), { readOnly: true });
		try {
			db.exec('PRAGMA query_only=ON');
			const statement = db.prepare(args.sql);
			const rows: Record<string, unknown>[] = [];
			if (limit !== 0)
				for (const row of statement.iterate()) {
					rows.push(row);
					if (limit !== undefined && rows.length >= limit) break;
				}
			print_rows(
				rows,
				format,
				args.wide,
				statement.columns().map((column) => column.name),
			);
		} finally {
			db.close();
		}
	},
});
export const schema = defineCommand({
	meta: {
		name: 'schema',
		description: 'Inspect tables, columns, indexes, and foreign keys',
	},
	args: {
		...shared_args,
		table: {
			type: 'positional',
			required: false,
			description: 'Optional table name',
		},
	},
	run({ args }) {
		const db = open_database(args);
		try {
			const { tables } = db.get_schema(args.table);
			if (args.json) output(tables, true);
			else if (!tables.length)
				console.log(
					args.table
						? `Table not found: ${args.table}`
						: 'No tables found.',
				);
			else if (!args.table)
				print_rows(
					tables.map((table) => ({
						table: table.name,
						type: table.type,
						rows: table.row_count,
					})),
				);
			else {
				const table = tables[0];
				console.log(`Table: ${table.name} (${table.row_count} rows)`);
				print_rows(
					table.columns.map((column) => ({
						column: column.name,
						type: column.type,
						nullable: column.notnull ? 'NO' : 'YES',
						pk: column.pk ? '*' : '',
						default: column.default_value,
					})),
				);
				if (table.foreign_keys.length) {
					console.log('\nForeign keys:');
					print_rows(table.foreign_keys);
				}
				if (table.indexes.length) {
					console.log('\nIndexes:');
					print_rows(table.indexes);
				}
			}
		} finally {
			db.close();
		}
	},
});
export const compact = defineCommand({
	meta: {
		name: 'compact',
		description:
			'Prune old archived tool output without changing Codex files',
	},
	args: {
		...shared_args,
		'older-than': {
			type: 'string',
			description: 'Age in days (default: 30)',
		},
		'dry-run': {
			type: 'boolean',
			description: 'Preview without modifying output',
		},
	},
	run({ args }) {
		const db = open_database(args);
		try {
			const result = db.compact(
				integer(args['older-than'], 30, 'older-than', 0, 365000),
				args['dry-run'] ?? false,
			);
			if (args.json) output(result, true);
			else {
				console.log(
					`${result.dry_run ? '[DRY RUN] ' : ''}Tool output compaction (before ${result.cutoff_date})`,
				);
				print_rows(result.tool_results_compacted);
				console.log(`Tool results: ${result.tool_results}`);
				console.log(
					`Database + WAL: ${result.bytes_before.toLocaleString()} → ${result.bytes_after.toLocaleString()} bytes`,
				);
			}
		} finally {
			db.close();
		}
	},
});
export const resumable = defineCommand({
	meta: {
		name: 'resumable',
		description:
			'List live resume candidates (client support is unverified)',
	},
	args: {
		...shared_args,
		cwd: { type: 'string' },
		scope: { type: 'string', description: 'project or all' },
		query: { type: 'string', alias: 'q' },
		limit: { type: 'string', alias: 'l' },
		offset: { type: 'string' },
	},
	async run({ args }) {
		const { list_resumable_sessions } =
			await import('./resumable.ts');
		const scope = args.scope ?? (args.cwd ? 'project' : 'all');
		if (scope !== 'project' && scope !== 'all')
			throw new Error('scope must be project or all');
		output(
			await list_resumable_sessions({
				db_path: args.db,
				codex_home: args['codex-home'],
				cwd: args.cwd,
				scope,
				query: args.query,
				limit: integer(args.limit, 100, 'limit', 1),
				offset: integer(
					args.offset,
					0,
					'offset',
					0,
					Number.MAX_SAFE_INTEGER,
				),
			}),
			true,
		);
	},
});
export const main = defineCommand({
	meta: {
		name: 'ocrecall',
		version,
		description: 'Sync and recall paginated OpenAI Codex sessions',
	},
	args: shared_args,
	subCommands: {
		sync,
		stats,
		sessions,
		search,
		tools,
		recall,
		query,
		schema,
		compact,
		resumable,
	},
});
