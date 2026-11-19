# Things that look like bugs but are not

Working-as-designed behavior a reader would reasonably file as broken. A real
bug goes in the issue tracker. When a later change restores the "obvious"
behavior, delete the entry.

## Timed-out CIMD DNS lookups can keep metadata capacity unavailable

**Observe:** CIMD host lookups can be refused even after earlier lookup requests
timed out.

**Why:** the resolver admits at most two underlying CIMD system lookups.
Webhook lookups remain uncapped, as before. Both classes still share libuv's
getaddrinfo worker pool, so CIMD admission limits do not guarantee execution-resource
isolation for webhooks.
A timeout cannot cancel one, so its slot remains occupied until it settles.
If lookups remain stuck permanently, capacity remains unavailable; this is the
tradeoff required to bound outstanding system work.

**Becomes a bug if:** a slot stays occupied after its underlying lookup settles,
or more than two underlying CIMD lookups are admitted at once.

## A small CIMD document can exceed the compression limits

**Observe:** a metadata document below the 5 KB final body limit is refused if
it uses more than three content encodings or an intermediate decoding stage
exceeds 5 KB.

**Why:** each decoding layer consumes resources before the final document is
checked. The stage count and intermediate limits bound that work for responses
from untrusted hosts (`src/oauth-cimd.ts`).

**Becomes a bug if:** a response within those limits is rejected by these checks,
or a decoding stage can exceed its limit without being rejected.

## A CIMD hostname can be refused before DNS

**Observe:** a metadata URL with a single-label hostname or a `.test` or
`.invalid` suffix is refused even if a local resolver could return a public
address for it.

**Why:** the pinned transport shares the webhook's conservative hostname check
before resolving and validating every DNS answer (`src/webhook.ts`).

**Becomes a bug if:** an ordinary fully qualified public hostname is rejected by
this name check, or a refused hostname reaches the connection step.

## The bridge and gateway only accept loopback connections

**Observe:** with `--listen-port`, `curl http://<this-host's-LAN-or-tailnet-IP>:<port>/mcp`
is refused even with a valid token. In the default mode there is no TCP port at
all.

**Why:** the default listener is a Unix socket that only its owner can open
(`src/listen.ts`). TCP mode binds `127.0.0.1` and refuses any request whose
`Host` or `Origin` is not loopback (`src/server.ts`), which blocks DNS
rebinding and cross-site browser requests before the MCP layer runs.
The gateway surface in `src/server.ts` also binds `127.0.0.1` only. The README
says never to expose the listener directly; reaching it from elsewhere is the
job of an authenticated proxy in front.

**Becomes a bug if:** a bind-address option lets TCP mode bind a non-loopback
address, or the Host/Origin check is removed.

## The gateway returns one buffered JSON body, not an event stream

**Observe:** a client that asks for `text/event-stream`, or that waits for
progress notifications during a long tool call, receives nothing until the
daemon call finishes, then a single JSON body.

**Why:** the gateway surface is not a proxy. It applies its own token and
loopback guard, then runs the same stateless request handler as the bridge,
which answers JSON only (`enableJsonResponse: true` in `src/server.ts`). There
is no path for a chunked event stream on either surface. A deployment that
needs server-initiated messages needs a streaming MCP transport, which this
server does not implement.

**Becomes a bug if:** a client's tool call depends on a notification that must
arrive before the HTTP response ends.

## The gateway accepts clients that omit the MCP dual Accept header

**Observe:** a request to the gateway surface with `Accept: */*`, or with no
`Accept` header, succeeds, while the same request to the bridge returns `406`.

**Why:** the standalone gateway always sent `Accept: application/json,
text/event-stream` upstream, so clients that never learned the dual-header
requirement kept working. The joined gateway rewrites `req.headers.accept` to
that same value before the MCP handler runs (`src/server.ts`). The bridge keeps
strict MCP negotiation because it is the public contract clients should use.

