# Migrations

`src/schema.sql` is the version 1 baseline. Keep it unchanged when
adding upgrades: fresh databases run the baseline followed by the same
migrations as existing archives.

To add the next schema change:

1. Create `src/migrations/002_description.sql` (then `003_...`, etc.).
2. Register its SQL under the target version in `MIGRATIONS` in
   `src/schema.ts`, following pirecall's explicit registry:

3. Set `SCHEMA_VERSION` to the new version, without gaps.
4. Test upgrading an existing archive with representative data and
   initializing a fresh database. Verify retained history and indexes.
5. Run `pnpm check`, `pnpm test`, and `pnpm build`. The build already
   copies the migration files into `dist/migrations` for npm releases.

Registry example:

```ts
const MIGRATIONS: Readonly<Record<number, string>> = {
	2: readFileSync(
		new URL('./migrations/002_description.sql', import.meta.url),
		'utf8',
	),
};
```

Opening an archive automatically applies pending migrations in numeric
order. The runner takes a write lock before reading `user_version`,
checks for missing migrations, and commits the complete upgrade in one
transaction. A failure rolls back all pending changes and version
updates, allowing a corrected release to retry safely.

SQL files must not contain transaction commands,
`PRAGMA user_version`, or operations such as `VACUUM` that cannot run
inside a transaction. Preserve archive data, and never edit migrations
already released. Newer database versions and unrecognized unversioned
databases are rejected. No schema bump or empty migration is needed
for the runner itself; the current schema remains version 1.
