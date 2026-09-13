import { expect, test } from 'vitest';
import { Database } from './db.ts';

test('recall fills context slots with readable items in source order', () => {
	const db = new Database(':memory:');
	try {
		db.run(
			"INSERT INTO sessions(id,history_mode,first_timestamp,last_timestamp) VALUES('session','paginated',0,0)",
		);
		const content = [
			'Earlier message',
			'',
			null,
			'Readable reasoning',
			'\t\n\r ',
			'Needle match',
			'',
			null,
			'\t\n\r ',
			'Later message',
			'',
			'Final message',
		];
		for (const [order, text] of content.entries()) {
			db.run(
				'INSERT INTO messages(session_id,id,type,content_text,timestamp,source_order) VALUES(?,?,?,?,?,?)',
				'session',
				String(order),
				order === 3 ? 'reasoning' : 'assistant',
				text,
				0,
				order,
			);
		}
		const match = db.recall('Needle', { context: 2 }).matches[0];
		expect(match.before.map((row) => row.content_text)).toEqual([
			'Earlier message',
			'Readable reasoning',
		]);
		expect(match.after.map((row) => row.content_text)).toEqual([
			'Later message',
			'Final message',
		]);
		expect(
			db.recall('Needle', { context: 0 }).matches[0],
		).toMatchObject({ before: [], after: [] });
		expect(db.get('SELECT COUNT(*) AS n FROM messages')?.n).toBe(
			content.length,
		);
	} finally {
		db.close();
	}
});

test('search supports FTS syntax, project fragments, session prefixes, dates and ordering', () => {
	const db = new Database(':memory:');
	try {
		for (const [session, project] of [
			['alpha-session', '/work/catalog'],
			['beta-session', '/work/billing'],
		])
			db.run(
				"INSERT INTO sessions(id,project_path,history_mode,first_timestamp,last_timestamp) VALUES(?,?,'paginated',0,60000)",
				session,
				project,
			);
		for (const [id, session, text, time] of [
			['1', 'alpha-session', 'database migration', 10],
			['2', 'alpha-session', 'database backups', 20],
			['3', 'beta-session', 'migration planning', 30],
			['4', 'alpha-session', 'src/routes.ts', 40],
		] as const)
			db.run(
				"INSERT INTO messages(session_id,id,type,content_text,timestamp,source_order) VALUES(?,?,'assistant',?,?,?)",
				session,
				id,
				text,
				time,
				time,
			);
		expect(
			db.search('database AND migration').map((row) => row.id),
		).toEqual(['1']);
		expect(
			db
				.search('"database migration" OR planning', {
					sort: 'time-asc',
				})
				.map((row) => row.id),
		).toEqual(['1', '3']);
		expect(
			db.search('database NOT migration').map((row) => row.id),
		).toEqual(['2']);
		expect(
			db.search('migrat*', { sort: 'time' }).map((row) => row.id),
		).toEqual(['3', '1']);
		expect(
			db
				.search('database OR migration', { sort: 'time-asc' })
				.map((row) => row.id),
		).toEqual(['1', '2', '3']);
		expect(
			db.search('"database migration"').map((row) => row.id),
		).toEqual(['1']);
		expect(db.search('src/routes.ts').map((row) => row.id)).toEqual([
			'4',
		]);
		expect(
			db
				.search('database OR migration', {
					project: 'catalog',
					session: 'alpha',
					after: 20,
				})
				.map((row) => row.id),
		).toEqual(['2']);
		expect(
			db.search('migration', {
				project: 'billing',
				session: 'alpha',
			}),
		).toEqual([]);
		expect(db.sessions({ project: 'catalog' })[0]).toMatchObject({
			id: 'alpha-session',
			duration_mins: 1,
			total_tokens: null,
			total_cost: null,
		});
		db.db.exec(
			"INSERT INTO messages_fts(messages_fts) VALUES('delete-all')",
		);
		expect(db.search('database')).toHaveLength(0);
		db.rebuild_fts();
		expect(db.search('database')).toHaveLength(2);
	} finally {
		db.close();
	}
});

