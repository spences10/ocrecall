import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Database } from './db.ts';
import { entry, fixture, item } from './fixtures.ts';
import { list_resumable_sessions } from './resumable.ts';
import { sync } from './sync.ts';

let home: string;
let path: string;
let db: Database;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'ocrecall-test-'));
	mkdirSync(join(home, 'sessions'));
	mkdirSync(join(home, 'archived_sessions'));
	path = join(home, 'sessions', 'test.jsonl');
	db = new Database(join(home, 'archive.db'));
});
afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
});
test('imports completed messages once and counts structured response usage once', async () => {
	writeFileSync(path, fixture());
	const result = await sync(db, home);
	expect(result.errors).toEqual([]);
	expect(result.messages_added).toBe(2);
	expect(result.usage_records_added).toBe(1);
	expect(db.stats().tokens).toMatchObject({
		input: 100,
		cached_input: 60,
		output: 20,
		reasoning_output: 5,
		total: 120,
	});
	expect(db.stats().cost_total).toBeNull();
	expect(db.tools()).toMatchObject([
		{ tool_name: 'command', count: 1 },
	]);
	expect(db.tools('invocation')).toMatchObject([
		{ tool_name: 'exec', count: 1 },
	]);
	expect(db.recall('café').matches[0].after[0].content_text).toBe(
		'Found the migrations.',
	);
	expect((await sync(db, home)).records_added).toBe(0);
	expect(db.get('SELECT model FROM usage_records')?.model).toBe(
		'test-model',
	);
});
test('waits for complete UTF-8 lines and resumes with model/turn context', async () => {
	const lines = fixture().trimEnd().split('\n');
	writeFileSync(path, lines.slice(0, 4).join('\n') + '\n');
	const message = Buffer.from(lines[4] + '\n');
	const cut = message.indexOf(Buffer.from('é')) + 1;
	appendFileSync(path, message.subarray(0, cut));
	expect((await sync(db, home)).messages_added).toBe(0);
	appendFileSync(path, message.subarray(cut));
	appendFileSync(path, lines.slice(5).join('\n') + '\n');
	expect((await sync(db, home)).messages_added).toBe(2);
	expect(db.search('café')).toHaveLength(1);
	expect(db.get('SELECT model FROM usage_records')?.model).toBe(
		'test-model',
	);
});
test('skips legacy, missing and unknown history modes explicitly', async () => {
	writeFileSync(path, fixture('legacy', 'legacy'));
	writeFileSync(
		join(home, 'sessions', 'unknown.jsonl'),
		fixture('unknown', 'future'),
	);
	writeFileSync(
		join(home, 'sessions', 'missing.jsonl'),
		entry('session_meta', { id: 'missing' }) + '\n',
	);
	const result = await sync(db, home);
	expect(result.legacy_skipped).toBe(1);
	expect(result.unsupported_files).toBe(2);
	expect(db.stats().sessions).toBe(0);
});
test('moving to archived and removing sources preserves the archive', async () => {
	writeFileSync(path, fixture());
	await sync(db, home);
	const moved = join(home, 'archived_sessions', 'test.jsonl');
	renameSync(path, moved);
	expect((await sync(db, home)).messages_added).toBe(0);
	expect(db.sessions()[0].source_state).toBe('archived');
	expect(
		(await list_resumable_sessions({ db_path: db.path })).sessions,
	).toHaveLength(0);
	rmSync(moved);
	await sync(db, home);
	expect(db.sessions()[0].source_state).toBe('missing');
	expect(db.search('migrations')).toHaveLength(2);
});
test('refreshes names without transcript changes and checks live resumable paths', async () => {
	writeFileSync(path, fixture());
	await sync(db, home);
	writeFileSync(
		join(home, 'session_index.jsonl'),
		JSON.stringify({
			id: 'session-1',
			thread_name: 'Database work',
			updated_at: '2026-09-02T00:00:00Z',
		}) + '\n',
	);
	expect((await sync(db, home)).records_added).toBe(0);
	const options = {
		db_path: db.path,
		scope: 'project' as const,
		cwd: '/project',
		query: 'Database',
	};
	const result = await list_resumable_sessions(options);
	expect(result.sessions[0]).toMatchObject({
		name: 'Database work',
		id: 'session-1',
		resume_status: 'unverified',
	});
	rmSync(path);
	expect(
		(await list_resumable_sessions(options)).sessions,
	).toHaveLength(0);
});
test('malformed and unknown complete records advance the checkpoint', async () => {
	writeFileSync(
		path,
		fixture() + 'bad json\n' + entry('future_event', {}) + '\n',
	);
	const result = await sync(db, home);
	expect(result.errors).toEqual([]);
	expect(result.malformed_records).toBe(1);
	expect(result.unsupported_records).toEqual({ future_event: 1 });
	expect((await sync(db, home)).malformed_records).toBe(0);
});
test('rollback excludes abandoned turns from recall but preserves history and usage', async () => {
	writeFileSync(
		path,
		fixture() +
			entry('event_msg', {
				type: 'thread_rolled_back',
				num_turns: 1,
			}) +
			'\n',
	);
	expect((await sync(db, home)).errors).toEqual([]);
	expect(db.search('migrations')).toHaveLength(0);
	expect(
		db.search('migrations', { include_rolled_back: true }),
	).toHaveLength(2);
	expect(db.stats().tokens?.total).toBe(120);
});
test('compaction does not import replacement dialogue or duplicate usage', async () => {
	writeFileSync(
		path,
		fixture() +
			entry('compacted', {
				message: 'Summary',
				replacement_history: [
					{ type: 'message', content: 'not new dialogue' },
				],
			}) +
			'\n',
	);
	await sync(db, home);
	expect(db.stats().messages).toBe(2);
	expect(db.stats().tokens?.total).toBe(120);
});
test('tool output pruning preserves messages and does not get undone by replay', async () => {
	writeFileSync(
		path,
		fixture() +
			entry('response_item', {
				type: 'custom_tool_call_output',
				call_id: 'call-1',
				output: 'x'.repeat(1000),
			}) +
			'\n',
	);
	await sync(db, home);
	expect(db.compact(0, true).tool_results).toBe(1);
	expect(
		String(
			db.get(
				"SELECT content FROM tool_results WHERE tool_call_id='call:call-1'",
			)?.content,
		).length,
	).toBe(1000);
	db.compact(0, false);
	renameSync(path, join(home, 'archived_sessions', 'test.jsonl'));
	await sync(db, home);
	expect(
		db.get(
			"SELECT content FROM tool_results WHERE tool_call_id='call:call-1'",
		)?.content,
	).toBe('[compacted tool output]');
	expect(db.stats().messages).toBe(2);
});
test('truncation and replacement are replayable without duplicate native identities', async () => {
	writeFileSync(path, fixture());
	await sync(db, home);
	writeFileSync(path, fixture().split('\n')[0] + '\n');
	expect((await sync(db, home)).errors).toEqual([]);
	writeFileSync(
		path,
		fixture() +
			item('new', 'AgentMessage', {
				content: [{ type: 'text', text: 'A new message' }],
			}) +
			'\n',
	);
	const result = await sync(db, home);
	expect(result.errors).toEqual([]);
	expect(db.stats().messages).toBe(3);
});
test('a failed file transaction rolls back its rows and checkpoint', async () => {
	writeFileSync(path, fixture());
	db.db.exec(
		"CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'test failure'); END;",
	);
	expect((await sync(db, home)).errors).toHaveLength(1);
	expect(db.stats().sessions).toBe(0);
	expect(db.all('SELECT * FROM sync_state')).toHaveLength(0);
	db.db.exec('DROP TRIGGER fail_message');
	expect((await sync(db, home)).messages_added).toBe(2);
});
test('missing roots do not mark known sources missing', async () => {
	writeFileSync(path, fixture());
	await sync(db, home);
	renameSync(join(home, 'sessions'), join(home, 'offline'));
	await sync(db, home);
	expect(db.sessions()[0].source_state).toBe('active');
});
test('new output does not change the source file', async () => {
	writeFileSync(path, fixture());
	const source = readFileSync(path);
	await sync(db, home);
	expect(readFileSync(path)).toEqual(source);
});