**Becomes a bug if:** the normalization starts accepting content types the MCP
handler cannot return, or it is applied to the bridge too.

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
`src/tools-shared.ts`; the root check it calls is `inAllowedRoot` in
`src/scope.ts`). Other daemon failures keep their own
message so an outage is not mistaken for a permissions problem. Both are
pinned by tests.

**Becomes a bug if:** the daemon renames the `UNKNOWN_TASK` code. Unknown IDs
then leak the daemon's wording again. The tests cannot catch that: the stub
daemon's code is copied from the daemon's source, not read from a live one.

## `taskferry_list` counts only the rows the caller can see

**Observe:** `taskferry_list` without a directory reports `counts` that add up
to fewer tasks than the daemon holds, and the missing ones are absent from
`tasks` too.

**Why:** `visibleList` in `src/tools.ts` filters the daemon's rows through the
workspace allowlist (`isVisibleRow`) before `countStatuses` runs, so `counts`
and `tasks` describe the same visible set. Counting foreign rows would disclose
how many tasks exist in workspaces the bridge is not configured for, which is
the existence leak the scope guard refuses everywhere else. The daemon's 500-row
cap applies before the filter, so the `note` field reports when older rows may
be missing.

**Becomes a bug if:** `counts` disagrees with the `tasks` array, or a count
reveals a workspace outside the allowlist.

## An empty workspace is a string sentinel, not an empty array

**Observe:** the daemon's raw `task.list` result for an allowed workspace with
no tasks has `tasks: "none found in this workspace"`, a string. `taskferry_list`
returns `tasks: []`.

**Why:** the daemon uses the string as a CLI presentation sentinel. The bridge
normalizes the two known sentinels (`none found in this workspace` and
`none found (this server process's lifetime)`) to an empty array in
`taskListResult` in `src/tools.ts`. Returning the string would violate the
tool's array contract and abort the single all-workspaces response before its
rows are filtered through the allowed roots.

**Becomes a bug if:** a new sentinel string appears and the bridge fails closed
instead of treating that response as empty, or a malformed `tasks` value is
accepted as empty. The daemon caps an all-workspaces response at its newest 500
rows, so a busy foreign workspace can push older allowed-workspace rows out;
that deliberately matches CLI `list --all` and is reported by the row-cap note.

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

## Skill-profile and server binds bypass the caller `roBind` allowlist

**Observe:** `taskferry_dispatch` and `taskferry_resume` mount `~/.claude/skills/...`
even when `allowedRoBinds` is empty, while a caller-supplied `roBind` is refused in
the same configuration. With the default skill root the daemon also logs a
deny-list-override warning on every launch, because `~/.claude` is on its sandbox deny
list.

**Why:** profile paths are derived at runtime from the operator-configured
`skillRoot` (default `~/.claude`) and `serverRoBinds`, not from caller input. The
allowlist exists to constrain what a caller can request, so these server-owned paths
skip it. They still go through the same resolver as caller paths: absolute check,
`realpath`, and an existence check, so a missing root fails the dispatch instead of
silently mounting less. A caller-supplied `roBind` still must pass `resolveRoBinds`
and the configured allowlist. The deny-list warning is deliberate: the operator asked
for a read-only view of a masked directory, and the daemon says so rather than
silently dropping the mount.

**Becomes a bug if:** a path derived from a tool argument reaches the daemon without
the allowlist check, changing `skillProfile` lets a caller choose the mounted
directories, or a missing server-owned root is silently dropped instead of failing
the dispatch.

## A newly enabled model is missing for up to a minute

**Observe:** a model installed or enabled in OpenCode just now does not appear
in `taskferry_models`, and a dispatch naming it is refused as not allowed,
although `opencode models` lists it.

