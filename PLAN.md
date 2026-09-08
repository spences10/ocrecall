# ocrecall implementation plan

Research date: 2026-09-08. Planning only; implementation has not
started.

## Recommendation

Build a close sibling of pirecall: a local TypeScript CLI that
incrementally imports Codex history into its own SQLite archive, with
FTS search, compact context retrieval, analytics, and a versioned
session-discovery API.

Version 1 supports only sessions explicitly marked
`history_mode: paginated`. Legacy sessions are skipped and counted in
sync output; missing or unknown history modes are reported as
unsupported. No legacy parser or automatic conversion is planned. This
leaves two of the sixteen inspected local sessions outside the initial
archive without modifying or deleting their source files.

Keep pirecall's module boundaries and command vocabulary. Replace its
Pi parser with Codex-specific decoding and normalization. Add explicit
turns and usage records: Codex does not attach all usage to assistant
messages. Do not introduce a daemon, hosted service, embeddings, or
mandatory API calls.

## Evidence gathered

Reviewed the README, package configuration, parser, sync, database,
CLI, schema/migrations, resumable API, and test coverage in
../pirecall; compared ../ccrecall's README, package, source layout,
and team integration. Local checkout heads: pirecall `7d80547`,
ccrecall `93914a2`.

Pirecall contributes the best foundation:

- TypeScript ESM, citty, tinyglobby, built-in node:sqlite, Vite+,
  Vitest, pnpm, Changesets, and declaration output for the public
  library entry.
- Separate parser, sync, database, CLI, schema, and resumable modules.
- SQL assets and transactional PRAGMA user_version migrations.
- Archive retention independent of source-file existence.
- FTS5 search, recall with surrounding context, tool analytics, and
  pruning.
- Versioned resumable results with capabilities, project scope, and
  pagination.

Ccrecall supplies useful precedent for Git metadata and agent
relationships, but its Claude-specific teams/tasks tables should not
be copied into Codex.

Read-only local inspection found 15 active rollout JSONL files and one
archived rollout, spanning recorded CLI versions 0.144.6, 0.149.1, and
0.153.4. Two used legacy history; fourteen used paginated history.
Both CLI and Desktop-originated records were present. These are
observed formats, not a claim that all Codex installations use the
same internal schema.

Observed storage:

| Source                         | Purpose in ocrecall                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `sessions/**/*.jsonl`          | Primary active rollout input; directories are date-based                                    |
| `archived_sessions/**/*.jsonl` | Archived rollout input; retained in search and analytics                                    |
| `session_index.jsonl`          | Optional names and update metadata                                                          |
| `state_5.sqlite`               | Optional read-only metadata enrichment: titles, Git, source, relationships                  |
| `thread_history_1.sqlite`      | Observed turn/item projection; not a required ingestion dependency initially                |
| `history.jsonl`                | Observed prompt-history records (`session_id`, `ts`, `text`), insufficient for full archive |

Current rollout records include session_meta, turn_context,
response_item, event_msg, token_usage_record, compacted, world_state,
and realtime_item. Modern event_msg/item_completed records contain
typed conversation items alongside response_item records. Importing
both indiscriminately duplicates the conversation. Modern
token_usage_record coexists with token_count events.

Official documentation confirms thread listing/reading, archive
operations, forks, and ID-based resume. It also describes
experimental/unsupported paginated-history operations, despite
paginated files existing locally. Consequently, app-server is an
optional future adapter, not a prerequisite.

Sources:

- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/config-file/config-reference

## Architecture

```text
Codex rollouts + optional metadata
              |
          sources.ts
              |
      parser.ts -> normalize.ts
              |
            sync.ts
              |
       db.ts + schema.ts
              |
     CLI / ocrecall/resumable
```

Keep `src/index.ts`, `cli.ts`, `db.ts`, `parser.ts`, `sync.ts`,
`schema.ts`, `schema.sql`, `migrations/`, and `resumable.ts`
recognizable from pirecall. Add `sources.ts`, `normalize.ts`, and
`types.ts` to isolate Codex format details without creating a generic
multi-provider framework.

