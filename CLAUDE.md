# taskferry-mcp

HTTP MCP bridge to a local TaskFerry daemon. Prototype: mock-tested only, never run against a real daemon. Read `README.md` for the architecture and the open gaps, `docs/adr/` for why it is a separate repo.

## Commands

- `mise run check`: the full gate (prettier check, eslint, the TypeScript split check, `tsc --noEmit` on 7.x, unit tests). The global pre-commit hook runs it on every commit, so it must pass before a commit lands. CI runs the same steps separately.
- `mise run run` / `mise run gateway`: start the bridge (port 8787) or the forwarding gateway demo (port 8788) on loopback. Both need the `TASKFERRY_*` variables listed in the README.
- `npm run format` rewrites files; `format:check` only reports.

## Layout

- `src/server.ts`: the bridge. Per-tool handlers, the scope guard, the daemon socket client, the HTTP/JSON-RPC layer.
- `src/gateway.ts`: loopback forwarding gateway demo.
- `test/bridge.test.ts`: tests against a stub daemon on a unix socket and real loopback HTTP listeners.
- `docs/evidence/`: the prototype's original logs. Do not edit them.

## Rules specific to this repo

- The daemon wire protocol is owned by TaskFerry (`src/protocol.js` there: `{version: 1, id, method, params}` requests, `{version: 1, ok, id, result | error}` replies). Check that file, not this repo's stub daemon, when the two disagree.
- Anything that touches a path from a caller must go through the allowlist and `realpathSync` checks in `src/server.ts`. A new tool that forwards a caller-supplied directory or task ID needs a test that proves it is refused outside the allowed roots.
- Pinned versions are exact. `typescript` stays on 6.x for eslint while `typescript-native` (7.x) runs `tsc`; `npm run check:typescript-split` says when to merge them (`docs/things-that-look-like-bugs.md`). Use `npm run typecheck`, not `npx tsc`.
- Behavior a reader would call a bug but is deliberate goes in `docs/things-that-look-like-bugs.md` in the same change.
