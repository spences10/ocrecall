import { defineCommand } from 'citty';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
		description: 'Maximum results (default: 20)',
	},
	project: {
		type: 'string',
		alias: 'p',
		description: 'Filter by exact project path',
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
function output(value: unknown, json: boolean | undefined) {
	if (json || !Array.isArray(value))
		console.log(JSON.stringify(value, null, 2));
	else console.table(value);
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
			output(result, args.json);
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
			output({ db_path: db.path, ...db.stats() }, args.json);
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
			output(
				db.sessions({
					project: args.project ? resolve(args.project) : undefined,
					limit: integer(args.limit, 20, 'limit', 1),
					offset: integer(
						args.offset,
						0,
						'offset',
						0,
						Number.MAX_SAFE_INTEGER,
					),
					state: args.state,
				}),
				args.json,
			);
		} finally {
			db.close();
		}
	},
});
export const search = defineCommand({
	meta: {
		name: 'search',
		description:
			'Full-text phrase search across completed conversation items',
	},
	args: {
		...list_args,
		term: {
			type: 'positional',
			required: true,
			description: 'Search phrase',
		},
		'include-rolled-back': {
			type: 'boolean',
			description: 'Include abandoned turns',
		},
	},
	run({ args }) {
		const db = open_database(args);
		try {
			output(
				db.search(args.term, {
					project: args.project ? resolve(args.project) : undefined,
					limit: integer(args.limit, 20, 'limit', 1),
					include_rolled_back: args['include-rolled-back'],
				}),
				args.json,
			);
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
		term: {
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
				db.recall(args.term, {
					project: args.project ? resolve(args.project) : undefined,
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
			'Count completed operations or model tool invocations separately',
	},
	args: {
		...shared_args,
		limit: { type: 'string', alias: 'l' },
		kind: {
			type: 'string',
			description: 'operation (default) or invocation',
		},
	},
	run({ args }) {
		const kind = args.kind ?? 'operation';
		if (!['operation', 'invocation'].includes(kind))
			throw new Error('kind must be operation or invocation');
		const db = open_database(args);
		try {
			output(
				db.tools(kind, integer(args.limit, 20, 'limit', 1)),
				args.json,
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
	},
	run({ args }) {
		const db = new DatabaseSync(path_for(args), { readOnly: true });
		try {
			db.exec('PRAGMA query_only=ON');
			output(db.prepare(args.sql).all(), args.json);
		} finally {
			db.close();
		}
	},
});
export const schema = defineCommand({
	meta: {
		name: 'schema',
		description: 'Show SQLite tables and schema',
	},
	args: shared_args,
	run({ args }) {
		const db = open_database(args);
		try {
			output(
				db.all(
					"SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'messages_fts_%' ORDER BY name",
				),
				args.json,
			);
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
			output(
				db.compact(
					integer(args['older-than'], 30, 'older-than', 0, 365000),
					args['dry-run'] ?? false,
				),
				args.json,
			);
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
