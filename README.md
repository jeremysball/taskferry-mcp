# TaskFerry MCP Bridge (reconstructed prototype)

**Status:** Mock-tested prototype; NOT live-tested with TaskFerry or ChatGPT Sites, not production-ready. The earlier missing adapter was not recovered. This is independently reconstructed from the public TaskFerry protocol and saved design plan.

## Architecture

Sites MCP client -> Sites-compatible forwarding service (deployment adapter still required) -> authenticated HTTP `/mcp` -> local adapter -> TaskFerry private Unix-domain socket.

Written in TypeScript targeting Node.js 22.16+ native type stripping. No third-party packages required for the prototype.

## Run tests

`npm test`

Tests use a real mock Unix socket daemon, and real HTTP listeners, both on the loopback interface. A mutation probe replaces `task.list` forwarding with `system.health`; the first test fails, proving the test inspects the request received by the fake daemon.

## Run adapter (localhost only)

```
export TASKFERRY_MCP_TOKEN='replace-with-random-secret'
export TASKFERRY_SOCKET_PATH='/run/user/1000/taskferry/daemon.sock'
export TASKFERRY_ALLOWED_DIRECTORIES='/home/me/myrepo'
export TASKFERRY_ALLOWED_MODELS='provider/model'
npm start
```

This adapter doesn't start TaskFerry. Local socket path must be supplied. `taskferry_list` requires a configured directory allowlist; `taskferry_dispatch` additionally requires a model allowlist. Do NOT expose this HTTP listener directly on the public internet. TLS and external reachability need an authenticated proxy.

## Gateway demonstration (loopback only)

```
export TASKFERRY_UPSTREAM_URL='http://127.0.0.1:8787/mcp'
export TASKFERRY_GATEWAY_TOKEN='separate-secret'
export TASKFERRY_MCP_TOKEN='replace-with-random-secret'
npm run gateway
```

Gateway is a generic Node.js forwarding *reference implementation*, not deployed or validated in ChatGPT Sites. It forwards one configured `/mcp` endpoint only, with isolated gateway and upstream credentials. This is not proof that Sites supports this code/runtime.

## Limitations / next gates

- Real TaskFerry read-only daemon integration untested; exact `task.dispatch` parameters may differ, so dispatch must remain disabled until validated.
- MCP Streamable HTTP compatibility requires client-specific verification (Accept, initialization, session/version negotiation, streaming, notifications, lifecycle). Current server supports basic JSON responses and notification 202 handling; it does not offer SSE streaming or sessions.
- Task status/result record access not yet scoped to workspace; task IDs could expose another workspace. Enforce authorization on task ID before deployment.
- Only five tests exist, not complete B01-B18 coverage. No approval snapshot baselines approved by owner; no full typechecker run.
- Do not automatically retry ambiguous dispatch failures; no durable idempotency guarantee.
- The `gateway.ts` module is a Node.js prototype. A Sites-native handler and actual deployment require the Sites runtime/API interface.
- Validate input schemas, HTTP limits, authentication, dispatch restrictions, CSRF/origin posture, auditability, secret rotation, and response truncation before production.

## Evidence

- `red.log`: initial module-missing test failure (does NOT count as assertion-based RED).
- `green.log`: five passing mock tests after fixing fixture allowlist.
- `mutation.log`: deliberate mutation of daemon method forwarding failed one of five tests, reverted afterward.

## 2026-10-20 scope guard follow-up

Added `taskferry_status`/`taskferry_result` workspace authorization by reading `task.status` and checking that its canonical `directory` is within a configured allowed root before returning status or requesting result content. Missing/unresolvable directory fails closed. New mock test passes with six total tests; deliberately disabling the guard makes that test fail. This does **not** prove the guard against a real TaskFerry daemon or against symlink/path races, and does not make the bridge production ready.
