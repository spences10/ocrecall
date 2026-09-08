import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;
export function apply_schema(db: DatabaseSync) {
	const version = Number(
		db.prepare('PRAGMA user_version').get()?.user_version,
	);
	if (version > SCHEMA_VERSION)
		throw new Error(
			`Database schema ${version} is newer than supported version ${SCHEMA_VERSION}`,
		);
	if (version === SCHEMA_VERSION) return;
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
		.all();
	if (tables.length)
		throw new Error(
			'Refusing to initialize an unrecognized database',
		);
	db.exec('BEGIN IMMEDIATE');
	try {
		db.exec(
			readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'),
		);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}
