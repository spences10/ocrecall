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
