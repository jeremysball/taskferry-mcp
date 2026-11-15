# TaskFerry MCP Bridge

**Status:** working prototype, validated against a local TaskFerry daemon. The suite runs against a stub daemon and real loopback listeners; a live pass covered the task tools, including one real dispatch and its result. MCP Events webhook support is covered against a stub callback receiver and the official protocol shapes; a real ChatGPT callback has **not** been delivered to this bridge yet. It is not production-ready and has not been run behind a real Sites client.

## Architecture

MCP client -> authenticated `POST /mcp` -> this bridge -> TaskFerry's private Unix-domain socket. The optional gateway surface is a second authenticated entry point in the same process.

One Node process serves both surfaces. The bridge listens on its configured Unix socket or loopback TCP port and authenticates with the MCP token. When a gateway token is configured, the same process also listens on loopback TCP 8788 and authenticates with that separate token. The gateway surface is not a proxy: it serves the same tools from the same code path, so there is no upstream URL, second HTTP hop, or separately deployed forwarder to drift out of date.

The bridge is TypeScript run directly by Node's native type stripping, so there is no build step. Node is pinned to 26.5.1 in `.mise.toml`. The MCP side uses the official SDK. Modern `2026-07-28` requests are served by the SDK entry point, which provides `server/discover` and the per-request envelope checks. Legacy `2025-era` requests keep the original stateless path: each request gets a fresh `McpServer` connected to a `NodeStreamableHTTPServerTransport` that answers with JSON. There are no sessions and no SSE stream on either path.

## Tools

Fourteen tools. Eleven are hard-wired to one daemon method; `taskferry_models`
runs the local `opencode models` command, and `taskferry_worktree` and
`taskferry_files` read the filesystem directly. A caller cannot name a daemon
method directly.

| Tool                 | Source            | Notes                                                                               |
| -------------------- | ----------------- | ----------------------------------------------------------------------------------- |
| `taskferry_health`   | `system.health`   |                                                                                     |
| `taskferry_list`     | `task.list`       | All allowed workspaces by default; optional directory or all                        |
| `taskferry_models`   | `opencode models` | Allowed ids, missing allowlist entries, optional query                              |
| `taskferry_status`   | `task.status`     | Scope-guarded; full lifecycle fields                                                |
| `taskferry_result`   | `task.result`     | Scope-guarded; optional `fields` and `full`                                         |
| `taskferry_message`  | `task.result`     | Scope-guarded; final message, preview until `confirm: true`                         |
| `taskferry_summary`  | `task.summary`    | Scope-guarded; queues a summary task                                                |
| `taskferry_dispatch` | `task.dispatch`   | Needs both allowlists; optional `executor`, `variant`, `roBind`, `noSandbox`        |
| `taskferry_resume`   | `task.dispatch`   | Continues a settled task's session; derives workspace/model/executor                |
| `taskferry_accept`   | `task.accept`     | Scope-guarded; applies a pending changeset                                          |
| `taskferry_reject`   | `task.reject`     | Scope-guarded; refuses and discards a pending changeset                             |
| `taskferry_cancel`   | `task.cancel`     | Scope-guarded; optional `graceMs`                                                   |
| `taskferry_worktree` | local filesystem  | Read-only view inside the task dispatch directory                                   |
| `taskferry_files`    | local filesystem  | Read-only list/read at any absolute path the service user can access; both surfaces |

## Run tests

`mise run check` runs the full gate: format check, lint, the TypeScript split check, `tsc --noEmit`, and 250 tests. CI runs the same steps. `npm test` runs only the tests.

The tests start a real stub daemon on a Unix socket and real HTTP listeners on loopback. Two mutation probes are kept in the evidence directory: disabling the scope guard fails the cross-workspace test, and loosening the socket mode fails the permissions test.

## Run the bridge

By default the bridge listens on a Unix socket at `$XDG_RUNTIME_DIR/taskferry-mcp/mcp.sock`, created with mode 0600 inside a 0700 directory. The daemon socket defaults to `$TASKFERRY_RUNTIME_DIR/daemon.sock`, falling back to `$XDG_RUNTIME_DIR/taskferry/daemon.sock`.

```
export TASKFERRY_MCP_TOKEN='replace-with-random-secret'
export TASKFERRY_RUNTIME_DIR='/run/user/1000/taskferry'
export TASKFERRY_ALLOWED_DIRECTORIES='/path/to/repo'
export TASKFERRY_ALLOWED_MODELS='provider/model'
export TASKFERRY_ALLOWED_RO_BINDS='/path/to/credential.json'
npm start
```

