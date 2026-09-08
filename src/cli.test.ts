import { execFileSync, spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
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
