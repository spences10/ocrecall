# Reference

## Commands

```bash
ocrecall sync                         # Incremental import
ocrecall stats --json                 # Counts and recorded token usage
ocrecall sessions --limit 20          # Recent sessions
ocrecall sessions --state archived    # Archived sessions
ocrecall search "migration" --json    # Full-text search
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
`search`, `recall`, `sessions`, and `tools` accept `--project <path>`
(`-p`), matching a path or partial project name (case-insensitive).
Resumable project scope continues to use an exact resolved `--cwd`.
Run a command with `--help` for its options.

Search supports pirecall's FTS expressions: `AND`, `OR`, `NOT`, quoted
phrases, and `prefix*`. Multiple unquoted words require all terms; for
an exact phrase, pass the quotes through to FTS:

```bash
ocrecall search '"database migration"'
ocrecall search 'migration OR rollback' --project ocrecall
ocrecall search 'migrat*' --session 01a080 --after 2026-09-01 --sort time
ocrecall search migration --context 2 --rebuild --json
ocrecall tools --project ocrecall --top 10
ocrecall query 'SELECT * FROM sessions' --format csv --limit 10
ocrecall query 'SELECT * FROM messages LIMIT 5' --wide
ocrecall schema messages --json
```

Search `--session` matches an ID prefix. `--after` is inclusive and
accepts an ISO date or timestamp; date-only values use UTC. `--sort`
accepts `relevance`, `time` (newest first), or `time-asc`. `--context`
adds readable surrounding items, skipping empty entries. `--rebuild`
repairs the FTS index from archived messages without reimporting
sources.

Query supports `--format table|json|csv` (`-f`), `--limit` (`-l`), and
`--wide` (`-w`). The limit caps returned rows even when SQL already
has its own LIMIT. `--json` takes precedence over `--format`. CSV
quotes commas, quotes, and line breaks; JSON/CSV values are never
truncated.

Tool statistics accept `--top` (`-t`) or `--limit` (`-l`), defaulting
to 10. Percentages use all tools matching the project and kind, before
the top-N limit. Sessions default to 10 results and include recorded
token totals, duration, and ISO dates. Costs remain unavailable for
Codex. `schema [table]` includes row counts, columns, indexes, and
foreign keys.

The command options now cover pirecall's search, query, tool, recall,
session, and schema workflows. JSON retains Codex-specific fields and
existing ocrecall fields; it is not a drop-in replacement for
pirecall's SQLite schema or Pi resume integration.

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
Codex source files. `--dry-run` previews eligible output counts and
original UTF-8 bytes, grouped by tool kind and name. Results include
the cutoff date and before/after database-plus-WAL sizes. Actual
compaction vacuums the archive and attempts to checkpoint the WAL;
concurrent readers can delay physical space reclamation. These sizes
describe files, not a promise that every removed output byte
immediately returns to the filesystem.

## Resumable session API

```ts
import { list_resumable_sessions } from 'ocrecall/resumable';

const result = await list_resumable_sessions({
	scope: 'project',
	cwd: process.cwd(),
	query: 'migration',
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