Each setting resolves as flag, then environment variable, then config-file key, then default.

| Flag                        | Environment                             | Config key              | Default                                     |
| --------------------------- | --------------------------------------- | ----------------------- | ------------------------------------------- |
| `--daemon-socket`           | `TASKFERRY_SOCKET_PATH`                 | `daemonSocket`          | `$TASKFERRY_RUNTIME_DIR/daemon.sock`        |
| `--allowed-directories`     | `TASKFERRY_ALLOWED_DIRECTORIES`         | `allowedDirectories`    | none                                        |
| `--allowed-models`          | `TASKFERRY_ALLOWED_MODELS`              | `allowedModels`         | none                                        |
| `--allowed-ro-binds`        | `TASKFERRY_ALLOWED_RO_BINDS`            | `allowedRoBinds`        | none                                        |
| `--skill-profile`           | `TASKFERRY_MCP_SKILL_PROFILE`           | `skillProfile`          | `worker`                                    |
| `--skill-root`              | `TASKFERRY_MCP_SKILL_ROOT`              | `skillRoot`             | `~/.claude`                                 |
| `--server-ro-binds`         | `TASKFERRY_MCP_SERVER_RO_BINDS`         | `serverRoBinds`         | none                                        |
| `--events-state`            | `TASKFERRY_MCP_EVENTS_STATE`            | `eventsStatePath`       | `$XDG_STATE_HOME/taskferry-mcp/events.json` |
| `--listen-socket`           | `TASKFERRY_MCP_LISTEN_SOCKET`           | `listenSocket`          | `$XDG_RUNTIME_DIR/taskferry-mcp/mcp.sock`   |
| `--listen-port`             | `TASKFERRY_MCP_LISTEN_PORT`             | `listenPort`            | none                                        |
| `--token-file`              | `TASKFERRY_MCP_TOKEN_FILE`              | `tokenFile`             | none                                        |
| `--gateway-port`            | `TASKFERRY_GATEWAY_PORT`                | `gatewayPort`           | `8788`                                      |
| `--gateway-token-file`      | `TASKFERRY_GATEWAY_TOKEN_FILE`          | `gatewayTokenFile`      | none                                        |
| `--public-url`              | `TASKFERRY_MCP_PUBLIC_URL`              | `publicUrl`             | none (OAuth off)                            |
| `--oauth-secret-file`       | `TASKFERRY_MCP_OAUTH_SECRET_FILE`       | `oauthSecretFile`       | none                                        |
| `--oauth-allowed-redirects` | `TASKFERRY_MCP_OAUTH_ALLOWED_REDIRECTS` | `oauthAllowedRedirects` | Claude callbacks plus loopback              |
| `--oauth-state`             | `TASKFERRY_MCP_OAUTH_STATE`             | `oauthStatePath`        | `$XDG_STATE_HOME/taskferry-mcp/oauth.json`  |
| `--daemon-timeout-ms`       | `TASKFERRY_MCP_DAEMON_TIMEOUT_MS`       | `daemonTimeoutMs`       | `5000`                                      |
| `--summary-timeout-ms`      | `TASKFERRY_MCP_SUMMARY_TIMEOUT_MS`      | `summaryTimeoutMs`      | `60000`                                     |
| `--list-timeout-ms`         | `TASKFERRY_MCP_LIST_TIMEOUT_MS`         | `listTimeoutMs`         | `15000`                                     |
| `--models-cache-ttl-ms`     | `TASKFERRY_MCP_MODELS_CACHE_TTL_MS`     | `modelsCacheTtlMs`      | `60000`                                     |
| `--preview-chars`           | `TASKFERRY_MCP_PREVIEW_CHARS`           | `previewChars`          | `500`                                       |

`--config` and `TASKFERRY_MCP_CONFIG` name a config file; the default is `$XDG_CONFIG_HOME/taskferry-mcp/config.json`. Directory lists split on `:`, model lists on `,`, and caller and server bind lists on `:`.

The timeout and preview knobs bound a slow call and a large response. `daemonTimeoutMs` is the per-call daemon socket timeout; `summaryTimeoutMs` is the longer budget for `task.summary`, which can synchronously wait for a summarizer child; `listTimeoutMs` bounds the `opencode models` catalog command; `modelsCacheTtlMs` is how long that catalog is cached; `previewChars` is the unconfirmed `taskferry_message` preview length. Every other daemon call defaults to `daemonTimeoutMs`, including `task.status` and `task.result`; `task.accept` and `task.reject` deliberately use six times it to outlast the check gate.

