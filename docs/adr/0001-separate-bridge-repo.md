# ADR 0001: The MCP bridge lives in its own repo, not inside TaskFerry

**Status:** Accepted

**Date:** 2026-10-20

## Context

The prototype exposes five `taskferry_*` tools (`list`, `status`, `result`,
`dispatch`, `health`) over authenticated HTTP at `/mcp`, so a host that can
only call declared tools (ChatGPT Sites is the motivating case) can reach a
local TaskFerry daemon over its unix socket.

TaskFerry's own ADR 0003 ("Reject native tool-spec exposure; taskferry stays
CLI-only") forbids the core from registering callable tools on any host. It
grew out of per-turn tool-spec token cost and a drifted second copy of the
dispatch logic. Its "revisit if" clause names this situation: a host that
cannot invoke a CLI and can only call declared tools. Whether ChatGPT Sites is
such a host is not verified yet; see the open question below.

The bridge has to live somewhere: in TaskFerry, or in a repo of its own.

## Decision

The bridge is a separate repo. It talks to the daemon only through the
daemon's documented socket protocol (newline-delimited JSON, `version: 1`) and
imports nothing from TaskFerry.

TaskFerry's core stays CLI-only, so ADR 0003 stands unmodified. Anyone who
does not run this bridge pays no tool-spec cost and carries no MCP code.

## Consequences

Gains:

- ADR 0003 is not reopened, and no per-host tool surface appears in the core.
- The bridge can follow the MCP spec and its SDK on its own schedule.
- Its attack surface (an HTTP listener holding a bearer token) is not part of
  every TaskFerry install.

Costs:

- The bridge tracks the daemon wire protocol by hand. A protocol change in
  TaskFerry can break it without TaskFerry's tests noticing. The tests here
  run against a stub daemon, so they cannot catch that either; a contract
  check against a real daemon is still missing.
- Two repos to release and keep compatible.
- The bridge cannot reuse the core's validation. Dispatch parameters are
  checked here, separately, and may drift from what the daemon accepts.

## Alternatives considered

- **A `taskferry mcp` subcommand in the core.** Rejected: it is the shape ADR
  0003 and `docs/migrating-from-mcp.md` removed on purpose (a second
  implementation surface next to the CLI), and it would ship the HTTP
  listener to everyone.
- **A host plugin that registers the tools.** Rejected by ADR 0003 for the
  same reason; a plugin registering callable tools is exactly what that ADR
  forbids.

## Revisit this decision if

- TaskFerry ships a stable, versioned programmatic client for the socket
  protocol. The bridge should then depend on it instead of re-implementing the
  framing.
- The target host turns out to be able to run a CLI after all. The bridge is
  then unnecessary, not just misplaced.

## Open question (not decided here)

Whether ChatGPT Sites' runtime and MCP client can use this bridge at all is
unverified. The README says so too.
