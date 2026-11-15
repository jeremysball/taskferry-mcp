# ADR 0003: Accept Client ID Metadata Documents beside dynamic registration

**Status:** Accepted

**Date:** 2026-11-15

## Context

ADR 0002 made the bridge its own authorization server and registered clients with RFC 7591 dynamic client registration. That works for clients that choose to register: the client POSTs its redirect URIs, gets a generated `client_id`, and continues.

The MCP authorization profile dated 2025-11-25 tells clients they may instead identify themselves with a Client ID Metadata Document (CIMD): the `client_id` is an `https` URL the client controls, and the authorization server fetches a JSON document from it to learn the client's name and redirect URIs. Nothing is stored server-side at registration time. A client that prefers this path never calls `/oauth/register`, and a server that only speaks dynamic registration sends it through a path its authors did not choose.

The fetch is the interesting part. The bridge would retrieve a URL chosen by an unauthenticated caller from a host that also reaches the local network, dispatch to TaskFerry, and read any file the OS user can read. An unrestricted metadata fetch is a server-side request forgery primitive.

## Decision

The bridge accepts both mechanisms. When `client_id` is not a registered client, and it parses as an `https` URL per the draft (a path, no dot segments, no credentials, no fragment), the bridge fetches it as a metadata document and treats a valid document as a client registration for that request.

The fetch is constrained: `redirect: 'manual'` so a redirect is never followed, status 200 only, `application/json` or a `+json` suffix, a 5 KB body cap enforced while streaming, and a 5 s timeout. URL hosts that are IP literals, `localhost`, `.localhost`, `.local`, `.internal` or `.home.arpa` names are refused before any request is made.

The document must name its own `client_id`, carry a `client_name`, and list 1 to 10 `redirect_uris`. A document carrying a client secret, a token-endpoint auth method other than `none`, or grant/response types other than `authorization_code` and `code` is refused, because this server cannot honour them. Redirect URIs are filtered through the same operator allowlist that registration uses, so the allowlist still decides every destination.

Documents are cached per URL for the `Cache-Control` `max-age`, clamped to 60 seconds to 1 hour with a 5-minute default; `no-store`, `max-age=0` and malformed headers mean no caching, and refusals are never cached. The cache holds at most 100 entries and evicts oldest-first.

## Consequences

- Clients that use CIMD sign in without a registration step, and the discovery document advertises `client_id_metadata_document_supported: true`.
- The SSRF surface is bounded to public `https` hosts and small JSON responses, but a public DNS name that resolves to a private address is still fetched. Detecting that would require resolving first and pinning the connection to the answer, which this implementation does not do; the residual risk is recorded in `docs/things-that-look-like-bugs.md`.
- A stale cached document can disagree with the live one for up to an hour. The allowlist still limits redirects, so staleness can only narrow what the client may use, never widen it beyond the operator's list.
- Two mechanisms now produce clients. Registration writes to the store; CIMD clients exist only as fetched metadata plus the pending sign-in's captured name and ID, so a restart forgets them until the next request refetches.
- The document is untrusted input from the network and is parsed with the same JSON guards as stored state; nothing in it is logged or echoed beyond the client name and host shown on the consent page.

## Alternatives rejected

- **Dynamic registration only.** Simplest, and it was the previous state, but it forces CIMD-preferring clients onto a path their implementations may not use.
- **Fetch the document at registration and store it.** A CIMD client does not call registration, so there is no registration moment to hook; storing it would also make an unauthenticated fetch mutate durable state.
- **Operator-maintained `client_id` allowlist.** No network fetch at all, but every new client URL becomes a config edit, which defeats the point of the mechanism.
- **Resolve DNS and reject private answers before fetching.** Closer to complete, but without binding the fetch to the resolved address it only moves the race, and it adds a resolver dependency to the bridge.