**Why:** `listOpencodeModels` caches the catalog for 60 seconds (`CACHE_TTL_MS`
in `src/models.ts`) and a bridge process is long-lived. The cache is per
process, so a restart clears it immediately.
`TASKFERRY_MCP_MODELS_CACHE_TTL_MS` (flag `--models-cache-ttl-ms`, config key
`modelsCacheTtlMs`, see the README) lowers the window for a host whose catalog
changes often. `missingAllowedModels` comes from the same cached read, so it
reports the same staleness.

**Becomes a bug if:** the model is still missing after the TTL expires and the
bridge has been restarted. That points at the allowlist or the catalog command,
not at the cache.

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

## `taskferry_message` pages after the daemon sends the whole field

**Observe:** a confirmed page of a large message with `offset` and `limit`
still makes the daemon send the entire message over its socket; only the text
that reaches the client is trimmed.

**Why:** the daemon's `task.result` has no byte-range parameter, so the bridge
asks for `fields: ["message"]` and slices the string itself
(`src/tools-message.ts`). Paging bounds the client's context and the MCP
response size, not the daemon read. `taskferry_result` with
`fields: ["message"]` has the same property.

**Becomes a bug if:** the daemon gains a range or streaming parameter and the
bridge keeps pulling the whole field.

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

## `taskferry_files` reads outside every allowed workspace

**Observe:** an authenticated caller on either the bridge or gateway surface
can list and read `/etc` or any other absolute path through `taskferry_files`,
even when `--allowed-directories` is empty or names an unrelated workspace.
`taskferry_worktree` refuses the same path. A gateway token holder can also
read a bridge token file or the process environment when the service user can
read it.

**Why:** this is a direct host-inspection surface for the MCP service user, not
a task view. Authentication on either surface is the boundary and the service
user's filesystem permissions still apply; adding the workspace allowlist would
defeat the requested capability. The two tokens stay distinct at the HTTP layer
but are not separate filesystem principals. The tool is read-only, and every
other path-taking tool keeps its allowlist.

**Becomes a bug if:** the tool gains a write path, becomes reachable without
authentication, or an allowlist check makes it silently task-scoped again.
An entry name that is not valid UTF-8 is decoded with U+FFFD for display, so
two such names share a `name`; a directory page still keeps them distinct by
reporting `nameBase64` and continuing with `nextAfterBase64` / `afterBase64`.
The same raw bytes make that entry addressable as a path: pass `pathBase64`
with the full absolute path instead of `path`. That UX is deliberate: the
plain name remains readable, and the raw cursor is the exact one. It becomes a
bug if a page boundary omits `nextAfterBase64` and one invalid-name sibling is
unreachable, if a path visible in a listing cannot be opened by `pathBase64`,
or if `after` silently re-reads an already returned sibling forever.

## `taskferry_files` trusts a short read over a pseudo-file's stat size

**Observe:** `/sys/class/net/lo/mtu` reports `size: 4096` but only six bytes
are readable; `taskferry_files` returns those bytes with `truncated: false`
and no `nextOffset`, instead of a continuation that fails on the next call.

**Why:** sysfs attributes use `st_size` as a page-sized buffer hint, not the
content length. `readWindow` treats a read that stops before the planned window
as EOF, because a short read is the only reliable end-of-content signal. A page
that still has bytes in the window but stops at `maxBytes` stays
`truncated: true`, so ordinary file paging is unchanged.

**Becomes a bug if:** a regular file whose content grows past its stat size
loses the tail, or a page that stops at `maxBytes` reports `truncated: false`.

## `taskferry_files` re-reads a seekless pseudo-file from the start

**Observe:** `/proc/uptime` at `offset: 4` with a small `maxBytes` succeeds even
though a read at offset 4 returns zero bytes.

**Why:** some procfs attributes implement only sequential reads. When an offset
read returns nothing, `readWindow` retries from the descriptor's current
position (still zero because prior reads were positional) and discards the
prefix, capped at 4 MiB. Without this, the second page failed with a misleading
"file changed while reading" error.