The bridge bearer token comes from `TASKFERRY_MCP_TOKEN` or a token file, never both. The gateway token comes from `TASKFERRY_GATEWAY_TOKEN` or `TASKFERRY_GATEWAY_TOKEN_FILE`; configuring one enables the gateway surface. A token file must not be readable by group or others, and an empty one is refused. A token set but blank is a configuration error, not a disabled surface. The bridge and gateway tokens must differ. Tokens are not flags or config keys, because both leak through `ps`, backups, and diffs.

Both surfaces require the exact `Bearer <token>` authorization form: a bare token or any other scheme is refused with 401 at the HTTP layer. Each surface accepts only its own token. The gateway applies the loopback `Host`/`Origin` checks unconditionally, as the bridge does in TCP mode, and both answer every request, refusals included, with `Cache-Control: no-store`.

For a client that only speaks HTTP, use a loopback TCP port:

```
node src/server.ts --listen-port 8787
```

TCP mode binds `127.0.0.1` and refuses any request whose `Host` or `Origin` is not loopback, even with a valid token. Do not expose this listener directly. TLS and external reachability belong to a proxy or tunnel in front of it. With a static token only, that proxy should add its own authentication; with OAuth on (next section), the proxy must not, because the OAuth endpoints have to be reachable by clients that hold no credential yet.

## Gateway surface

The gateway surface starts in the bridge process whenever a gateway token is set:

```
export TASKFERRY_MCP_TOKEN='replace-with-random-secret'
export TASKFERRY_GATEWAY_TOKEN='separate-secret'
npm start
```

It listens on loopback TCP 8788 by default (`--gateway-port`, `TASKFERRY_GATEWAY_PORT`, or `gatewayPort` changes it) and serves the same tools with the gateway token instead of the MCP token. That includes `taskferry_files`: a gateway token can read every host path the service user can read, including the bridge token file or process environment if either is readable, so the tokens are distinct HTTP credentials but not separate filesystem principals. The bridge token is refused there, and the gateway token is refused on the bridge listener. The two tokens must differ, and the gateway port must differ from the bridge's TCP port. Like the bridge's TCP mode, it binds `127.0.0.1` only and refuses non-loopback `Host` or `Origin`; reaching it from elsewhere is the job of an authenticated proxy. Setting a gateway port without a token is a configuration error rather than an unauthenticated listener. The old standalone gateway's `TASKFERRY_UPSTREAM_URL` and `PORT` variables are not read; a leftover `TASKFERRY_UPSTREAM_URL` is a configuration error, and the port comes only from the knobs above. The surface is not separately deployable: a Sites-native handler and a real deployment still need the Sites runtime and API.

## OAuth for remote clients

A remote MCP client such as a claude.ai custom connector signs in with OAuth instead of a pasted token. When a public URL is configured, the bridge also acts as a small single-owner OAuth 2.1 authorization server: the MCP endpoint stays the resource server, and one person (you) approves each client by typing a secret into a consent page. There is no external identity provider and no user database. The static bearer token keeps working beside it.

```
export TASKFERRY_MCP_TOKEN='replace-with-random-secret'
export TASKFERRY_MCP_PUBLIC_URL='https://mcp.example.com'
export TASKFERRY_MCP_OAUTH_SECRET="$(openssl rand -base64 32)"   # or TASKFERRY_MCP_OAUTH_SECRET_FILE
node src/server.ts --listen-port 8787
```

`TASKFERRY_MCP_PUBLIC_URL` is the bare `https` origin clients use, with no path; the MCP endpoint is always `<origin>/mcp`, and tokens are bound to that exact URL. `http` is accepted only for a loopback host, for local testing. The approval secret is at least 24 characters, must differ from the bridge and gateway tokens, and comes from the variable or a private file, never a flag or config key. Any OAuth setting without a public URL is a configuration error.

**Reachability.** The client's servers, not your browser, fetch the discovery documents, register, and redeem codes, so the public URL must reach this listener from the internet. Put a TLS-terminating tunnel or reverse proxy in front of the loopback port and forward the path and public `Host` unchanged. The loopback `Host` check accepts that public hostname (hostname only, scheme and port ignored) and nothing else. Do not put another authentication layer in front of `/mcp`, `/oauth/*` or `/.well-known/*`: the client cannot satisfy it. If you firewall by source address, Anthropic documents the address range its connector traffic comes from; check their current connector documentation rather than this file.

