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

const migrations = {
	2: 'ALTER TABLE sessions ADD COLUMN migration_note TEXT;',
	3: "UPDATE sessions SET migration_note = 'preserved'; CREATE INDEX sessions_migration_note ON sessions(migration_note);",
};

test('upgrades existing archives in order, preserves history, and reopens', () => {
	const db = new DatabaseSync(':memory:');
	try {
		apply_schema(db);
		db.exec(
			"INSERT INTO sessions(id, history_mode, first_timestamp, last_timestamp) VALUES ('saved', 'paginated', 1, 2)",
		);
		apply_schema(db, 3, migrations);
		apply_schema(db, 3, migrations);
		expect(
			db
				.prepare(
					'SELECT id, first_timestamp, migration_note FROM sessions',
				)
				.get(),
		).toEqual({
			id: 'saved',
			first_timestamp: 1,
			migration_note: 'preserved',
		});
		expect(
			db.prepare('PRAGMA user_version').get()?.user_version,
		).toBe(3);
	} finally {
		db.close();
	}
});

test('fresh databases and partially upgraded databases reach the same schema', () => {
	for (const starting_version of [0, 2]) {
		const db = new DatabaseSync(':memory:');
		try {
			if (starting_version) apply_schema(db, 2, migrations);
			// An already applied migration is never replayed or required again.
			apply_schema(
				db,
				3,
				starting_version ? { 3: migrations[3] } : migrations,
			);
			expect(
				db.prepare('PRAGMA user_version').get()?.user_version,
			).toBe(3);
			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE name = 'sessions_migration_note'",
					)
					.get()?.name,
			).toBe('sessions_migration_note');
		} finally {
			db.close();
		}
	}
});

test('failed upgrades roll back the whole chain and can be retried', () => {
	for (const starting_version of [0, 1]) {
		const db = new DatabaseSync(':memory:');
		try {
			if (starting_version) {
				apply_schema(db);
				db.exec(
					"INSERT INTO sessions(id, history_mode, first_timestamp, last_timestamp) VALUES ('saved', 'paginated', 1, 2)",
				);
			}
			expect(() =>
				apply_schema(db, 3, {
					...migrations,
					3: `${migrations[3]} INSERT INTO nonexistent VALUES (1);`,
				}),
			).toThrow();
			expect(
				db.prepare('PRAGMA user_version').get()?.user_version,
			).toBe(starting_version);
			expect(
				db
					.prepare('PRAGMA table_info(sessions)')
					.all()
					.some((column) => column.name === 'migration_note'),
			).toBe(false);
			if (starting_version)
				expect(db.prepare('SELECT id FROM sessions').get()?.id).toBe(
					'saved',
				);
			else
				expect(
					db
						.prepare(
							"SELECT name FROM sqlite_master WHERE type = 'table'",
						)
						.all(),
				).toEqual([]);
			apply_schema(db, 3, migrations);
			expect(
				db.prepare('PRAGMA user_version').get()?.user_version,
			).toBe(3);
		} finally {
			db.close();
		}
	}
});

test('rejects a missing migration before changing the archive', () => {
	const db = new DatabaseSync(':memory:');
	try {
		apply_schema(db);
		expect(() => apply_schema(db, 3, { 2: migrations[2] })).toThrow(
			'Missing ocrecall migration for schema version 3',
		);
		expect(
			db.prepare('PRAGMA user_version').get()?.user_version,
		).toBe(1);
		expect(
			db
				.prepare('PRAGMA table_info(sessions)')
				.all()
				.some((column) => column.name === 'migration_note'),
		).toBe(false);
	} finally {
		db.close();
	}
});
