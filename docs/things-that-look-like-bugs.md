# Things that look like bugs but are not

Working-as-designed behavior a reader would reasonably file as broken. A real
bug goes in the issue tracker. When a later change restores the "obvious"
behavior, delete the entry.

## The bridge and gateway only accept loopback connections

**Observe:** `curl http://<this-host's-LAN-or-tailnet-IP>:8787/mcp` is refused
even with a valid token.

**Why:** both entry points call `listen(port, '127.0.0.1')`
(`src/server.ts`, `src/gateway.ts`). The README says never to expose the
listener directly; reaching it from elsewhere is the job of an authenticated
proxy in front.

**Becomes a bug if:** a deployment guide tells people to reach the bridge
directly, or a bind-address option is added without Host/Origin checks (there
are none today).

## Dispatch returns an error until both allowlists are set

**Observe:** `taskferry_dispatch` fails with "dispatch disabled until
allowlists configured" on a bridge that otherwise works.

**Why:** dispatch needs both `TASKFERRY_ALLOWED_DIRECTORIES` and
`TASKFERRY_ALLOWED_MODELS`. The bridge refuses to forward a write-capable call
without them. The test `dispatch fails closed without configured allowlists`
pins it.

**Becomes a bug if:** the error is raised even though both variables are set
(check for a trailing separator: directories split on `:`, models on `,`).

## A task in a deleted or unresolvable directory is "not accessible"

**Observe:** `taskferry_status` or `taskferry_result` fails with "task not
accessible" for a task that exists, after its working directory was removed or
renamed.

**Why:** the scope guard resolves the task's directory with `realpath` and
checks it sits under an allowed root. If the path cannot be resolved the guard
fails closed instead of guessing.

**Becomes a bug if:** a live task in an allowed directory is refused. That
points at a symlink or root-resolution problem, not at the intended case.

## A mistyped task ID says "task not accessible"

**Observe:** `taskferry_status` for an ID that was never issued fails with
"task not accessible", the same text as for a task in another workspace.

**Why:** the daemon's own "unknown task id" error would let a caller probe
which IDs exist outside their allowed directories. The scope guard maps the
daemon's `UNKNOWN_TASK` code to the generic message (`inScopeStatus` in
`src/server.ts`). Other daemon failures keep their own message so an outage is
not mistaken for a permissions problem. Both are pinned by tests.

**Becomes a bug if:** the daemon renames the `UNKNOWN_TASK` code. Unknown IDs
then leak the daemon's wording again. The tests cannot catch that: the stub
daemon's code is copied from the daemon's source, not read from a live one.

## Tool failures come back as HTTP 200

**Observe:** a rejected tool call (bad arguments, denied directory, daemon
error) returns status 200 with `result.isError: true`, not a 4xx.

**Why:** MCP reports tool errors inside the JSON-RPC result so the model can
read them. HTTP status is reserved for transport problems: 401 bad token, 404
wrong path, 405 non-POST, 415 non-JSON, 400 malformed JSON-RPC.

**Becomes a bug if:** a transport-level failure (bad token, malformed body) is
ever reported with 200.

## Two TypeScript versions are installed

**Observe:** `package.json` lists `typescript` 6.0.3 and `typescript-native`
(an npm alias for `typescript@7.0.2`). `node_modules/.bin/tsc` is whichever
package npm linked last, so `npx tsc` may run either. `npm run typecheck`
calls the 7.x binary by path.

**Why:** `typescript-eslint` 8.72.0 declares the peer range
`typescript >=4.8.4 <6.1.0`, and eslint loads the TypeScript API from the
`typescript` package, so `typescript` stays on 6.0.3. The native 7.x compiler
has a different API but a working `tsc`, so type checking uses it. A planted
type error fails under both compilers.
`scripts/check-typescript-split.mjs` (run by `npm run check`) fails when
`typescript-eslint` starts accepting 7.x, or when `typescript` drifts outside
its range, and tells you which half to undo.

**Becomes a bug if:** you run `npx tsc` and trust it as the project's type
check, or the split check is removed from `check`.
