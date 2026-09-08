# ocrecall

A local SQLite archive for OpenAI Codex session search, recall, and
analytics.

**Status: scaffold only.** The CLI runs, but session import, database
storage, and recall commands are not implemented yet. The planned
importer supports paginated Codex history only; legacy sessions will
be reported as skipped. See [PLAN.md](PLAN.md) for the design.

## Stack

Matches pirecall: TypeScript ESM, citty, tinyglobby, built-in
`node:sqlite`, Vite+, Vitest, pnpm, and Changesets. SQLite and file
discovery will be wired in when session import is implemented.

## Development

Requires Node.js 24+ and the pnpm version in `package.json`.

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm start --help
```

`pnpm dev` watches and rebuilds the CLI. The test command currently
allows an empty suite; tests will be added alongside implementation.

## Release tooling

Changesets is configured for public npm releases from `main`.
`pnpm changeset` records a change; `pnpm release` builds and
publishes. Nothing has been published as part of scaffolding.

## License

MIT