test('repeated response usage and inherited fork usage cannot inflate totals', async () => {
	writeFileSync(path, fixture());
	const original = fixture()
		.trimEnd()
		.split('\n')
		.find((line) => JSON.parse(line).type === 'token_usage_record')!;
	appendFileSync(path, original + '\n');
	const fork = fixture('fork').replace(
		'"thread_id":"fork","session_id":"fork","turn_id":"turn-1","response_id":"response-1"',
		'"thread_id":"session-1","session_id":"session-1","turn_id":"turn-1","response_id":"response-1"',
	);
	writeFileSync(join(home, 'sessions', 'fork.jsonl'), fork);
	expect((await sync(db, home)).errors).toEqual([]);
	expect(db.stats().tokens?.total).toBe(120);
});

test('same-size rewrite beyond the header is detected and updates FTS', async () => {
	const padding =
		entry('world_state', { value: 'x'.repeat(6000) }) + '\n';
	const lines = fixture().split('\n');
	const source =
		lines[0] + '\n' + padding + lines.slice(1).join('\n');
	writeFileSync(path, source);
	await sync(db, home);
	writeFileSync(path, source.replaceAll('migrations', 'migratiONS'));
	const { utimesSync } = await import('node:fs');
	utimesSync(path, new Date(), new Date(Date.now() + 1000));
	const result = await sync(db, home);
	expect(result.records_added).toBeGreaterThan(0);
	expect(db.search('migrations')[0].content_text).toContain(
		'migratiONS',
	);
});

test('state DB enrichment is optional, read-only, and respects newer index names', async () => {
	const { DatabaseSync } = await import('node:sqlite');
	const metadata = new DatabaseSync(join(home, 'state_99.sqlite'));
	metadata.exec(
		"CREATE TABLE threads(id TEXT,name TEXT,updated_at_ms INTEGER,git_branch TEXT); INSERT INTO threads VALUES('session-1','State title',1,'main'); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT); INSERT INTO thread_spawn_edges VALUES('parent','session-1');",
	);
	metadata.close();
	writeFileSync(path, fixture());
	expect((await sync(db, home)).errors).toEqual([]);
	expect(db.sessions()[0].name).toBe('State title');
	expect(db.all('SELECT * FROM session_links')[0]).toMatchObject({
		parent_id: 'parent',
		child_id: 'session-1',
		kind: 'spawn',
	});
	writeFileSync(
		join(home, 'session_index.jsonl'),
		JSON.stringify({
			id: 'session-1',
			thread_name: 'Newer index',
			updated_at: '2026-09-02T00:00:00Z',
		}) + '\n',
	);
	await sync(db, home);
	expect(db.sessions()[0].name).toBe('Newer index');
	writeFileSync(join(home, 'state_100.sqlite'), 'invalid database');
	const result = await sync(db, home);
	expect(result.errors).toEqual([]);
	expect(result.warnings.length).toBeGreaterThan(0);
});