Resolve input home from `--codex-home`, then CODEX_HOME, then
`os.homedir()/.codex`. Default the separate archive to
`<resolved Codex home>/ocrecall.db`; retain `--db`. Allow an explicit
metadata SQLite directory override because Codex supports
`sqlite_home`. Optional metadata readers inspect supported schema
capabilities rather than assuming the current versioned filenames will
remain fixed. Missing or incompatible metadata must not prevent
rollout ingestion.

### Normalization rules

1. Preserve thread ID and recording session ID separately where
   present; forks can make these distinct. Preserve history mode and
   source version.
2. Use completed items as the canonical user-facing transcript.
   Underlying response records can enrich tool details but are not a
   fallback transcript. Reconcile by native item/call IDs and source
   provenance, not global text hashes. Incremental sync must be able
   to retain pending tool enrichment until its completed item arrives.
   Confirm the exact identity mapping with fixtures first.
3. Exclude repeated developer/system/environment scaffolding from
   ordinary recall. Preserve roles/channels and classify injected
   context separately. In paginated records, prefer UserMessage items
   for actual user input.
4. Support function and custom tool calls/outputs, plus typed command,
   file-change, extension/search, MCP, and collaboration items. Keep
   original names and payload shapes. Do not assume custom tool input
   is JSON. Tool results can lack a known error status or a
   corresponding retained call.
5. Prefer token_usage_record per-response usage with response
   identity; retain cumulative turn/thread totals for reconciliation,
   not summation. Ignore mirrored token_count events for accounting;
   do not implement a legacy usage fallback. Track cached input and
   reasoning output as breakdowns, avoiding double-counting their
   enclosing totals. Preserve unavailable values as NULL and report
   missing structured usage coverage.
6. Derive model/context changes from turn_context and available
   settings; persist that context across incremental sync boundaries.
   Do not copy Pi's assumption that explicit model_change events
   exist.
7. Record compaction and rollback boundaries. Keep original archive
   history, mark rolled-back turns, and exclude them from default
   current-context recall. Do not ingest replacement_history as fresh
   dialogue or fresh usage.
8. Store only available readable reasoning summaries/text; encrypted
   reasoning is not searchable text. Keep image/audio references and
   textual transcripts, avoiding inline binary/base64 payload
   duplication.
9. Preserve fork and spawned-agent relationships as different
   relationship types. Avoid counting inherited fork history as newly
   incurred usage when identity is available; report ambiguity when it
   is not.
10. Count unsupported record/item types and report coverage. No silent
    claim that unknown records have been fully imported.

### Database

Start a new ocrecall schema at version 1; reuse the migration
mechanism, not pirecall's historical migrations or legacy-database
adoption rules.

| Table                     | Responsibility                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| sessions                  | Thread identity, recording session ID, project/cwd, title, Git, origin, history mode, timestamps  |
| session_sources           | Paths, active/archived/missing state, file identity, size, last successful observation            |
| turns                     | Native/synthetic turn ID, ordered boundaries, model/provider, status and timing                   |
| messages                  | Canonical conversation text, role/phase, turn, source identity/order, optional readable reasoning |
| tool_calls / tool_results | Session-scoped call identity, original input/output, status, correlation                          |
| usage_records             | Response usage, cumulative snapshots, provenance, attribution/coverage                            |
| model_changes             | Derived changes, preserving pirecall's query vocabulary                                           |
| session_links             | Fork and spawned-child relationships                                                              |
| session_events            | Compaction, rollback, and selected lifecycle/unknown-event metadata                               |
| sync_state                | Byte checkpoint, file generation/fingerprint, parser version, normalization context               |
| messages_fts              | Full-text index and maintenance triggers                                                          |

Use stable native identities where available, otherwise deterministic
source-record identities scoped to a thread/file generation. Moving a
rollout to the archive directory must not mint new messages. Separate
file checkpoints from logical content identity. Order recall by source
sequence, not timestamps alone: multiple events can share a timestamp.

Do not copy Pi's cost_total=0 default: the observed Codex usage
records do not contain monetary cost. Version 1 reports token usage
and cost as unavailable. Any later pricing estimate must be separately
labelled and versioned.

### Sync behavior and improvements over the baseline

- Stream bytes from the checkpoint; pirecall's current main parser
  reads and re-encodes the entire file even during incremental
  imports.
