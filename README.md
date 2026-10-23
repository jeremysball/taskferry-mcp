# TaskFerry MCP Bridge

**Status:** working prototype, validated against a local TaskFerry daemon. The suite runs against a stub daemon and real loopback listeners; a live pass covered the task tools, including one real dispatch and its result. It is not production-ready and has not been run behind a real Sites client.

## Architecture

Sites MCP client -> Sites-compatible forwarding service (the deployment adapter is still unwritten) -> authenticated `POST /mcp` -> this bridge -> TaskFerry's private Unix-domain socket.

The bridge is TypeScript run directly by Node's native type stripping, so there is no build step. Node is pinned to 26.5.1 in `.mise.toml`. The MCP side uses the official SDK: each request gets a fresh stateless `McpServer` connected to a `NodeStreamableHTTPServerTransport` that answers with JSON. There are no sessions and no SSE stream.

## Tools

Twelve tools. Ten are hard-wired to one daemon method; `taskferry_models`
runs the local `opencode models` command, and `taskferry_worktree` reads the
task's dispatch directory locally. A caller cannot name a daemon method
directly.

| Tool                 | Source            | Notes                                                       |
| -------------------- | ----------------- | ----------------------------------------------------------- |
| `taskferry_health`   | `system.health`   |                                                             |
| `taskferry_list`     | `task.list`       | All allowed workspaces by default; optional directory       |
| `taskferry_models`   | `opencode models` | Allowed ids, missing allowlist entries, optional query      |
| `taskferry_status`   | `task.status`     | Scope-guarded; full lifecycle fields                        |
| `taskferry_result`   | `task.result`     | Scope-guarded; optional `fields` and `full`                 |
| `taskferry_message`  | `task.result`     | Scope-guarded; final message, preview until `confirm: true` |
| `taskferry_summary`  | `task.summary`    | Scope-guarded; queues a summary task                        |
| `taskferry_dispatch` | `task.dispatch`   | Needs both allowlists; optional `variant` and `roBind`      |
| `taskferry_accept`   | `task.accept`     | Scope-guarded; applies a pending changeset                  |
| `taskferry_reject`   | `task.reject`     | Scope-guarded; refuses and discards a pending changeset     |
| `taskferry_cancel`   | `task.cancel`     | Scope-guarded; optional `graceMs`                           |
| `taskferry_worktree` | local filesystem  | Read-only view inside the task dispatch directory           |

## Run tests

`mise run check` runs the full gate: format check, lint, the TypeScript split check, `tsc --noEmit`, and 48 unit tests. CI runs the same steps. `npm test` runs only the tests.

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

| Flag                    | Environment                     | Config key           | Default                                   |
| ----------------------- | ------------------------------- | -------------------- | ----------------------------------------- |
| `--daemon-socket`       | `TASKFERRY_SOCKET_PATH`         | `daemonSocket`       | `$TASKFERRY_RUNTIME_DIR/daemon.sock`      |
| `--allowed-directories` | `TASKFERRY_ALLOWED_DIRECTORIES` | `allowedDirectories` | none                                      |
| `--allowed-models`      | `TASKFERRY_ALLOWED_MODELS`      | `allowedModels`      | none                                      |
| `--allowed-ro-binds`    | `TASKFERRY_ALLOWED_RO_BINDS`    | `allowedRoBinds`     | none                                      |
| `--listen-socket`       | `TASKFERRY_MCP_LISTEN_SOCKET`   | `listenSocket`       | `$XDG_RUNTIME_DIR/taskferry-mcp/mcp.sock` |
| `--listen-port`         | `TASKFERRY_MCP_LISTEN_PORT`     | `listenPort`         | none                                      |
| `--token-file`          | `TASKFERRY_MCP_TOKEN_FILE`      | `tokenFile`          | none                                      |

`--config` and `TASKFERRY_MCP_CONFIG` name a config file; the default is `$XDG_CONFIG_HOME/taskferry-mcp/config.json`. Directory lists split on `:`, model lists on `,`, and read-only bind lists on `:`.

The bearer token comes from `TASKFERRY_MCP_TOKEN` or a token file, never both. A token file must not be readable by group or others, and the bridge refuses an empty one. The token is not a flag or a config key, because both leak through `ps`, backups, and diffs.

For a client that only speaks HTTP, use a loopback TCP port:

```
node src/server.ts --listen-port 8787
```

TCP mode binds `127.0.0.1` and refuses any request whose `Host` or `Origin` is not loopback, even with a valid token. Do not expose this listener directly. TLS and external reachability belong to an authenticated proxy.

## Gateway demonstration

