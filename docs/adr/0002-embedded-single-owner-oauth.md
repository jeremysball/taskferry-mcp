# ADR 0002: OAuth is an embedded single-owner authorization server, not a delegated login

**Status:** Accepted

**Date:** 2026-11-15

## Context

A static bearer token is enough for a client that can be handed a header. A remote MCP client such as a claude.ai custom connector cannot: it discovers an authorization server from the MCP endpoint's `401` challenge, registers itself, and sends the user through an authorization-code flow with PKCE. To be reachable from those clients the bridge has to speak that protocol.

The MCP specification makes the MCP server a resource server and lets the authorization server be a separate party. The MCP SDK this repo uses ships the resource-server half (metadata helpers, bearer verification) and a client, but no authorization server.

The bridge serves one person. A grant is worth the whole tool surface, including dispatch and the host-wide file read, so the question of who may approve is the security decision, not an afterthought.

## Decision

The bridge embeds a small authorization server in the same process. It supports dynamic client registration, authorization code with S256 PKCE only, refresh-token rotation with reuse detection, and revocation. The owner approves each client on a consent page by typing a secret that differs from the bridge and gateway tokens. There are no user accounts. OAuth is off unless a public URL is configured, and the static token keeps working beside it.

Choices that follow from "one owner, public listener":

- Public clients only, no client secrets, and every registered redirect URI must match an allowlist (Claude's callbacks and loopback by default).
- Access tokens are bound to the exact `<origin>/mcp` resource and live in memory. Only refresh-token hashes and the clients they name are written to disk.
- Approval failures are rate-limited globally, since a tunnel hides the source address.
- OAuth is served on the bridge surface only. The gateway keeps its own token and has no OAuth.

## Consequences

Gains:

- No external service, account or callback to operate; one process and one secret.
- The tests can drive the whole flow, including with the official SDK client.
- The static-token deployment is unchanged for anyone who does not set a public URL.

Costs:

- This repo now owns security-sensitive code that an identity provider would normally own: token issuance, rotation, PKCE and consent. Mistakes here are the bridge's, and the tests are the main defense. When the code was written, 24 deliberate breakages of its checks (PKCE, redirect matching, audience binding, rotation reuse, the approval secret, the rebinding guard) were each caught by at least one test; those probes were run by hand and are not kept in the repo.
- Approval is a single factor given to whoever can start a flow. A convincing link that talks the owner into approving an attacker's client is the realistic attack; the consent page warns, and the allowlist limits where a code can go.
- There is no per-tool scope, so every grant is full authority.
- Not verified against real claude.ai or Claude Code, only the SDK client and raw HTTP.

## Alternatives considered

- **Sign in with an external provider (for example GitHub) and map one account to the owner.** Stronger approval than a typed secret and no secret to guard, but it adds a third-party dependency, an OAuth app to register and a callback to operate, and it still needs the same authorization-server code underneath. Left as the first upgrade if the single secret proves too weak.
- **Validate tokens from an external authorization server and implement only the resource side.** Least code here, but it needs an authorization server that supports dynamic registration and the redirects Claude uses, and moves the deployment burden to the owner.
- **Keep the static token only and put an authenticating proxy in front.** Works for clients that can send a header, which the remote connector flow cannot.

## Revisit if

Client ID Metadata Documents replace dynamic registration for the clients that matter, a second person needs access, or the single approval secret is judged too weak for the exposure.