- Commit checkpoints only through complete newline-terminated records;
  retry an unfinished tail on the next sync. Advance past counted
  malformed complete records, and distinguish unsupported records from
  parse failures.
- Detect shrinking/replaced files and replay safely. Use transactional
  per-file batches with rollback and durable normalization state. Keep
  archive rows when the source disappears; distinguish source rewrite
  from deletion.
- Scan active and archived roots together; only mark sources missing
  after successful enumeration of their root. Unreadable roots are not
  deletions.
- Update titles/source status independently of transcript mtime.
  Resuming alone does not imply new conversation activity.
- Report actual inserted/updated/skipped counts. Put progress on
  stderr so `sync --json` produces exactly one parseable JSON result
  on stdout.
- Keep Codex's files/databases read-only; all imports, indexes, and
  pruning affect only ocrecall's archive.

## User-facing contract

Keep pirecall's commands: `sync`, `stats`, `sessions`, `search`,
`tools`, `recall`, `query`, `schema`, `compact`, and `resumable`.
Retain JSON output, custom database paths, project filters, search
context, and the `ocrecall/resumable` exported function.

Add relevant session filters for archived state and source/agent
relationships. Search/analytics include archived history. Resumable
discovery defaults to present active sources and returns a versioned
envelope, thread ID, source path/home, cwd, name, timestamps, history
mode, and resume capability/status. File presence means a candidate,
not proof the installed Codex can resume that history mode. The
consumer resumes by thread ID and checks capability; ocrecall does not
automatically unarchive or resume sessions.

Keep `compact --dry-run`, adapted to Codex tool categories. It prunes
stored tool-output detail only, preserving text recall, usage,
provenance, and source logs; it is unrelated to Codex's own context
compaction.

## Delivery sequence and acceptance

1. **Scaffold and format fixtures.** Copy pirecall's
   build/package/test shape, establish supported Node runtime for
   node:sqlite, and create synthetic or sanitized fixtures matching
   the observed paginated records. Include legacy, missing-mode, and
   unknown-mode headers only to verify explicit skipping. Include
   stable item/call identity reconciliation examples before schema
   lock.
2. **Parser and normalized schema.** Implement turns, messages, tools,
   usage, lifecycle records, and source provenance. Assert exact
   fixture counts and totals; no duplicate messages from mirrored
   formats.
3. **Incremental archive.** Implement discovery, transactions,
   checkpoints, metadata refresh, and source liveness. Verify repeated
   sync is a no-op; append, UTF-8, partial writes, malformed lines,
   truncation, replacement, archive moves, missing/unreadable roots,
   and interrupted imports are safe.
4. **CLI parity.** Port search, recall, sessions, stats, tools, raw
   query, schema, and compact. Verify equal-timestamp ordering, FTS
   updates, JSON stdout, honest unknown usage/cost, and bounded
   context output.
5. **Resumable API and relationships.** Port the versioned public
   contract, add Codex identity/capability fields, and test
   archived/missing candidates, project scoping, pagination, forks,
   and child-session links. No dependency on undocumented Pi resume
   semantics.
6. **Package validation and documentation.** Run check, tests, build,
   and packed install smoke tests, including migration SQL and type
   exports. Validate a temporary archive against the local corpus
   without modifying Codex sources. Document coverage and any
   unsupported formats before preparing a release.

Version 1 targets locally persisted paginated Codex sessions. Legacy
history, remote/cloud-only history, ephemeral sessions without files,
an app-server adapter, pricing estimates, and a UI are outside the
initial release. Do not promise those records are recoverable from the
local archive.

## Remaining uncertainties to settle during implementation

- Native identity mapping between response records and completed
  items, particularly tools that wrap multiple operations and mirrored
  representations.
- Structured usage reconciliation and fork attribution; prevent a
  plausible-looking but incorrect total when evidence is incomplete.
- Metadata freshness/precedence across session_index and versioned
  state DBs; choose supported fields by schema and timestamps,
  retaining provenance.
- Resume support is installation-dependent: local paginated records
  and public documentation do not establish that every Codex client
  can resume them.

These affect the Codex adapter and validation, not the choice of
pirecall as the overall architecture.
