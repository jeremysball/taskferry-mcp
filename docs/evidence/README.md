# Evidence logs

The directories here hold verbatim captures from named points in this
project's history. They are evidence of what one run produced on one machine at
one commit. They are not documentation of current behavior.

## How to read a capture

- **Verbatim.** A capture is never edited, including its paths. The absolute
  `/home/...` and `/workspace/...` paths in these logs are the recording host's
  real paths, kept exactly as recorded. Rewriting them into placeholders would
  turn a capture into a reconstruction, which is the one thing a log must not
  be.
- **Identified.** The table below is where each log's branch and commit are
  named; the captures themselves are not annotated retroactively. The commit
  named is the one that added the log, which is the only provenance git
  records for it.
- **Historical, not current.** Pass counts, test names, timings, and paths
  describe that commit only. None of these logs is the current suite state:
  run `mise run check` for today's tree.

## Captures

| Log                                                 | Branch                   | Commit    |
| --------------------------------------------------- | ------------------------ | --------- |
| `2026-10-20-prototype-v2/red.log`                   | `chore/scaffold`         | `0c18208` |
| `2026-10-20-prototype-v2/green.log`                 | `chore/scaffold`         | `0c18208` |
| `2026-10-20-prototype-v2/mutation.log`              | `chore/scaffold`         | `0c18208` |
| `2026-10-20-prototype-v2/scope-red.log`             | `chore/scaffold`         | `0c18208` |
| `2026-10-20-prototype-v2/scope-green.log`           | `chore/scaffold`         | `0c18208` |
| `2026-10-20-prototype-v2/scope-mutation.log`        | `chore/scaffold`         | `0c18208` |
| `2026-10-20-prototype-v2/scope-final.log`           | `chore/scaffold`         | `0c18208` |
| `2026-10-21-sdk-transport/check.log`                | `feat/mcp-sdk-transport` | `5e09a4d` |
| `2026-10-21-sdk-transport/mutation-scope.log`       | `feat/mcp-sdk-transport` | `5e09a4d` |
| `2026-10-21-sdk-transport/mutation-socket-mode.log` | `feat/mcp-sdk-transport` | `5e09a4d` |
| `2026-10-21-sdk-transport/smoke.log`                | `feat/mcp-sdk-transport` | `5e09a4d` |
| `2026-10-21-sdk-transport/real-daemon.log`          | `feat/mcp-sdk-transport` | `743e448` |