**Adding it to a client.** In claude.ai, add a custom connector with the URL `https://mcp.example.com/mcp` and leave any client ID and secret blank; the client registers itself. For Claude Code, add an HTTP MCP server with that URL and authenticate from its `/mcp` menu. Either way the client opens the consent page in your browser; check the client name and the host shown, then enter the approval secret. Both of these client flows are written from the vendor documentation and are **not verified against the real products**; see Limitations.

| Endpoint                                      | Purpose                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `/.well-known/oauth-protected-resource[/mcp]` | RFC 9728 metadata; `resource` equals `<origin>/mcp`                    |
| `/.well-known/oauth-authorization-server`     | RFC 8414 metadata; S256 only, public clients only, `iss` supported     |
| `/oauth/register`                             | RFC 7591 dynamic registration, redirect URIs checked against allowlist |
| `/oauth/authorize`                            | Consent page (GET) and decision (POST)                                 |
| `/oauth/token`                                | `authorization_code` and `refresh_token` grants, form-encoded          |
| `/oauth/revoke`                               | RFC 7009 revocation                                                    |

An unauthenticated `POST /mcp` returns 401 with `WWW-Authenticate: Bearer resource_metadata="..."`, which is how clients find the rest. Without OAuth configured none of these paths exist and the 401 is the plain `Bearer` it always was. The OAuth endpoints are served on the bridge surface only; the gateway surface has no OAuth and refuses OAuth tokens.

**Lifetimes.** Authorization codes last 60 seconds and work once. Access tokens last one hour and live in memory only. Refresh tokens last 30 days and rotate on every use; presenting an already-used refresh token, or replaying a spent code, revokes every token descended from that sign-in. The state file (`oauth.json`, mode 0600 in a 0700 directory) holds SHA-256 hashes of refresh tokens and the clients they belong to, never a token or the approval secret. A restart drops access tokens and pending sign-ins; clients refresh without asking you again. To revoke everything, stop the bridge and delete the state file.

**Redirect allowlist.** A client can only register redirect URIs that match the allowlist. The default is Claude's two callback URLs plus loopback HTTP on any port and path, which is what Claude Code uses. `--oauth-allowed-redirects` replaces the list: a comma-separated set of exact `https` URLs, plus the keyword `loopback`. Another MCP client has to be added here on purpose. An empty value counts as unset and restores the default.

**What a grant is worth.** There is one scope, `taskferry`, and it is the whole tool surface: the same authority as the bridge token, including dispatch within the allowlists and the host-wide `taskferry_files` read. Approve only a client you started yourself, just now; the consent page says so. Approval is a single factor (the secret) given to whoever can start a flow, so a convincing link sent to you is the realistic attack: an attacker's client registers, you are talked into approving it, and its code goes to the redirect it registered. The allowlist limits where a code can go, not who started the flow. Wrong secrets are rate-limited globally (10 failures in 10 minutes, then 429 for everyone, denial still works), because behind a tunnel every request shares one source address.

## MCP Events webhooks

The bridge advertises the MCP Events capability (`events: {}`) and implements `server/discover`, `events/list`, `events/subscribe`, and `events/unsubscribe` on both surfaces. The wire shape follows OpenAI's MCP Events documentation for protocol `2026-07-28`; see [the OpenAI integration guide](https://developers.openai.com/plugins/build/mcp-events). Modern requests must carry the per-request `_meta` envelope (`io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`) plus the `MCP-Protocol-Version` and `Mcp-Method` headers; name-bearing methods also need `Mcp-Name`. Older 2025-era requests without that envelope still work through the legacy path; their `initialize` result also contains the `events` capability key, which unknown-capability clients may ignore.

Three events are exposed, and only these:

| Event            | TaskFerry status     |
| ---------------- | -------------------- |
| `task.completed` | `done`               |
| `task.failed`    | `crashed`, `unknown` |
| `task.cancelled` | `cancelled`          |

TaskFerry has no input-needed state, so the bridge does not advertise an input-needed event. The optional `arguments.directory` filter limits a subscription to one workspace subtree. `arguments.all: true` explicitly requests every configured allowed workspace, which is also the default when `directory` is omitted; `all` and `directory` cannot be combined, and `all: false` is treated as omitted. Either way, the bridge checks each event's directory against the configured workspace allowlist before delivery. `delivery` is `{ "mode": "webhook", "url": "https://...", "secret": "whsec_..." }`; `ttlMs` defaults to seven days, and `null` means no expiry.

A subscription is stored only after the callback endpoint proves control of the URL. The bridge sends a Standard Webhooks-signed `{"type":"verification","challenge":"..."}` request and requires the exact challenge back; failures return JSON-RPC `-32015` with a categorized `data.reason`. OpenAI's current guide uses `-32015` (`CallbackEndpointError`); the newer MCP events draft uses `-32027`, so a future client may report that difference. Verification succeeds before any subscription is persisted or activated.

