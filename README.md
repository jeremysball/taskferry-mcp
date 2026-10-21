# TaskFerry MCP Bridge

**Status:** mock-tested prototype. The suite runs against a stub daemon and real loopback listeners. Nobody has run the bridge against a real TaskFerry daemon or a real Sites client, and it is not production-ready.

## Architecture

Sites MCP client -> Sites-compatible forwarding service (the deployment adapter is still unwritten) -> authenticated `POST /mcp` -> this bridge -> TaskFerry's private Unix-domain socket.

The bridge is TypeScript run directly by Node's native type stripping, so there is no build step. Node is pinned to 26.5.1 in `.mise.toml`. The MCP side uses the official SDK: each request gets a fresh stateless `McpServer` connected to a `NodeStreamableHTTPServerTransport` that answers with JSON. There are no sessions and no SSE stream.

## Tools

Five tools, each hard-wired to one daemon method. A caller cannot name a daemon method directly.

| Tool                 | Daemon method   | Notes                                 |
| -------------------- | --------------- | ------------------------------------- |
| `taskferry_health`   | `system.health` |                                       |
| `taskferry_list`     | `task.list`     | Needs `TASKFERRY_ALLOWED_DIRECTORIES` |
| `taskferry_status`   | `task.status`   | Scope-guarded                         |
| `taskferry_result`   | `task.result`   | Scope-guarded; status is read first   |
| `taskferry_dispatch` | `task.dispatch` | Needs both allowlists                 |

## Run tests

`mise run check` runs the full gate: format check, lint, the TypeScript split check, `tsc --noEmit`, and 37 unit tests. CI runs the same steps. `npm test` runs only the tests.

The tests start a real stub daemon on a Unix socket and real HTTP listeners on loopback. Two mutation probes are kept in the evidence directory: disabling the scope guard fails the cross-workspace test, and loosening the socket mode fails the permissions test.

## Run the bridge

By default the bridge listens on a Unix socket at `$XDG_RUNTIME_DIR/taskferry-mcp/mcp.sock`, created with mode 0600 inside a 0700 directory. The daemon socket defaults to `$TASKFERRY_RUNTIME_DIR/daemon.sock`, falling back to `$XDG_RUNTIME_DIR/taskferry/daemon.sock`.

```
export TASKFERRY_MCP_TOKEN='replace-with-random-secret'
export TASKFERRY_RUNTIME_DIR='/run/user/1000/taskferry'
export TASKFERRY_ALLOWED_DIRECTORIES='/path/to/repo'
export TASKFERRY_ALLOWED_MODELS='provider/model'
npm start
```

Each setting resolves as flag, then environment variable, then config-file key, then default.

| Flag                    | Environment                     | Config key           | Default                                   |
| ----------------------- | ------------------------------- | -------------------- | ----------------------------------------- |
| `--daemon-socket`       | `TASKFERRY_SOCKET_PATH`         | `daemonSocket`       | `$TASKFERRY_RUNTIME_DIR/daemon.sock`      |
| `--allowed-directories` | `TASKFERRY_ALLOWED_DIRECTORIES` | `allowedDirectories` | none                                      |
| `--allowed-models`      | `TASKFERRY_ALLOWED_MODELS`      | `allowedModels`      | none                                      |
| `--listen-socket`       | `TASKFERRY_MCP_LISTEN_SOCKET`   | `listenSocket`       | `$XDG_RUNTIME_DIR/taskferry-mcp/mcp.sock` |
| `--listen-port`         | `TASKFERRY_MCP_LISTEN_PORT`     | `listenPort`         | none                                      |
| `--token-file`          | `TASKFERRY_MCP_TOKEN_FILE`      | `tokenFile`          | none                                      |

`--config` and `TASKFERRY_MCP_CONFIG` name a config file; the default is `$XDG_CONFIG_HOME/taskferry-mcp/config.json`. Directory lists split on `:`, model lists on `,`.

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

`taskferry_status` and `taskferry_result` read `task.status` and check the canonical `directory` against the allowed roots before they return status or request result content. A missing or unresolvable directory fails closed. The check lives in `src/scope.ts` and runs from `src/tools.ts`.

An unknown task ID and an out-of-scope one both answer "task not accessible", which keeps a caller from probing IDs outside its roots. That mapping depends on the daemon's `UNKNOWN_TASK` error code, read from its source but never exercised against a running daemon.

## Limitations / next gates

- Real TaskFerry integration is untested. The exact `task.dispatch` parameters may differ from the stub, so dispatch stays disabled until both allowlists are set and the call is validated.
- MCP compatibility is verified against the official SDK client and raw JSON-RPC over HTTP. The bridge answers with JSON only, so a client that requires SSE or sessions will fail.
- The suite has 37 cases and does not cover the B01-B18 matrix from the design plan, which is not in this repo.
- Dispatch has no durable idempotency. Do not retry an ambiguous failure automatically.
- `gateway.ts` is a Node.js prototype. A Sites-native handler and a real deployment need the Sites runtime and API.
- Validate input schemas, HTTP limits, authentication, dispatch restrictions, CSRF and origin posture, audit logging, secret rotation, and response truncation before production.

## Evidence

`docs/evidence/2026-10-20-prototype-v2/` holds the prototype's original logs, unedited. Paths inside them come from the machine that produced them.

- `red.log`: initial module-missing test failure. It does not count as assertion-based RED.
- `green.log`: five passing mock tests after the fixture allowlist was fixed.
- `mutation.log`: a change to daemon method forwarding failed one test, then was reverted.
- `scope-red.log`, `scope-green.log`, `scope-mutation.log`, `scope-final.log`: the same sequence for the scope guard.

`docs/evidence/2026-10-21-sdk-transport/` holds this refactor's gate output (`check.log`), two mutation probes (`mutation-scope.log`, `mutation-socket-mode.log`), and a CLI smoke run (`smoke.log`).
