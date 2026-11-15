# taskferry-mcp

HTTP MCP bridge to a local TaskFerry daemon. Validated once against a local TaskFerry daemon; not production-ready. Read `README.md` for the architecture and the open gaps, `docs/adr/` for why it is a separate repo.

## Commands

- `mise run check`: the full gate (prettier check, eslint, the TypeScript split check, `tsc --noEmit` on 7.x, unit tests). The global pre-commit hook runs it on every commit, so it must pass before a commit lands. CI runs the same steps separately.
- `mise run run`: start the bridge on its configured listener (a Unix socket by default; `node src/server.ts --listen-port 8787` for loopback TCP). Setting a gateway token also starts the gateway surface on port 8788 in the same process. Both need the `TASKFERRY_*` variables listed in the README.
- `npm run format` rewrites files; `format:check` only reports.

## Layout

- `src/server.ts`: HTTP layer (path, auth, method, content type, Host/Origin, MCP transport), both surfaces, and the CLI entry.
- `src/transport.ts`: the `/mcp` refusal order (path, auth, method, content type, Host/Origin) and the 401 challenge, including the optional OAuth bearer verifier.
- `src/oauth.ts`: the OAuth router (`createOAuth`): discovery documents, registration, and the `owns`/`handle`/`verify`/`challenge` interface the transport uses. Only the bridge surface gets it.
- `src/oauth-config.ts`: public URL, approval secret, redirect allowlist and state path resolution. OAuth is off without a public URL.
- `src/oauth-store.ts`: clients, pending sign-ins, codes, access and refresh tokens, rotation with reuse detection. Only refresh hashes and the clients they name reach disk.
- `src/oauth-authorize.ts`, `src/oauth-token.ts`: the consent page and decision, and the token and revocation endpoints.
- `src/oauth-clients.ts`, `src/oauth-scope.ts`, `src/oauth-limiter.ts`, `src/oauth-page.ts`, `src/oauth-http.ts`: registration validation, scope and resource matching, the global approval-failure limiter, consent HTML, and shared response helpers.
- `src/private-file.ts`: atomic 0600 write used by the event store and the OAuth store.
- `src/listen.ts`: Unix socket and loopback TCP listeners, including socket permissions and stale-socket replacement.
- `src/config.ts`: flag/env/config-file precedence, defaults, and surface validation.
- `src/config-primitives.ts`: shared precedence, env, path, port, and string coercion helpers.
- `src/gateway-config.ts`: gateway token/port resolution and the removed upstream-URL check.
- `src/token.ts`: bridge and gateway token resolution from an env var or a private file.
- `src/tools.ts`: the seven core tools, their strict schemas, and the dispatch allowlist checks.
- `src/tools-shared.ts`: shared tool scope, annotations, task-status helpers, and profile-aware bind resolution.
- `src/skills.ts`: the `worker` and `controller` skill profiles and their read-only bind paths.
- `src/tools-changeset.ts`: `taskferry_accept`, `taskferry_reject`, `taskferry_cancel`.
- `src/tools-resume.ts`: `taskferry_resume`, the session follow-up tool.
- `src/tools-message.ts`: `taskferry_message`, the confirmed full-message reader.
- `src/tools-worktree.ts`: `taskferry_worktree`, the scoped read-only file viewer.
- `src/tools-files.ts`: `taskferry_files`, the authenticated any-absolute-path read/list viewer on both the bridge and gateway surfaces; it deliberately bypasses the workspace allowlist, so keep it limited to reads.
- `src/tools-files-schema.ts`: the strict `taskferry_files` argument schema, including the raw-byte `pathBase64` alternative.
- `src/absolute-path.ts`: absolute-path validation, raw-byte decoding, and `realpath` resolution for the any-path viewer.
- `src/file-inspect.ts`: shared directory-entry and UTF-8-safe file-page helpers used by both viewers.
- `src/scope.ts`: allowed-root check for task directories.
- `src/daemon.ts`: Unix socket client for the TaskFerry protocol.
- `src/models.ts`: the `opencode models` catalog runner and its short-lived cache.
- `src/errors.ts`: shared `ConfigError` and errno `code` reader for filesystem errors.
- `test/oauth-store.test.ts`, `test/oauth-discovery.test.ts`, `test/oauth-flow.test.ts`, `test/oauth-sdk.test.ts`, `test/oauth-surfaces.test.ts`, `test/oauth-config.test.ts`, `test/http.test.ts`, `test/listen.test.ts`, `test/gateway.test.ts`, `test/surfaces.test.ts`, `test/tools.test.ts`, `test/tools-extra.test.ts`, `test/tools-files.test.ts`, `test/file-inspect.test.ts`, `test/tools-resume.test.ts`, `test/config.test.ts`, `test/scope.test.ts`, `test/skills.test.ts`: tests against a stub daemon on a Unix socket and real loopback HTTP listeners.
- `test/helpers.ts`: the stub daemon, bridge launcher, and MCP call helpers those tests share.
- `test/oauth-helpers.ts`: the OAuth fixture (a bridge with OAuth on, started through `startSurfaces`) and the PKCE, consent and token helpers the OAuth tests share.
- `docs/evidence/`: verbatim historical run logs. Do not edit them; `docs/evidence/README.md` explains what they are and which branch and commit each came from.

## Rules specific to this repo

- The daemon wire protocol is owned by TaskFerry (`src/protocol.js` there: `{version: 1, id, method, params}` requests, `{version: 1, ok, id, result | error}` replies). Check that file, not this repo's stub daemon, when the two disagree.
- Anything that touches a path from a caller must go through the allowlist and `realpathSync` checks in `src/scope.ts` and the tool modules, except the deliberate `taskferry_files` read/list surface. That tool serves any absolute path the MCP process OS user can read, for any authenticated MCP caller on either the bridge or gateway surface, and is documented in `README.md`; a gateway token is therefore host-read authority, including the bridge token file or process environment when readable. It must not gain write, dispatch, or bind behavior. Any other new tool that forwards a caller-supplied directory or task ID needs a test that proves it is refused outside the allowed roots.
- The OAuth endpoints are public by design and a grant is the same authority as the bridge token. Keep them unauthenticated only as far as the protocol needs, keep secrets and tokens out of logs, and add a test that fails when a new check is removed (the existing OAuth tests were mutation-probed that way).
- Pinned versions are exact. `typescript` stays on 6.x for eslint while `typescript-native` (7.x) runs `tsc`; `npm run check:typescript-split` says when to merge them (`docs/things-that-look-like-bugs.md`). Use `npm run typecheck`, not `npx tsc`.
- Behavior a reader would call a bug but is deliberate goes in `docs/things-that-look-like-bugs.md` in the same change.
