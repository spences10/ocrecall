# ocrecall

[![built with vite+](https://img.shields.io/badge/built%20with-Vite+-646CFF?logo=vite&logoColor=white)](https://viteplus.dev)
[![tested with vitest](https://img.shields.io/badge/tested%20with-Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)

Search and recall past OpenAI Codex conversations from a local SQLite
archive. Inspect sessions, token usage, tool calls, and model changes.

Requires **Node.js 24+**. No API key or server needed.

## Quick start

```bash
pnpx ocrecall sync
pnpx ocrecall recall "database migration"
pnpx ocrecall stats
```

Or ask Codex:

> Run `pnpx ocrecall sync`, then use `pnpx ocrecall recall` to find
> our previous database migration discussion.

Mention ocrecall when you want the agent to use it; commands expose
options through `--help` and structured output through `--json`.

## Commands

```bash
pnpx ocrecall sync                  # Incremental import
pnpx ocrecall stats                 # Counts and recorded token usage
pnpx ocrecall sessions              # Recent sessions
pnpx ocrecall search "migration"    # Full-text search
pnpx ocrecall recall "migration"    # Matches with surrounding context
pnpx ocrecall tools                 # Most-used tools
pnpx ocrecall query "SELECT * FROM sessions LIMIT 5"
pnpx ocrecall schema                # Tables, columns, and indexes
pnpx ocrecall compact --dry-run     # Preview pruning old tool outputs
pnpx ocrecall resumable --json      # Live sessions for resume integrations
```

All commands accept `--json`, `--db <path>` (`-d`), and
`--codex-home <path>`. Recall and resumable output is always JSON.
Search, recall, sessions, and tools support `--project <name>` (`-p`).

```bash
pnpx ocrecall search 'migration OR rollback' --project my-app
pnpx ocrecall search 'migrat*' --after 2026-09-01 --context 2
pnpx ocrecall query 'SELECT * FROM sessions' --format csv --limit 10
```

## How it works

Sync reads active and archived JSONL sessions from `CODEX_HOME`
(default `~/.codex`) into **`~/.codex/ocrecall.db`**, or
`<CODEX_HOME>/ocrecall.db` when overridden. Imports are incremental;
history stays searchable when its source files are deleted.

Only **paginated history** is supported; legacy sessions are skipped.
Token totals use recorded usage, and monetary costs are unavailable.
Codex source files are never modified. `compact` prunes old tool
outputs from ocrecall's database while retaining conversations.

The exported `ocrecall/resumable` API lists live session sources for
integrations. Actual client resume support remains unverified.

See the [reference](docs/reference.md) for all options, accounting
rules, archive behavior, and the resumable API.

## Development

TypeScript, citty, `node:sqlite`, Vite+, Vitest, pnpm, and Changesets,
following [pirecall](https://github.com/spences10/pirecall).

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm start --help
```

Use `pnpm dev` to watch TypeScript changes; rebuild after SQL changes.
See the [migration guide](src/migrations/README.md) for schema
upgrades. The workspace's two-day minimum dependency release age can
delay running just-published packages from this checkout.

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
