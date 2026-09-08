import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { apply_schema, SCHEMA_VERSION } from './schema.ts';

test('initializes transactionally and reopens idempotently', () => {
	const db = new DatabaseSync(':memory:');
	try {
		apply_schema(db);
		apply_schema(db);
		expect(
			db.prepare('PRAGMA user_version').get()?.user_version,
		).toBe(SCHEMA_VERSION);
	} finally {
		db.close();
	}
});
test('rejects foreign and future databases', () => {
	const db = new DatabaseSync(':memory:');
	try {
		db.exec('CREATE TABLE unrelated(id TEXT)');
		expect(() => apply_schema(db)).toThrow('unrecognized');
		db.exec('PRAGMA user_version=999');
		expect(() => apply_schema(db)).toThrow('newer');
	} finally {
		db.close();
	}
});
