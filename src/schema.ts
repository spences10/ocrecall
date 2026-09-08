import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;
// Register numbered SQL files here when advancing SCHEMA_VERSION.
const MIGRATIONS: Readonly<Record<number, string>> = {};

export function apply_schema(
	db: DatabaseSync,
	latest_version = SCHEMA_VERSION,
	migrations: Readonly<Record<number, string>> = MIGRATIONS,
) {
	if (!Number.isSafeInteger(latest_version) || latest_version < 1)
		throw new Error('Invalid target schema version');
	// Read the version under the write lock so simultaneous openers cannot
	// both decide to apply the same migration.
	db.exec('BEGIN IMMEDIATE');
	try {
		let version = Number(
			db.prepare('PRAGMA user_version').get()?.user_version,
		);
		if (version > latest_version)
			throw new Error(
				`Database schema ${version} is newer than supported version ${latest_version}`,
			);
		// Validate the entire pending chain before making any changes.
		for (
			let next = Math.max(version + 1, 2);
			next <= latest_version;
			next++
		) {
			if (!migrations[next]?.trim())
				throw new Error(
					`Missing ocrecall migration for schema version ${next}`,
				);
		}
		if (version === 0) {
			const tables = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table'",
				)
				.all();
			if (tables.length)
				throw new Error(
					'Refusing to initialize an unrecognized database',
				);
			db.exec(
				readFileSync(
					new URL('./schema.sql', import.meta.url),
					'utf8',
				),
			);
			db.exec('PRAGMA user_version = 1');
			version = 1;
		}
		for (let next = version + 1; next <= latest_version; next++) {
			db.exec(migrations[next]);
			db.exec(`PRAGMA user_version = ${next}`);
		}
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}
