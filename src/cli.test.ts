import { execFileSync, spawnSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { fixture } from './fixtures.ts';

let home: string;
const cli = fileURLToPath(new URL('./index.ts', import.meta.url));
function run(...args: string[]) {
	return execFileSync(
		process.execPath,
		[cli, ...args, '--codex-home', home, '--json'],
		{ encoding: 'utf8' },
	);
}
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'ocrecall-cli-'));
	mkdirSync(join(home, 'sessions'));
	writeFileSync(join(home, 'sessions', 'test.jsonl'), fixture());
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
test('sync emits one JSON object and every query command works', () => {
	expect(JSON.parse(run('sync')).messages_added).toBe(2);
	expect(JSON.parse(run('sync')).records_added).toBe(0);
	expect(JSON.parse(run('stats')).tokens.total).toBe(120);
	expect(JSON.parse(run('sessions'))).toHaveLength(1);
	expect(JSON.parse(run('search', 'café'))).toHaveLength(1);
	expect(JSON.parse(run('recall', 'café')).matches).toHaveLength(1);
	expect(JSON.parse(run('tools'))[0].tool_name).toBe('command');
	expect(
		JSON.parse(run('query', 'SELECT COUNT(*) AS n FROM messages'))[0]
			.n,
	).toBe(2);
	expect(
		JSON.parse(run('schema')).some(
			(row: { name: string }) => row.name === 'usage_records',
		),
	).toBe(true);
	expect(JSON.parse(run('resumable')).sessions).toHaveLength(1);
	expect(JSON.parse(run('compact', '--dry-run')).dry_run).toBe(true);
});
test('rejects invalid pagination and SQL writes', () => {
	run('sync');
	for (const args of [
		['sessions', '--limit', '3junk'],
		['resumable', '--scope', 'project'],
		['query', 'DELETE FROM messages'],
	]) {
		const result = spawnSync(
			process.execPath,
			[cli, ...args, '--codex-home', home],
			{ encoding: 'utf8' },
		);
		expect(result.status).not.toBe(0);
	}
	expect(JSON.parse(run('stats')).messages).toBe(2);
});
test('help exposes the command set', () => {
	const help = execFileSync(process.execPath, [cli, '--help'], {
		encoding: 'utf8',
	});
	for (const command of ['sync', 'recall', 'resumable', 'stats'])
		expect(help).toContain(command);
});

test('search options support expressions, filters, context, rebuild and unquoted terms', () => {
	run('sync');
	const results = JSON.parse(
		run(
			'search',
			'café',
			'OR',
			'missing',
			'--project',
			'projec',
			'--session',
			'session-',
			'--after',
			'2026-09-01',
			'--sort',
			'time-asc',
			'--context',
			'1',
			'--rebuild',
		),
	);
	expect(results).toHaveLength(1);
	expect(results[0].context.after[0].content_text).toBe(
		'Found the migrations.',
	);
	expect(
		JSON.parse(run('search', 'migrat*', '--after', '2026-09-02')),
	).toHaveLength(0);
	expect(
		JSON.parse(run('tools', '--project', 'missing', '--top', '1')),
	).toEqual([]);
	expect(
		JSON.parse(run('tools', '--project', 'project', '-t', '1'))[0]
			.percentage,
	).toBe(100);
	const table = JSON.parse(run('schema', 'messages'))[0];
	expect(table.columns.length).toBeGreaterThan(0);
	expect(table.foreign_keys).toHaveLength(1);
});

test('query supports CSV, JSON format, safe row caps and wide output', () => {
	run('sync');
	const raw = (...args: string[]) =>
		execFileSync(
			process.execPath,
			[cli, ...args, '--codex-home', home],
			{ encoding: 'utf8' },
		);
	const csv = raw(
		'query',
		`SELECT 'a,"b"' AS "column,one", char(10) AS newline, NULL AS blank`,
		'--format',
		'csv',
	);
	expect(csv).toBe('"column,one",newline,blank\n"a,""b""","\n",\n');
	expect(
		JSON.parse(
			raw('query', 'SELECT * FROM messages', '-f', 'json', '-l', '1'),
		),
	).toHaveLength(1);
	expect(
		JSON.parse(
			run(
				'query',
				"SELECT 'LIMIT inside text' AS text FROM messages LIMIT 2;",
				'--limit',
				'1',
			),
		),
	).toHaveLength(1);
	expect(
		JSON.parse(
			run('query', 'SELECT * FROM messages', '--limit', '0'),
		),
	).toEqual([]);
	expect(
		raw('query', "SELECT 'x' AS name WHERE 0", '--format', 'csv'),
	).toBe('name\n');
	const long = 'x'.repeat(200);
	expect(raw('query', `SELECT '${long}' AS text`)).not.toContain(
		long,
	);
	expect(
		raw('query', `SELECT '${long}' AS text`, '--wide'),
	).toContain(long);
});

test('rejects invalid search filters and query formats', () => {
	run('sync');
	for (const args of [
		['search', 'migration', '--sort', 'oops'],
		['search', 'migration', '--after', '2026-02-31'],
		['search', 'migration', '--after', 'yesterday'],
		['search', 'migration', '--context', '-1'],
		['query', 'SELECT 1', '--format', 'yaml'],
		['query', 'SELECT 1', '--limit', '2oops'],
	]) {
		const result = spawnSync(
			process.execPath,
			[cli, ...args, '--codex-home', home],
			{ encoding: 'utf8' },
		);
		expect(result.status).not.toBe(0);
	}
});

test('human output shows summaries, context and tool/schema details', () => {
	const raw = (...args: string[]) =>
		execFileSync(
			process.execPath,
			[cli, ...args, '--codex-home', home],
			{ encoding: 'utf8' },
		);
	expect(raw('sync')).toContain('Session sync complete');
	expect(raw('stats')).toContain('Cost: unavailable');
	expect(raw('sessions')).toContain('duration');
	expect(raw('tools', '--top', '1')).toContain('100.0%');
	expect(raw('search', 'café', '--context', '1')).toContain(
		'Found the migrations.',
	);
	expect(raw('schema', 'messages')).toContain('Foreign keys:');
	expect(raw('compact', '--dry-run')).toContain('[DRY RUN]');
	const session = JSON.parse(run('sessions'))[0];
	expect(session.total_tokens).toBe(120);
	expect(session.total_cost).toBeNull();
	expect(session.first_date).toBe('2026-09-01T10:00:00.000Z');
	const recalled = JSON.parse(run('recall', 'café'));
	expect(recalled.total).toBe(1);
	expect(recalled.matches[0].match.content_text).toContain('café');
});