**Becomes a bug if:** the fallback hides a real truncation race on a regular
file, or an offset beyond the 4 MiB cap silently returns wrong bytes instead of
the existing retry error.

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
`offset` plus the reported `bytesRead` skips bytes. A truncated page reports
`nextOffset`; with `offset: 0` and a leading partial character that differs
from `bytesRead`, so advance by `nextOffset` rather than adding `bytesRead`.
Directory listings are not byte slices at all; they cap at 500 entries and
report `truncated`.

## Message pages count characters; worktree pages count bytes

**Observe:** `nextOffset` from `taskferry_message` advances by characters
(UTF-16 code units), while a worktree file read pages by `offset` and
`maxBytes` and reports `bytesRead`; the same number means different things in
the two tools.

**Why:** the message path is a text preview and slices the decoded string
(`message.slice(offset, end)` in `src/tools-message.ts`), so a caller paging
text never splits a character. The worktree path is a file slice
(`readPage` and `readWindow` in `src/file-inspect.ts`, called by
`src/tools-worktree.ts`) and never decodes the rest of the file, so byte
offsets are the only useful unit. A worktree directory listing is not paged at
all: it caps at 500 entries and reports `truncated`, so there is no offset to
continue from. `taskferry_files` does page directories, with `after` /
`nextAfter` (names) or `afterBase64` / `nextAfterBase64` (raw bytes).

**Becomes a bug if:** one tool starts reporting the other's unit under the same
field name.

## Events do not include input-needed or a replay cursor

**Observe:** `events/list` returns only `task.completed`, `task.failed` and `task.cancelled`; every delivery has `cursor: null`, and events emitted while the daemon socket was down never arrive.

**Why:** TaskFerry's daemon has no input-needed state, so advertising `task.input_needed` would promise an event the bridge can never emit. Its `event.subscribe` protocol also has no cursor or replay: a reconnect starts a fresh subscription and the gap is genuinely lost. The bridge exposes exactly the terminal states the daemon emits and derives a stable `eventId` so duplicate live frames collapse, but it does not invent a history.

**Becomes a bug if:** the daemon gains an input-needed state or a replay cursor and the bridge keeps hiding it, or a retry after a disconnect silently claims delivery of a missed event.

## A failed task and an unknown task share `task.failed`

**Observe:** both a `crashed` task and a task whose status became `unknown` produce `task.failed`, with the raw status only inside `data.status`.

**Why:** the public event names are a small, stable lifecycle vocabulary, not a mirror of every daemon status. `crashed` and `unknown` are both non-success terminal outcomes, so one failure event keeps subscribers from needing to enumerate daemon internals. The exact status remains in the payload.

**Becomes a bug if:** a caller cannot tell a failure from a success, or a new non-success terminal status is silently dropped instead of mapped.

## Re-subscribing to the same callback does not re-challenge it

**Observe:** calling `events/subscribe` twice with the same event, URL, arguments and secret returns the same `sub_...` id and sends no second verification request. The same identity with a different secret does re-verify.

**Why:** subscription identity is `(principal, normalized URL, event name, canonical arguments)`, and successful verification is cached for five minutes per principal, URL and secret hash. Repeating an idempotent subscribe must not spam the callback or rotate the subscription. Changing the secret rotates the signing key, so the endpoint must prove control again before the bridge stores it.

**Becomes a bug if:** a changed URL or secret reuses the old verification, or an unrelated caller gets the same subscription id.

## A callback on a private address is refused even if it is reachable

**Observe:** `events/subscribe` refuses `https://127.0.0.1/...`, `https://10.x/...`, link-local, documentation and reserved addresses, and any hostname with even one non-public DNS answer, with JSON-RPC `-32015` and no outbound request.

**Why:** the callback URL comes from a remote caller, so delivery is an SSRF primitive. The bridge requires HTTPS, resolves and checks every address, pins the checked address for the connection, and disables redirects. A deployment that needs an internal receiver must expose a public HTTPS endpoint in front of it; the bridge does not add a private-address exception.

