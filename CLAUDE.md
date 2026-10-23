# taskferry-mcp

HTTP MCP bridge to a local TaskFerry daemon. Validated once against a local TaskFerry daemon; not production-ready. Read `README.md` for the architecture and the open gaps, `docs/adr/` for why it is a separate repo.

## Commands

- `mise run check`: the full gate (prettier check, eslint, the TypeScript split check, `tsc --noEmit` on 7.x, unit tests). The global pre-commit hook runs it on every commit, so it must pass before a commit lands. CI runs the same steps separately.
- `mise run run` / `mise run gateway`: start the bridge on its configured listener (a Unix socket by default; `node src/server.ts --listen-port 8787` for loopback TCP) or the forwarding gateway demo (port 8788). Both need the `TASKFERRY_*` variables listed in the README.
- `npm run format` rewrites files; `format:check` only reports.

## Layout

- `src/server.ts`: HTTP layer (path, auth, method, content type, Host/Origin, MCP transport) and the CLI entry.
- `src/listen.ts`: Unix socket and loopback TCP listeners, including socket permissions and stale-socket replacement.
- `src/config.ts`: flag/env/config-file precedence, defaults, and token resolution.
- `src/tools.ts`: the seven core tools, their strict schemas, and the dispatch allowlist checks.
- `src/tools-shared.ts`: shared tool scope, annotations, task-status helpers, and profile-aware bind resolution.
- `src/skills.ts`: the `worker` and `controller` skill profiles and their read-only bind paths.
- `src/tools-changeset.ts`: `taskferry_accept`, `taskferry_reject`, `taskferry_cancel`.
- `src/tools-resume.ts`: `taskferry_resume`, the session follow-up tool.
- `src/tools-message.ts`: `taskferry_message`, the confirmed full-message reader.
- `src/tools-worktree.ts`: `taskferry_worktree`, the scoped read-only file viewer.
- `src/scope.ts`: allowed-root check for task directories.
- `src/daemon.ts`: Unix socket client for the TaskFerry protocol.
- `src/models.ts`: the `opencode models` catalog runner and its short-lived cache.
- `src/errors.ts`: shared errno `code` reader for filesystem errors.
- `src/gateway.ts`: loopback forwarding gateway demo.
- `test/http.test.ts`, `test/listen.test.ts`, `test/tools.test.ts`, `test/tools-extra.test.ts`, `test/tools-resume.test.ts`, `test/config.test.ts`: tests against a stub daemon on a Unix socket and real loopback HTTP listeners.
- `test/helpers.ts`: the stub daemon, bridge launcher, and MCP call helpers those tests share.
- `docs/evidence/`: verbatim historical run logs. Do not edit them; `docs/evidence/README.md` explains what they are and which branch and commit each came from.

## Rules specific to this repo

- The daemon wire protocol is owned by TaskFerry (`src/protocol.js` there: `{version: 1, id, method, params}` requests, `{version: 1, ok, id, result | error}` replies). Check that file, not this repo's stub daemon, when the two disagree.
- Anything that touches a path from a caller must go through the allowlist and `realpathSync` checks in `src/scope.ts` and the tool modules. A new tool that forwards a caller-supplied directory or task ID needs a test that proves it is refused outside the allowed roots.
- Pinned versions are exact. `typescript` stays on 6.x for eslint while `typescript-native` (7.x) runs `tsc`; `npm run check:typescript-split` says when to merge them (`docs/things-that-look-like-bugs.md`). Use `npm run typecheck`, not `npx tsc`.
- Behavior a reader would call a bug but is deliberate goes in `docs/things-that-look-like-bugs.md` in the same change.
