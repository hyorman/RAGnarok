# RAGnarōk — contributor notes for Copilot

npm workspaces monorepo: `packages/core` (portable engine, no VS Code imports), `packages/vscode` (extension host), `packages/mcp-server` (stdio MCP server), `packages/graph-ui` (memory-graph renderer).

## Build and test

```bash
npm install
npm run compile            # build all packages
npm run test:fast          # core, graph-ui and MCP suites
npm run lint && npm run format:check
npm run test:docs          # doc claims checked against the code
node scripts/test-release-static.mjs
```

Run a single package's mocha suite from its directory with `../../node_modules/.bin/mocha`, after `npm run compile:tests --workspace=packages/<name>`. Tests run from `dist-test`, so a stale compile gives stale results.

## Rules

- Shared behaviour belongs in `@ragnarok/core`; the two hosts stay thin.
- Route errors by type (`error.name` or `instanceof`), never by message text.
- Storage format v2 is the only supported format; pre-0.4 data is refused, never read.
- Docs are tested: when behaviour changes, update the guide and `scripts/check-docs.mjs` together.