**Becomes a bug if:** a public hostname with one private AAAA record is accepted, a redirect is followed, or a URL/secret appears in a log line.

## `server/discover` only appears on the modern path

**Observe:** a hand-built POST to `server/discover` with no `_meta` envelope returns `-32601 Method not found`, while the same call with the `2026-07-28` envelope and standard headers succeeds.

**Why:** the SDK classifies a request without the per-request envelope claim as legacy, and TaskFerry's legacy 2025-era dialect has no `server/discover`. Modern clients, including ChatGPT, send the envelope and headers. The bridge deliberately keeps one routing decision instead of answering modern discovery on a legacy connection, so the response cannot advertise a protocol the caller is not speaking.

**Becomes a bug if:** a correctly enveloped discover request is routed legacy, or the legacy `initialize` response starts advertising `2026-07-28`.

## Resume refuses a running source task

**Observe:** `taskferry_resume` fails with "task is still running" even though
TaskFerry's CLI accepts `--session-id` for a task that has not settled.

**Why:** resuming a live session would put two workers on one conversation, and
the source task's overlay is still open. The bridge waits for a settled source
task. The daemon CLI stays permissive for host-side use.

**Becomes a bug if:** a settled task is refused, or a resume is blocked after
the source task has ended but before its record updates.

## Wrong approval secrets lock approval for everyone for ten minutes

**Observe:** after ten wrong secrets on the consent page, even the right secret gets a 429 with `Retry-After`, and the owner is locked out along with whoever guessed. Pressing Deny still works.

**Why:** the limiter is global, not per client or per address. Behind a tunnel every request arrives from one source address, so a per-address limit would limit nothing, and the approval secret is the only thing between an internet-reachable consent page and a full tool grant. The cost is that anyone who can register a client and open its consent page can keep the owner from approving for the length of the window. Denial never needs the secret so the lockout cannot trap a pending request open.

**Becomes a bug if:** a wrong guess is not counted, the right secret is accepted while locked, or Deny starts requiring the secret.

## Registering a client can fail with 503 although nothing is wrong

**Observe:** `POST /oauth/register` returns `503 temporarily_unavailable` after about a hundred registrations, and a client that never completed approval stops existing after an hour.

**Why:** registration is unauthenticated by design, because a client has no credential before it signs in. Unapproved registrations are held in memory only, capped at 100, and dropped after an hour, so an anonymous caller can neither grow the state file nor hold slots forever. A registration becomes durable only when a refresh token names it. The cap can still be filled by a caller who wants to block new sign-ins for up to an hour; per-source limits belong at the tunnel.

**Becomes a bug if:** unapproved clients reach `oauth.json`, or approved clients are dropped while their refresh token is live.

## A restart makes clients refresh, and a sign-in in flight fails

**Observe:** after the bridge restarts, the first MCP call from a connected client gets a 401 and then succeeds on its own. A consent page left open across the restart answers "expired or already used".

**Why:** access tokens, authorization codes and pending sign-ins live in memory; only refresh-token hashes and their clients are written to disk. A client that holds a refresh token recovers without asking the owner again. Persisting access tokens would put live bearer credentials in a file for no gain.

**Becomes a bug if:** a client with a valid refresh token is asked to re-approve after a restart, or an access token survives one.

## A lost refresh response forces a new approval

**Observe:** if a client's refresh succeeded on the server but the response never arrived, its retry is refused with `invalid_grant` and every token from that sign-in stops working. The owner has to approve again.

**Why:** refresh tokens rotate, and presenting an already-used one is treated as theft: the whole family is revoked. There is no grace window in which a retry is tolerated. For one owner, re-approving is cheap and a stolen refresh token is not, so the strict rule was chosen. A short grace window would be the fix if this turns out to happen in practice.

**Becomes a bug if:** a first, correct use of a refresh token is refused, or a replay is accepted.

## `/mcp` challenges with `resource_metadata` only when OAuth is configured