Callbacks must be HTTPS on a public IP address. The bridge resolves DNS, rejects private, loopback, link-local, documentation and reserved addresses (including IPv4-embedded IPv6), pins the checked address for the request, and does not follow redirects. Callback URLs, secrets, and bodies are never logged. Event requests carry `webhook-id`, `webhook-timestamp`, and `webhook-signature` Standard Webhooks headers over the exact JSON body, plus `X-MCP-Subscription-Id`. The body has `eventId`, `timestamp`, `name`, `data` (`taskId`, `status`, `directory`, `previousStatus`, `occurredAt`), and `cursor: null`.

Subscriptions survive a restart in a private JSON state file (`0600`, parent `0700`, atomic replace), up to 1000 entries. A process-wide monitor keeps one `event.subscribe({ all: true })` connection to the daemon and reconnects with capped exponential backoff. Delivery is per-subscription FIFO with five attempts (500 ms base, up to 8 s), treating 408, 425, 429, 5xx and transport errors as retryable, and 410, 413, other 4xx and malformed responses as terminal. A per-subscription event-ID window suppresses duplicate daemon frames, and `eventId` is derived from task, sequence, status and `occurredAt`, so a replayed transition collapses. There is no replay after a daemon disconnect or bridge restart: TaskFerry's event protocol has no cursor, and the bridge does not invent one.

`eventsStatePath` (`--events-state`, `TASKFERRY_MCP_EVENTS_STATE`, or config key `eventsStatePath`) defaults to `$XDG_STATE_HOME/taskferry-mcp/events.json` (or `~/.local/state/taskferry-mcp/events.json`).

**Verified vs. not verified:** the capability advertisement, discovery, subscribe/unsubscribe, verification failure mapping, lifecycle mapping, SSRF rules, signing, persistence, retries and deduplication are covered by this repository's tests against a stub callback receiver and a stub daemon. ChatGPT has not actually delivered an event to this bridge in testing, and this bridge has no public callback-reachable endpoint of its own; a deployment must provide that reachability. Treat ChatGPT-side registration and delivery as unverified until a real end-to-end callback is observed.

## Scope guard

`taskferry_status`, `taskferry_result` and `taskferry_summary` read `task.status` and check the canonical `directory` against the allowed roots before they return status, request result content or queue a summary. A missing or unresolvable directory fails closed. The root check is `inAllowedRoot` in `src/scope.ts`; the scoped status read is `inScopeStatus` in `src/tools-shared.ts`.

`taskferry_list` without a directory asks the daemon for its newest 500 tasks through the existing `task.list {}` all-workspaces request and filters the rows through the same allowed roots. Passing a directory scopes the list to that workspace, which must itself be under an allowed root. `all: true` is the explicit form of the default fleet-wide request and cannot be combined with `directory`; `all: false` is treated as omitted.

An unknown task ID and an out-of-scope one both answer "task not accessible", which keeps a caller from probing IDs outside its roots. A live pass confirmed that mapping against the running daemon.

`taskferry_result` accepts `fields` to select result fields and `full` to return the complete narration. `taskferry_summary` wraps `task.summary`. `mode: "report"` (the default) queues a summarizer and returns a queued summary task in `summaryTask`; the caller polls `taskferry_status` and reads `taskferry_result` against that id. `mode: "activity"` returns the activity snapshot directly, but it is not a free cache read: the daemon force-refreshes and can synchronously launch and wait for a summarizer child, so it may take tens of seconds, and a stale-session continuation retry can poll a second child. The bridge gives `task.summary` the `summaryTimeoutMs` budget (60 seconds by default) rather than the ordinary 5 second daemon timeout.

`taskferry_models` shells out to `opencode models` and caches the result for 60 seconds (`modelsCacheTtlMs`). Without a query it returns the allowlisted model ids only. With a query it searches the full installed catalog and marks each match as allowed or not. `missingAllowedModels` names allowlisted ids that are not installed, which catches an OpenCode allowlist typo before a dispatch fails. The allowlist is executor-agnostic and the catalog command is always OpenCode, even when a dispatch selects Kilo; all three executors take the same `provider/model` id, so a Kilo-only model still has to be added to the allowlist by hand and `missingAllowedModels` is advisory for it.

`taskferry_dispatch` accepts an optional `executor` of `opencode`, `pi`, or `kilo`. It forwards the value to the daemon as `executor`; when omitted, the bridge omits the field too and the daemon uses its configured default. An unknown value is rejected at the tool boundary before any daemon call. The model id is sent through unchanged in `provider/model` form, which is the shape Kilo's `--model` takes, so an existing model allowlist works across executors.