```
export TASKFERRY_UPSTREAM_URL='http://127.0.0.1:8787/mcp'
export TASKFERRY_GATEWAY_TOKEN='separate-secret'
export TASKFERRY_MCP_TOKEN='replace-with-random-secret'
npm run gateway
```

`gateway.ts` forwards one configured `/mcp` endpoint with separate inbound and upstream tokens, and listens on port 8788 by default. It is a reference implementation. Sites support for this runtime is unverified.

## Scope guard

`taskferry_status`, `taskferry_result` and `taskferry_summary` read `task.status` and check the canonical `directory` against the allowed roots before they return status, request result content or queue a summary. A missing or unresolvable directory fails closed. The check lives in `src/scope.ts` and runs from `src/tools.ts`.

`taskferry_list` without a directory asks the daemon for its newest 500 tasks and filters the rows through the same allowed roots. Passing a directory scopes the list to that workspace, which must itself be under an allowed root.

An unknown task ID and an out-of-scope one both answer "task not accessible", which keeps a caller from probing IDs outside its roots. A live pass confirmed that mapping against the running daemon.

`taskferry_result` accepts `fields` to select result fields and `full` to return the complete narration. `taskferry_summary` wraps `task.summary`: it returns a queued summary task in `summaryTask`, and the caller polls `taskferry_status` and reads `taskferry_result` against that id. `mode: "activity"` reads cached activity without spawning a worker; `mode: "report"` (the default) queues a summarizer.

`taskferry_models` shells out to `opencode models` and caches the result for 60 seconds. Without a query it returns the allowlisted model ids only. With a query it searches the full installed catalog and marks each match as allowed or not. `missingAllowedModels` names allowlisted ids that are not installed, which catches an allowlist typo before a dispatch fails.

`taskferry_dispatch` accepts an optional `variant` string for the model reasoning level, for example `low`, `high`, `xhigh`, `max`, or `highest`; it forwards the value to the daemon as `variant` and omits it when unset. A denied request says whether the workspace or the model failed and includes the allowed models.

`taskferry_dispatch` also accepts an optional `roBind` array of absolute host paths. Each path is resolved with `realpathSync` and must be on the read-only bind allowlist, either as the exact file or under an allowed directory. The bridge forwards the resolved paths to the daemon as `roBind`, which mounts each one read-only at the same path inside the task sandbox. There is no read-write bind surface.

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
`offset` and `maxBytes` to page, and `binary: true` when the bytes are not
UTF-8 text. Entries are capped at 500 rows per listing.

## Full final message

`taskferry_message` reads only the final `message` field, without the daemon's
2000-character narration preview cap. The first call without `confirm: true`
returns `messageChars` and a 500-character preview, which keeps a large message
out of the client's context until the caller explicitly asks for it. With
`confirm: true` it returns the whole message, or a page when `offset` and
`limit` are set. `nextOffset` names the next page when more remains. A
non-confirmed call ignores `offset` and `limit`, so paging cannot be used to
walk the full message without confirming.

## Limitations / next gates

- Real TaskFerry integration live passes cover health, list, status, result, summary, dispatch, and dispatched-task results. Queue behavior under load, concurrent clients, non-default executors, and very long summaries are still untested. Dispatch stays disabled until both allowlists are set, and read-only binds stay disabled until the bind allowlist is set.
- MCP compatibility is verified against the official SDK client and raw JSON-RPC over HTTP. The bridge answers with JSON only, so a client that requires SSE or sessions will fail.
- The suite has 48 cases and does not cover the B01-B18 matrix from the design plan, which is not in this repo.
- Dispatch has no durable idempotency. Do not retry an ambiguous failure automatically.
- `gateway.ts` is a Node.js prototype. A Sites-native handler and a real deployment need the Sites runtime and API.
- Validate input schemas, HTTP limits, authentication, dispatch restrictions, CSRF and origin posture, audit logging, secret rotation, and response truncation before production.

## Evidence

`docs/evidence/2026-10-20-prototype-v2/` holds the prototype's original logs, unedited. Paths inside them come from the machine that produced them.

- `red.log`: initial module-missing test failure. It does not count as assertion-based RED.
- `green.log`: five passing mock tests after the fixture allowlist was fixed.
- `mutation.log`: a change to daemon method forwarding failed one test, then was reverted.
- `scope-red.log`, `scope-green.log`, `scope-mutation.log`, `scope-final.log`: the same sequence for the scope guard.

`docs/evidence/2026-10-21-sdk-transport/` holds this refactor's gate output (`check.log`), two mutation probes (`mutation-scope.log`, `mutation-socket-mode.log`), a CLI smoke run (`smoke.log`), and a live daemon pass (`real-daemon.log`) covering the task tools and one dispatch (`oc_mvi1xlws_1804d533`) that returned `MCP_REAL_DISPATCH_OK`.