**Observe:** the same unauthenticated request gets `WWW-Authenticate: Bearer` on one deployment and `Bearer resource_metadata="..."` on another, and the second adds `error="invalid_token"` when a bad token was sent.

**Why:** the metadata URL is how an OAuth client finds the authorization server, and a deployment without a public URL has none to point at. A request with no credential gets the bare challenge; one with a rejected credential also gets the RFC 6750 error. The gateway surface never advertises OAuth, because it has none.

**Becomes a bug if:** the challenge names a metadata URL on a deployment with OAuth off, or omits it with OAuth on.

## The static bearer token skips the consent page

**Observe:** with OAuth enabled, `Authorization: Bearer <TASKFERRY_MCP_TOKEN>` still opens `/mcp` with no sign-in, no expiry and no revocation.

**Why:** OAuth is an additional way in, not a replacement, so existing local clients and scripts keep working. The static token was always the same authority as a grant. Retiring it is a deployment choice, not something the bridge does.

**Becomes a bug if:** an OAuth access token carries more authority than the static token, or the static token is accepted on the OAuth endpoints as a credential.

## The scope parameter is accepted but grants nothing extra

**Observe:** a client that requests `taskferry offline_access` or nothing at all gets the same grant, with `scope: taskferry`. An unknown scope is refused with `invalid_scope`.

**Why:** there is one real scope and it is the whole tool surface, the same authority as the bridge token. `offline_access` is accepted beside `taskferry` because Claude adds it when the server lists it, and a refresh token is always issued anyway. A request naming only `offline_access` is refused with `invalid_scope`, because granting `taskferry` would hand out a scope the client never asked for. Per-tool scopes would be a new design, not a bug fix.

**Becomes a bug if:** a client can obtain a scope that was not requested, or a refresh can widen the granted scope.

## Revoking an OAuth client does not remove its event subscriptions

**Observe:** after `/oauth/revoke` or a family revocation, webhook subscriptions the client created with `events/subscribe` keep delivering.

**Why:** subscriptions belong to the surface principal (`bridge`), not to a token, so they are shared by every caller on that surface, including the static token. Their life is governed by their own unsubscribe and expiry, as before OAuth existed.

**Becomes a bug if:** a subscription becomes visible to or removable by a caller on the other surface, or outlives its own expiry.

## The loopback guard accepts the public hostname, matching on hostname alone

**Observe:** in TCP mode, a request whose `Host` is `127.0.0.1` or the configured public hostname passes, whatever its scheme or port, and `Origin` is checked the same way.

**Why:** a tunnel forwards the public `Host` to the loopback listener, so refusing it would make the deployment unreachable. The SDK helpers compare hostnames only. Every other hostname is still refused with 403, including on the OAuth endpoints, and the public hostname is accepted only when OAuth is configured.

**Becomes a bug if:** any other hostname passes, the public hostname passes with OAuth off, or an OAuth endpoint skips the guard.

## An empty redirect allowlist restores the default instead of allowing nothing

**Observe:** `TASKFERRY_MCP_OAUTH_ALLOWED_REDIRECTS=` (empty) leaves Claude's callbacks and loopback allowed.

**Why:** an empty environment variable counts as unset for every setting in this bridge. The default list is the narrow one, so the fallback fails safe. To allow only one client, name its callback.

**Becomes a bug if:** an empty value widens the list beyond the default, or a malformed non-empty value is ignored instead of refused.

## A client metadata document is trusted until its cache lifetime expires

**Observe:** after a client changes the redirect URIs or `client_name` in its metadata document, the bridge keeps using the old values for up to an hour, and a document the server cannot fetch is retried on every request.

**Why:** the document is fetched on demand and cached for its `Cache-Control` lifetime, clamped to 60 seconds to 1 hour with a 5-minute default, so a hot client costs one fetch rather than one per request. Refusals are not cached, because an outage should not outlast its cause. `no-cache`, `no-store`, a zero `max-age` and a malformed `max-age` all mean the document is not reused, so a revalidation directive is never silently upgraded into a five-minute trust window. The allowlist still decides every redirect destination, so a stale document can only narrow what the client may use.