`taskferry_dispatch` also accepts an optional `variant` string for the model reasoning level, for example `low`, `high`, `xhigh`, `max`, or `highest`; it forwards the value to the daemon as `variant` and omits it when unset. A denied request says whether the workspace or the model failed and includes the allowed models.

`taskferry_dispatch` also accepts an optional `roBind` array of absolute host paths. Each path is resolved with `realpathSync` and must be on the read-only bind allowlist, either as the exact file or under an allowed directory. The bridge forwards the resolved paths to the daemon as `roBind`, which mounts each one read-only at the same path inside the task sandbox. There is no read-write bind surface.

`taskferry_dispatch` also accepts an optional `noSandbox` boolean, `false` by default. It maps to TaskFerry's per-dispatch `noSandbox` field, the protocol field behind `taskferry dispatch --no-sandbox`. The bridge forwards explicit `true` or `false` and omits the field when the argument is absent, so the daemon keeps its existing default. `noSandbox: true` removes filesystem isolation for that task: the worker runs directly on the host filesystem, writes land on real host paths, and no copy-on-write overlay or `accept`/`reject` gate protects the target directory. That is broader than `noOverlay`, which only removes the overlay and leaves the bwrap sandbox in place. An explicit `false` (or omission) selects the normal path, but it cannot re-enable sandboxing if the daemon has sandboxing disabled globally. The directory, model, and read-only bind allowlists are checked before forwarding; they limit what the bridge will dispatch, not what an unsandboxed worker can read or write on the host after launch.

## Skill profiles

`skillProfile` fixes which Claude skills every dispatch and resume mounts read-only:

- `none` mounts no skill paths.
- `worker` (default) mounts the two default search skills.
- `controller` mounts the skill, fleet-skill, and plugin-cache roots, which lets the fleet-skill symlinks resolve.

The authoritative root lists live in `src/skills.ts`. Every path is resolved and must exist; a missing root fails the dispatch with `server bind unavailable: <path>` instead of silently mounting less. Roots are joined under `skillRoot` (`--skill-root`, `TASKFERRY_MCP_SKILL_ROOT`, or `skillRoot` in the config file; default `~/.claude`). `serverRoBinds` (`--server-ro-binds`, `TASKFERRY_MCP_SERVER_RO_BINDS`, or `serverRoBinds`) adds extra operator-owned roots to every dispatch and resume.

Profile and server binds are server-owned, so they skip the caller `roBind` allowlist; a caller-supplied `roBind` still goes through it. When a mounted path is on the daemon's sandbox deny list, as the default `~/.claude` is, every launch logs one deny-list-override warning to the daemon log; the mount is read-only and adds no write path. See `docs/things-that-look-like-bugs.md`.

## Resume

`taskferry_resume` takes a settled task id and a follow-up prompt, then queues a
new task in that task's existing session. The workspace, model, session id and
executor come from the source task, not from the caller, so a resume cannot
move a session into a different workspace or model than the bridge would have
allowed directly, or select an executor other than the one the task recorded.
Workspace and model still pass the bridge allowlists; the executor must be one
of `opencode`, `pi` or `kilo`. A recorded `executorId` is forwarded, so a Kilo
session resumes on Kilo even when the daemon default is OpenCode. A modern
daemon backfills legacy records to `opencode`; if a status has no
`executorId` at all, the bridge omits it and keeps the older daemon-default or
session-inheritance behavior. The source task must have a session and must not
be queued or running. Accepts the same optional `variant` and `roBind`
arguments as dispatch.

## Changesets

`taskferry_accept` applies a task's pending changeset to its workspace.
`taskferry_reject` refuses the same changeset and discards its overlay without
touching the workspace. Both run the `task.status` scope check first, so a task
outside the allowed roots is refused before the write. Accept deliberately has
no `force` argument: a blocking check gate has to be fixed forward on the host,
where a person can inspect the diff.

`taskferry_cancel` removes a queued task before launch, or sends SIGTERM to a
running task and escalates to SIGKILL after `graceMs` (the daemon default when
omitted). Cancelling a settled task is a no-op with an explanatory note.

## Read-only worktree view

