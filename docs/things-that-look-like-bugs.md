# Things that look like bugs but are not

Working-as-designed behavior a reader would reasonably file as broken. A real
bug goes in the issue tracker. When a later change restores the "obvious"
behavior, delete the entry.

## The bridge and gateway only accept loopback connections

**Observe:** with `--listen-port`, `curl http://<this-host's-LAN-or-tailnet-IP>:<port>/mcp`
is refused even with a valid token. In the default mode there is no TCP port at
all.

**Why:** the default listener is a Unix socket that only its owner can open
(`src/listen.ts`). TCP mode binds `127.0.0.1` and refuses any request whose
`Host` or `Origin` is not loopback (`src/server.ts`), which blocks DNS
rebinding and cross-site browser requests before the MCP layer runs.
`src/gateway.ts` also binds `127.0.0.1`. The README says never to expose the
listener directly; reaching it from elsewhere is the job of an authenticated
proxy in front.

**Becomes a bug if:** a bind-address option lets TCP mode bind a non-loopback
address, or the Host/Origin check is removed.

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
`src/tools.ts`, backed by `src/scope.ts`). Other daemon failures keep their own
message so an outage is not mistaken for a permissions problem. Both are
pinned by tests.

**Becomes a bug if:** the daemon renames the `UNKNOWN_TASK` code. Unknown IDs
then leak the daemon's wording again. The tests cannot catch that: the stub
daemon's code is copied from the daemon's source, not read from a live one.

## Tool failures come back as HTTP 200

**Observe:** a rejected tool call (bad arguments, denied directory, daemon
error) returns status 200 with `result.isError: true`, not a 4xx.

**Why:** MCP reports tool errors inside the JSON-RPC result so the model can
read them. HTTP status is reserved for transport problems: 400 malformed JSON,
401 bad token, 403 foreign Host or Origin in TCP mode, 404 wrong path, 405
non-POST, 413 body over 1 MiB, 415 non-JSON.

**Becomes a bug if:** a transport-level failure (bad token, malformed body) is
ever reported with 200.

## A dead socket file at the listen path is deleted on startup

**Observe:** starting the bridge removes an existing `mcp.sock` before binding
it.

**Why:** `socketIsLive` connects to the path. `ECONNREFUSED` or `ENOENT` means
a dead process left the file behind, so `listenBridge` unlinks it. A path that
is not a socket is refused and never deleted, and a live listener is refused
with "already in use" (`src/listen.ts`).

**Becomes a bug if:** a non-socket file disappears, or a second instance
displaces a running one.

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

## A read-only bind lands at the same path, not a path the caller chooses

**Observe:** `roBind: ["/host/credential.json"]` exposes that file at
`/host/credential.json` inside the task sandbox. There is no bridge argument
for mounting it at a different path.

**Why:** the bridge forwards `roBind` to TaskFerry's `task.dispatch`, whose
entries are host paths bound read-only at the same path. The bridge resolves
and allowlists the source; destination remapping is not part of the daemon
surface it can reach. A caller that needs the file at another path has to get
it there some other way.

**Becomes a bug if:** the daemon starts accepting `source:destination` pairs
and the bridge still refuses or drops them.

## `taskferry_message` withholds the full message until `confirm: true`

**Observe:** calling `taskferry_message` with only a `taskId` returns
`messageChars` and a 500-character preview, not the message. Sending `offset`
and `limit` alone changes nothing.

**Why:** a large final message can dominate a client's context before anyone
decides it is worth reading. The preview keeps that bounded, and `confirm: true`
is the explicit second call that returns the full text or a page. Ignoring
`offset`/`limit` without confirmation stops paging from becoming a way around
the gate. `taskferry_result` still returns the full `message`, so the gate is
about the dedicated read path, not a security boundary.

**Becomes a bug if:** the preview is empty for a non-empty message, or
`confirm: true` still truncates without reporting `truncated` and `nextOffset`.

## `taskferry_worktree` refuses a symlink that points outside the task

**Observe:** a symlink inside the dispatch directory that points at a file
elsewhere is listed as `symlink` but reading it fails with "path denied:
outside the task directory", even though the link itself is inside.

**Why:** the requested path is resolved with `realpathSync` before any read, so
the containment check sees the target, not the link. The opened descriptor's
real path is checked again after `open` to close the swap race. A caller that
needs the target must have it inside the allowed workspace.

**Becomes a bug if:** a file whose real path is genuinely inside the task
directory is refused because an intermediate symlink was used.

## `taskferry_accept` has no `force` argument

**Observe:** `taskferry_accept` with `force: true` is rejected by the strict
schema, while the daemon's own `task.accept` method accepts a `force` flag.

**Why:** forcing past a failed check gate is a host-side decision that needs a
person to inspect the diff. The bridge leaves that out of the remote surface
on purpose; the daemon remains able to do it locally.

**Becomes a bug if:** a legitimate accept through MCP needs `force` to complete,
which means a check gate is failing and hiding the real problem.

## A worktree file read stops at 256 KiB by default

**Observe:** `taskferry_worktree` returns `truncated: true` for a file larger
than 256 KiB even though the tool accepts `maxBytes` up to 1 MiB.

**Why:** the default keeps an accidental large-file read from consuming the
caller's context. Paging with `offset` and `maxBytes` reads the rest; the 1 MiB
hard cap bounds a single response.

**Becomes a bug if:** a file smaller than `maxBytes` comes back truncated, or
the reported `nextOffset` skips bytes.

## Resume refuses a running source task

**Observe:** `taskferry_resume` fails with "task is still running" even though
TaskFerry's CLI accepts `--session-id` for a task that has not settled.

**Why:** resuming a live session would put two workers on one conversation, and
the source task's overlay is still open. The bridge waits for a settled source
task. The daemon CLI stays permissive for host-side use.

**Becomes a bug if:** a settled task is refused, or a resume is blocked after
the source task has ended but before its record updates.