**Becomes a bug if:** the cache outlives an hour, or a rejected request still redirects to a URI the current document does not list.

## A client metadata URL on a private-network name is refused even if it is reachable

**Observe:** registering a client whose `client_id` is an `https` URL on a literal private address such as `https://10.0.0.5/client.json`, or on a `localhost`/`.local`/`.internal`/`.home.arpa` name, is refused; a URL over plain `http` is refused too.

**Why:** the bridge fetches the document from its own network position, so an unrestricted URL is a server-side request forgery primitive. The bridge rejects literal addresses and local names, checks all DNS answers, and pins the connection to a public answer.

**Becomes a bug if:** a refused URL is fetched anyway, or the guard is applied to the client's own redirect destinations instead of the metadata URL.

## The oldest access token or spent code is forgotten at the cap

**Observe:** past 1000 live access tokens or 1000 remembered spent codes, the oldest entry is evicted silently. A replayed code that was evicted is refused as unknown rather than revoking its family.

**Why:** the cap bounds memory for a single-owner server whose clients are few; a sign-in older than a thousand tokens or codes is not a live attack signal, and the replay is still refused. Refresh-token rotation at the cap reclaims an older rotated record for room; when every slot holds a live grant, the rotation is refused with a retryable 503 and the presented token stays valid, so its own replay marker is never the record that gets dropped.

**Becomes a bug if:** eviction makes a valid, current token stop working, or a replay of a code that is still inside the cap is accepted.

## The `client_id` is shown as a hostname on the consent page

**Observe:** the consent page for a Client ID Metadata Document client shows only the URL's host, not its full path, and the page never fetches the document a second time.

**Why:** the host is the part the owner can read and compare; the path is kept to validate the document against the URL and to check redirects, not to display. The document was already fetched and validated to reach this page.

**Becomes a bug if:** two different client URLs on one host are shown identically in a way that changes what the owner is approving.

## Token and revocation requests never re-fetch client metadata

**Observe:** after a Client ID Metadata Document client signs in, token exchange, refresh and `/oauth/revoke` keep working while the document's host is down or the document has been withdrawn. A `client_id` that is URL-shaped is accepted on its form alone at those endpoints.

**Why:** the authorization code or refresh record already binds the client it was issued to, and a revocation that depends on the reported attacker's host staying reachable is not a revocation. Refusing an unrecognized plain `client_id` still returns `invalid_client`, and a URL-shaped id that does not match the stored grant is refused as `invalid_grant`. Only the authorize endpoint needs the document, for the redirect list and the consent page.

**Becomes a bug if:** a token request mints a token for a client the grant does not name, or revocation stops working for a registered client.

## A burst of distinct metadata documents is refused past a fixed in-flight cap

**Observe:** with 20 metadata fetches already in flight, a 21st distinct client id is treated as an unknown client until one finishes. Repeated requests for the same id share a single fetch.

**Why:** the cache bounds completed documents but not concurrent outbound requests, and anyone who can reach the authorize endpoint can name new ids. Fetching 20 at a time bounds sockets and memory; the refusal is a safe error, and a retry after a slot frees up fetches normally.

**Becomes a bug if:** the cap rejects a client whose document is already cached, or requests for one id open more than one connection at a time.

## Every IP literal is refused as a metadata host, including a public one

**Observe:** `https://8.8.8.8/client.json` is refused even though the address is public, while the same document on a hostname is fetched.

**Why:** the guard refuses all IP literals rather than trying to classify private ranges. That removes the IPv6 bracket-normalization trap that let bracketed literals through, and a metadata document is expected to live at a stable named URL. DNS answers are checked separately before connecting.

**Becomes a bug if:** a URL-shaped client id with a hostname is refused for being an address, or a bracketed IPv6 literal reaches the fetcher.