`taskferry_worktree` takes a task id and an optional relative `path`. With no
path it lists the dispatch directory; a directory path lists that directory; a
file path returns its text. Every path is resolved with `realpathSync` and must
stay inside the task directory, so `..`, absolute paths, and symlinks pointing
outside are refused. A file read returns at most 256 KiB by default; pass
`offset` and `maxBytes` to page by byte offset. `offset` has no upper cap, and
a truncated page reports `nextOffset`. A page never ends inside a UTF-8
character, and an offset inside one starts the page at that character with a
note. The response reports `offset`, `bytesRead`, and `truncated`. Zero-size
virtual files are read directly and flagged with `sizeUnknown`. Bytes that are
not UTF-8 text come back with `binary: true` and no content. Directory
listings are capped at 500 rows and are not paged, so a byte offset has no
meaning there.

## Any-path read/list view

`taskferry_files` takes an absolute `path` (or `pathBase64`, the raw bytes of
that path) and either lists a directory or reads a regular file. It is deliberately **not** task-scoped and does **not**
use the workspace allowlist: the tool needs no task id, works when the
allowlist is empty, and serves any path the MCP process OS user can access.
Both authenticated MCP surfaces expose it, the bridge and the gateway.
Authentication on either surface is the only bridge boundary, and ordinary
filesystem permissions still apply. Symlinks are resolved to their target, so
a link may point anywhere the service user can reach.

A directory listing is sorted by name and paged with `after` (the last entry
name from the previous page, exclusive) and `maxEntries` (default and maximum
500); the response reports `total`, `returned`, `truncated`, and `nextAfter`.
`offset` is file-only. Each page scans the directory once to keep exact name
order and the exact `total`, so a very large directory costs time proportional
to its entry count per page; the response itself stays bounded. Entry names
are decoded as UTF-8 strings, so a name containing invalid UTF-8 bytes cannot
be represented losslessly; such an entry carries `nameBase64`, and a page
boundary on one reports `nextAfterBase64` instead of `nextAfter`. Pass that as
`afterBase64` to continue without skipping or repeating a sibling whose decoded
name collides. `nextAfterBase64` is reported alongside `nextAfter` whenever a
page is truncated, so a client can always page by raw bytes. A path whose own
name is not valid UTF-8 is addressable too: pass `pathBase64` with the raw
absolute path bytes instead of `path`, and the same listing bytes that produce
`nameBase64` become a readable path.

A file read pages by byte `offset` and `maxBytes` (256 KiB default, 1 MiB
maximum) and reports `bytesRead`, `truncated`, and `nextOffset`. There is no
upper offset cap. A page never ends inside a UTF-8 character; if `maxBytes` is
smaller than the next character, the page includes that whole character and
can exceed `maxBytes` by up to 3 bytes. An explicit offset that lands inside a
character starts the page at that character and adds a note, rather than
silently skipping bytes. Binary files return `binary: true` with no content,
and non-regular files (devices, FIFOs, sockets) return `kind: "other"` with
metadata only, including a magic fd link such as `/proc/self/fd/1`. A short
read before the planned window is treated as EOF even when the stat size is
larger, which covers sysfs attributes that report a page-sized placeholder. A
descriptor that rejects offset reads is retried from its start (at most 4 MiB
into the file) and served as a slice, so seekless procfs entries page with a
small `maxBytes`. Errors distinguish a missing path, a permission denial, a
symlink loop, and a non-directory path.

A gateway token is therefore host-read authority, not a narrower credential.
The gateway token holder can read every path the service user can read,
including a bridge token file or the process environment if either is readable.
The two tokens remain distinct at the HTTP layer and each surface rejects the
other's token, but they are not separate filesystem principals. Expose the
gateway only to a client you would also trust with the bridge token.

Pending overlay files are readable by their actual host paths, without
applying them. `taskferry_status` reports `overlayDirs` (`root`, `upperDir`,
`workDir`, and any per-bind overlay directories) while a changeset is pending.
Pass `overlayDirs.upperDir` or a path beneath it to `taskferry_files` to read
the pending copy; the workspace is untouched until `taskferry_accept` runs, and
`taskferry_files` never calls the daemon or applies a changeset.

This is intentionally broader than `taskferry_worktree`, which stays confined
to a task's dispatch directory. The other write, dispatch, resume, changeset,
message, result, and bind paths keep their existing allowlists.

## Full final message

`taskferry_message` reads only the final `message` field, without the daemon's
2000-character narration preview cap. The first call without `confirm: true`
returns `messageChars` and a 500-character preview, which keeps a large message
out of the client's context until the caller explicitly asks for it. With
`confirm: true` it returns the whole message, or a page when `offset` and
`limit` are set (both counted in characters). `nextOffset` names the next
character offset when more remains. A
non-confirmed call ignores `offset` and `limit`, so paging cannot be used to
walk the full message without confirming.

