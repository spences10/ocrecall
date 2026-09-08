# ocrecall

Sync OpenAI Codex's paginated sessions into a local SQLite archive.
Search past conversations, recall context, inspect token usage and
tool activity, and discover sessions for resume integrations.

## Quick start

```bash
pnpx ocrecall sync
pnpx ocrecall search "database migration"
pnpx ocrecall recall "database migration"
pnpx ocrecall stats
```

Or ask Codex: “Run `pnpx ocrecall sync`, then use `ocrecall recall` to
find our previous database migration discussion.”

Requires Node.js 24+. No API key, server, or running Codex process is
needed. ocrecall reads locally persisted session files and writes its
own database. It does not modify Codex sessions or resume them itself.

## Commands

```bash
ocrecall sync                         # Incremental import
ocrecall stats --json                 # Counts and recorded token usage
ocrecall sessions --limit 20          # Recent sessions
ocrecall sessions --state archived    # Archived sessions
ocrecall search "migration" --json    # Full-text phrase search
ocrecall recall "migration" -c 2      # Bounded surrounding context, JSON
ocrecall tools                       # Completed operations
ocrecall tools --kind invocation     # Model tool calls, counted separately
ocrecall query "SELECT * FROM sessions LIMIT 5"
ocrecall schema --json
ocrecall compact --older-than 30 --dry-run
ocrecall resumable --scope project --cwd "$PWD" --json
```

All commands accept `--json`, `--db <path>` (`-d`), and
`--codex-home <path>`. `recall` and `resumable` always return JSON.
`search`, `recall`, and `sessions` accept `--project <path>` (`-p`).
Run a command with `--help` for its options.

The Codex home defaults to `CODEX_HOME`, then `~/.codex`. The archive
path defaults to `<Codex home>/ocrecall.db`. Sync reads both
`sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl`. Optional
names come from `session_index.jsonl` and supported `state_*.sqlite`
databases. Use `sync --sqlite-home <directory>` when Codex state is
stored elsewhere; ocrecall does not parse Codex's config profiles. An
incompatible metadata database produces a warning without preventing
transcript import.

## History and accounting

Only `history_mode: paginated` is supported. Legacy sessions are
counted as skipped; absent or unknown modes are reported as
unsupported. No legacy conversion is performed. Remote-only or
ephemeral sessions without local files cannot be imported.

Completed items provide the searchable conversation. Mirrored model
response messages are not added a second time. Tool invocations and
completed operations are separate because one invocation can execute
several operations. Original call inputs remain queryable, including
free-form custom tool input. Tool output is not part of default
message search. Readable reasoning summaries and realtime transcripts
are indexed; encrypted reasoning and inline binary content are not
decoded.

Token totals come from structured per-response `token_usage_record`
records. Mirrored `token_count` events and cumulative snapshots are
not added to the totals. Cached input is a subset of input, and
reasoning output is a subset of output: do not add those breakdowns
again. Response IDs deduplicate copied usage across sessions.
Explicitly inherited usage is excluded from newly incurred totals.
Missing response IDs limit cross-session deduplication; inspect
`usage_records` for detailed attribution. Stats include turn-level
usage coverage and return `null` when usage is unavailable. Monetary
cost is unavailable, not zero.

Codex compaction summaries do not replace the archived conversation or
create new usage. Rolled-back turns remain in the database but are
excluded from default search/recall. Use
`search --include-rolled-back` to find them. Unknown record/item types
are counted in sync output.

## Incremental archive

Sync checkpoints complete JSONL lines using byte offsets and persists
turn/model context. Partial trailing lines are retried on the next
run. Each file imports transactionally; a failed file does not advance
its checkpoint. Sync errors are returned in JSON and cause a nonzero
exit.

Moving a file into Codex's archive keeps its existing conversation
identity. Missing sources remain searchable. A missing/unreadable root
does not mark every session deleted. Replaced or truncated files are
replayed using native identities; previously imported history is
retained. Normal appends are incremental. This is an append-log
importer, not a continuous file-integrity monitor: arbitrary edits
within an existing log combined with an append may require a fresh
archive to recover every edit.

`compact` replaces old, large tool outputs in ocrecall's database with
a marker. It preserves conversation messages, usage, call inputs, and
Codex source files. `--dry-run` previews the eligible output count.

## Resumable session API

```ts
import { list_resumable_sessions } from "ocrecall/resumable";

const result = await list_resumable_sessions({
	scope: "project",
	cwd: process.cwd(),
	query: "migration",
	limit: 50,
});
```

Results contain `schema_version`, `capabilities`, and `sessions`, with
thread IDs, names, cwd, source paths, and timestamps. Only active
sources that still exist are returned. Results have
`resume_status: 'unverified'`: a file's presence does not establish
the installed client's support for paginated history. Consumers must
check client support and resume by thread ID. Archived sessions are
not automatically unarchived.

## Development

Uses pirecall's TypeScript ESM, citty, built-in `node:sqlite`, Vite+,
Vitest, pnpm, and Changesets setup. Source files use `.ts` and can run
under Node 24's native TypeScript support.

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm start --help
node src/index.ts --help
```

`pnpm dev` builds SQL assets and watches the TypeScript bundle. Rerun
`pnpm build` after changing SQL assets. The published package includes
the schema and migration directory, CLI, and typed resumable API.

The schema starts at `PRAGMA user_version = 1`. Future changes must
use transactional migrations that retain archive history.

The workspace retains pirecall's two-day minimum dependency release
age. Consequently, `pnpx ocrecall` from this checkout can reject a
just-published release until that waiting period has elapsed.

## Releases

```bash
pnpm changeset
pnpm run version
pnpm run format
# Review and commit the version/changelog changes.
pnpm run release
```

## License

MIT