test('search prefers completed answers while preserving explicit phase access', () => {
	const db = new Database(':memory:');
	try {
		db.run(
			"INSERT INTO sessions(id,history_mode,first_timestamp,last_timestamp) VALUES('session','paginated',0,0)",
		);
		for (const [id, turn, type, phase, text, order] of [
			['user', 'turn-1', 'user', null, 'phase needle request', 1],
			[
				'progress',
				'turn-1',
				'assistant',
				'commentary',
				'phase needle investigating',
				2,
			],
			[
				'answer',
				'turn-1',
				'assistant',
				'final_answer',
				'phase needle completed',
				3,
			],
			[
				'reasoning',
				'turn-1',
				'reasoning',
				null,
				'phase needle rationale',
				4,
			],
			[
				'progress-2',
				'turn-2',
				'assistant',
				'commentary',
				'phase needle checking',
				5,
			],
		] as const)
			db.run(
				'INSERT INTO messages(session_id,id,turn_id,type,phase,content_text,timestamp,source_order) VALUES(?,?,?,?,?,?,?,?)',
				'session',
				id,
				turn,
				type,
				phase,
				text,
				order,
				order,
			);

		expect(
			db
				.search('phase needle')
				.map((row) => String(row.id))
				.sort((a, b) => a.localeCompare(b)),
		).toEqual(['answer', 'reasoning', 'user']);
		expect(
			db
				.search('phase needle', { phase: 'commentary' })
				.map((row) => String(row.id))
				.sort((a, b) => a.localeCompare(b)),
		).toEqual(['progress', 'progress-2']);
		expect(
			db
				.search('phase needle', { phase: 'final_answer' })
				.map((row) => String(row.id)),
		).toEqual(['answer']);
		expect(db.search('phase needle', { phase: 'all' })).toHaveLength(
			5,
		);

		const recalled = db.recall('completed', { context: 1 })
			.matches[0];
		expect(recalled.match).toMatchObject({
			id: 'answer',
			type: 'assistant',
			phase: 'final_answer',
		});
		expect(recalled.before[0]).toMatchObject({
			id: 'progress',
			phase: 'commentary',
		});
		expect(() =>
			db.search('needle', { phase: 'invalid' as 'all' }),
		).toThrow(/phase/);
	} finally {
		db.close();
	}
});

test('tool percentages include all filtered tools before applying the top limit', () => {
	const db = new Database(':memory:');
	try {
		for (const [session, project] of [
			['a', '/work/catalog'],
			['b', '/work/billing'],
		])
			db.run(
				"INSERT INTO sessions(id,project_path,history_mode,first_timestamp,last_timestamp) VALUES(?,?,'paginated',0,0)",
				session,
				project,
			);
		for (const [id, session, kind, name] of [
			['1', 'a', 'operation', 'command'],
			['2', 'a', 'operation', 'command'],
			['3', 'a', 'operation', 'file_change'],
			['4', 'b', 'operation', 'command'],
			['5', 'a', 'invocation', 'exec'],
		])
			db.run(
				'INSERT INTO tool_calls(session_id,id,kind,tool_name,timestamp,source_order) VALUES(?,?,?,?,0,0)',
				session,
				id,
				kind,
				name,
			);
		const top = db.tools('operation', 1, 'catalog');
		expect(top).toHaveLength(1);
		expect(top[0].count).toBe(2);
		expect(Number(top[0].percentage)).toBeCloseTo(200 / 3);
		expect(db.tools('invocation', 10, 'catalog')[0]).toMatchObject({
			count: 1,
			percentage: 100,
		});
	} finally {
		db.close();
	}
});

test('schema inspection includes columns, keys, indexes and escaped table names', () => {
	const db = new Database(':memory:');
	try {
		const table = db.get_schema('messages').tables[0];
		expect(table.name).toBe('messages');
		expect(
			table.columns.some((column) => column.name === 'session_id'),
		).toBe(true);
		expect(table.foreign_keys).toContainEqual({
			from: 'session_id',
			table: 'sessions',
			to: 'id',
		});
		expect(table.indexes.length).toBeGreaterThan(0);
		db.db.exec('CREATE TABLE "quoted""name"(id INTEGER)');
		expect(db.get_schema('quoted"name').tables[0].row_count).toBe(0);
		expect(db.get_schema('missing').tables).toEqual([]);
	} finally {
		db.close();
	}
});

test('compaction reports tool groups and sizes without modifying dry-run data', () => {
	const db = new Database(':memory:');
	try {
		db.run(
			"INSERT INTO sessions(id,history_mode,first_timestamp,last_timestamp) VALUES('a','paginated',0,0)",
		);
		db.run(
			"INSERT INTO tool_calls(session_id,id,kind,tool_name,timestamp,source_order) VALUES('a','call','operation','command',0,0)",
		);
		db.run(
			"INSERT INTO tool_results(session_id,tool_call_id,content,timestamp) VALUES('a','call',?,0)",
			'é'.repeat(300),
		);
		const preview = db.compact(0, true);
		expect(preview.tool_results_compacted[0]).toMatchObject({
			kind: 'operation',
			tool_name: 'command',
			count: 1,
			output_bytes: 600,
		});
		expect(preview.bytes_after).toBe(preview.bytes_before);
		expect(
			db.get('SELECT compacted FROM tool_results')?.compacted,
		).toBe(0);
		const result = db.compact(0, false);
		expect(result.tool_results).toBe(1);
		expect(db.compact(0, true).tool_results).toBe(0);
	} finally {
		db.close();
	}
});