## Limitations / next gates

- Real TaskFerry integration live passes cover health, list, status, result, message, worktree, summary, dispatch, and dispatched-task results. Changeset accept/reject and cancel are unit-tested against the stub only, because a live call would mutate a real workspace. Resume is covered by unit tests and a live pass that recalled a codeword from the source session. Queue behavior under load, concurrent clients, non-default executors, and very long summaries are still untested. Dispatch stays disabled until both allowlists are set, and read-only binds stay disabled until the bind allowlist is set.
- MCP compatibility is verified against the official SDK client and raw JSON-RPC over HTTP. The bridge answers with JSON only, so a client that requires SSE or sessions will fail.
- The suite has 250 cases (one skipped) and does not cover the B01-B18 matrix from the design plan, which is not in this repo.
- MCP Events are tested against a stub callback receiver, not a real ChatGPT registration or delivery. The bridge also exposes no public callback endpoint itself, so deployment reachability and OpenAI-side verification remain open gates. TaskFerry events have no replay, so a bridge restart or daemon disconnect loses the events in the gap by design.
- Dispatch has no durable idempotency. Do not retry an ambiguous failure automatically.
- OAuth is verified against the official MCP SDK client (discovery, registration, PKCE, the redirect with `iss`, token exchange, refresh) and raw HTTP tests, not against claude.ai, Claude Code or any other real client. Client ID Metadata Documents, per-tool scopes, a login through an external identity provider, a refresh retry grace window and per-source rate limiting are not implemented. Anyone who can reach the public URL can register up to 100 pending clients, which blocks further registrations for up to an hour; limit that at the tunnel.
- `taskferry_files` is intentionally host-wide on both authenticated surfaces for the MCP process OS user: authentication and filesystem permissions are its only boundaries. A gateway token carries the same host-read authority as the bridge token, including the bridge token file or process environment when the service user can read it; the tokens are not separate filesystem principals. Do not expose either surface to a principal that should not read the host. The other tools keep their workspace, model, and bind allowlists.
- `taskferry_files` resolves and stats a path before opening it, so a component replaced in between can open a different target; `O_NOFOLLOW` pins only the final component, and the reported `path` comes from `/proc/self/fd` or `/dev/fd` when available, falling back to the pre-open resolution. Binary detection is per page, so a page of valid UTF-8 without NUL bytes reads as text even when the rest of the file is binary. For zero-size virtual files an EOF probe decides `truncated`, and a failed probe conservatively reports `truncated: true`. A short read before the planned window is EOF even when the stat size is larger (sysfs pads `st_size` to a page), and a descriptor that rejects offset reads is retried sequentially with a 4 MiB cap. A path whose name is not valid UTF-8 is reachable by passing `pathBase64` with the raw absolute path bytes; `path` and `pathBase64` are mutually exclusive. A directory page scans every entry to keep exact name order and total, so its work grows with the directory size even though the response is bounded; entry names with invalid UTF-8 bytes are decoded lossily for `name`, but their raw bytes remain reachable through `nameBase64` and `nextAfterBase64` / `afterBase64`.
- The gateway surface is part of the bridge process, not a prototype forwarder. A Sites-native handler and a real deployment still need the Sites runtime and API.
- Validate input schemas, HTTP limits, authentication, dispatch restrictions, CSRF and origin posture, audit logging, secret rotation, and response truncation before production.

## Evidence

`docs/evidence/` holds verbatim logs from named points in the project's history. `docs/evidence/README.md` records the branch and commit behind each capture, and why their absolute host paths are left as recorded. These are historical captures, not the current suite state; run `mise run check` for today's tree.

- `docs/evidence/2026-10-20-prototype-v2/`: the prototype's first test loop.
  - `red.log`: initial module-missing test failure. It does not count as assertion-based RED.
  - `green.log`: five passing mock tests after the fixture allowlist was fixed.
  - `mutation.log`: a change to daemon method forwarding failed one test, then was reverted.
  - `scope-red.log`, `scope-green.log`, `scope-mutation.log`, `scope-final.log`: the same sequence for the scope guard.
- `docs/evidence/2026-10-21-sdk-transport/`: the SDK-transport refactor's captures, including the full gate at that commit (`check.log`, 37 cases), two mutation probes (`mutation-scope.log`, `mutation-socket-mode.log`), a CLI smoke run (`smoke.log`), and a live daemon pass (`real-daemon.log`) covering the task tools and one dispatch (`oc_mvi1xlws_1804d533`) that returned `MCP_REAL_DISPATCH_OK`.
