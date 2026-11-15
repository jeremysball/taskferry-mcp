import type http from 'node:http';
import { StoreFullError, type Pending } from './oauth-store.ts';
import { isClientIdUrl } from './oauth-cimd.ts';
import type { ClientView } from './oauth-store.ts';
import { redirectAllowed } from './oauth-clients.ts';
import {
  SECURITY_HEADERS,
  methodNotAllowed,
  readFormBody,
  redirect,
  repeatedParam,
  sendHtml,
  single,
  type OAuthDeps,
} from './oauth-http.ts';
import { renderConsent, renderError } from './oauth-page.ts';
import { parseScope, sameResource } from './oauth-scope.ts';
import { constantTimeEqual } from './transport.ts';

// S256 challenges are the unpadded base64url of a SHA-256 digest: always 43 characters.
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVALID_LINK = 'This sign-in link is not valid. Start again from the app you are connecting.';
const EXPIRED = 'This sign-in request expired or was already used. Start again from the app.';

// A redirect back to the client carrying either a code or an error. `iss` lets the client check
// which authorization server answered (RFC 9207).
function clientRedirect(
  deps: OAuthDeps,
  redirectUri: string,
  state: string | undefined,
  fields: Record<string, string>,
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
  if (state !== undefined) url.searchParams.set('state', state);
  url.searchParams.set('iss', deps.config.origin);
  return url.href;
}

export async function handleAuthorize(
  deps: OAuthDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) {
  if (req.method === 'GET') return await authorizeGet(deps, res, url.searchParams);
  if (req.method === 'POST') return authorizePost(deps, req, res);
  return methodNotAllowed(res, 'GET, POST');
}

type Refusal = [error: string, description: string];

// The protocol-level reasons an authorization request is refused. These go back to the client
// as an error redirect, which is only safe once the client and redirect URI are known good.
function protocolRefusal(deps: OAuthDeps, params: URLSearchParams): Refusal | undefined {
  if (single(params, 'response_type') !== 'code') {
    return ['unsupported_response_type', 'only response_type=code is supported'];
  }
  const challenge = single(params, 'code_challenge');
  const method = single(params, 'code_challenge_method');
  if (!challenge || !CHALLENGE_PATTERN.test(challenge) || method !== 'S256') {
    return ['invalid_request', 'PKCE with code_challenge_method=S256 is required'];
  }
  const resource = single(params, 'resource');
  if (resource !== undefined && !sameResource(resource, deps.config.resource)) {
    return ['invalid_target', 'resource must be this server MCP endpoint'];
  }
  if (!parseScope(single(params, 'scope'))) return ['invalid_scope', 'unsupported scope'];
  return undefined;
}

type Target = { client: ClientView; redirectUri: string; state: string | undefined };

// An unknown client or an unregistered redirect never gets a redirect: the error is shown here,
// so this endpoint cannot be used as an open redirector. The allowlist is checked again on every
// request, so tightening it also retires redirects registered earlier.
async function authorizeTarget(
  deps: OAuthDeps,
  params: URLSearchParams,
): Promise<Target | undefined> {
  const clientId = single(params, 'client_id');
  const redirectUri = single(params, 'redirect_uri');
  // Check the redirect before resolving the client: a disallowed or missing redirect can never
  // be answered, so fetching a metadata document first would be network work for a 400.
  if (!clientId || !redirectUri || !redirectAllowed(deps.config.redirects, redirectUri)) {
    return undefined;
  }
  const client = await deps.resolveClient(clientId);
  if (!client || !client.redirectUris.includes(redirectUri)) return undefined;
  return { client, redirectUri, state: single(params, 'state') };
}

async function authorizeGet(deps: OAuthDeps, res: http.ServerResponse, params: URLSearchParams) {
  const target = await authorizeTarget(deps, params);
  if (!target) {
    deps.log('authorize_refused', { reason: 'unknown_client_or_redirect' });
    return sendHtml(res, 400, renderError(INVALID_LINK));
  }
  const { client, redirectUri, state } = target;
  const duplicate = repeatedParam(params);
  if (duplicate) {
    const query = { error: 'invalid_request', error_description: `parameter ${duplicate} repeats` };
    return redirect(res, clientRedirect(deps, redirectUri, state, query));
  }
  const bounce = ([error, description]: Refusal) =>
    redirect(
      res,
      clientRedirect(deps, redirectUri, state, { error, error_description: description }),
    );
  const refusal = protocolRefusal(deps, params);
  if (refusal) return bounce(refusal);
  try {
    const requestId = deps.store.createPending({
      redirectUri,
      state,
      clientId: client.clientId,
      clientName: client.clientName,
      codeChallenge: single(params, 'code_challenge') ?? '',
      scope: parseScope(single(params, 'scope')) ?? [],
      resource: deps.config.resource,
    });
    const consent = consentView({
      clientName: client.clientName,
      clientId: client.clientId,
      redirectUri,
      requestId,
    });
    deps.log('consent_shown', { client_id: client.clientId, redirect_host: consent.redirectHost });
    return sendHtml(res, 200, renderConsent(consent));
  } catch (error) {
    if (!(error instanceof StoreFullError)) throw error;
    return bounce(['temporarily_unavailable', 'too many sign-ins in progress; try again shortly']);
  }
}

async function authorizePost(deps: OAuthDeps, req: http.IncomingMessage, res: http.ServerResponse) {
  const params = await readFormBody(req, res);
  if (params === 'unsupported') return sendHtml(res, 415, renderError('Unsupported content type.'));
  if (params === 'too_large') return sendHtml(res, 413, renderError('Request too large.'));
  if (repeatedParam(params)) return sendHtml(res, 400, renderError(INVALID_LINK));
  const id = single(params, 'request_id');
  const pending = id ? deps.store.peekPending(id) : undefined;
  if (!pending) return sendHtml(res, 400, renderError(EXPIRED));
  const decision = single(params, 'decision');
  if (decision === 'deny') return deny(deps, res, pending);
  if (decision !== 'approve') return sendHtml(res, 400, renderError(INVALID_LINK));
  return approve(deps, res, pending, single(params, 'secret') ?? '');
}

function deny(deps: OAuthDeps, res: http.ServerResponse, pending: Pending) {
  deps.store.takePending(pending.id);
  deps.log('denied', { client_id: pending.clientId });
  return redirect(
    res,
    clientRedirect(deps, pending.redirectUri, pending.state, { error: 'access_denied' }),
  );
}

function lockedOut(deps: OAuthDeps, res: http.ServerResponse, wait: number) {
  deps.log('approval_locked', { retry_after: wait });
  res.writeHead(429, {
    ...SECURITY_HEADERS,
    'content-type': 'text/html; charset=utf-8',
    'retry-after': String(wait),
  });
  return res.end(renderError(`Too many wrong attempts. Try again in ${wait} seconds.`));
}

function wrongSecret(deps: OAuthDeps, res: http.ServerResponse, pending: Pending) {
  deps.limiter.fail();
  deps.log('wrong_secret', { client_id: pending.clientId });
  return sendHtml(
    res,
    403,
    renderConsent(pendingConsent(pending, 'That is not the approval secret.')),
  );
}

// One description of the consent page: the client's name, where its id lives, and where the code
// will be sent. Every render (first look, wrong secret, capacity refusal) goes through this.
function consentView(fields: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  requestId: string;
  error?: string;
}) {
  return {
    clientName: fields.clientName,
    clientIdHost: isClientIdUrl(fields.clientId) ? new URL(fields.clientId).host : undefined,
    redirectHost: new URL(fields.redirectUri).host,
    requestId: fields.requestId,
    ...(fields.error === undefined ? {} : { error: fields.error }),
  };
}

function pendingConsent(pending: Pending, error?: string) {
  return consentView({
    clientName: pending.clientName,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    requestId: pending.id,
    error,
  });
}

function approve(deps: OAuthDeps, res: http.ServerResponse, pending: Pending, secret: string) {
  const wait = deps.limiter.retryAfterSeconds();
  if (wait > 0) return lockedOut(deps, res, wait);
  if (!constantTimeEqual(secret, deps.config.approvalSecret))
    return wrongSecret(deps, res, pending);
  deps.limiter.reset();
  let code: string;
  try {
    // Issue first and take the pending request only on success: a capacity refusal must leave
    // the request in place so the owner can retry instead of starting the sign-in again.
    code = deps.store.issueCode({
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scope: pending.scope,
      resource: pending.resource,
    });
  } catch (error) {
    if (!(error instanceof StoreFullError)) throw error;
    deps.log('approval_full', { client_id: pending.clientId });
    return sendHtml(
      res,
      503,
      renderConsent(pendingConsent(pending, 'The server is busy. Try again shortly.')),
    );
  }
  deps.store.takePending(pending.id);
  deps.log('approved', { client_id: pending.clientId });
  return redirect(res, clientRedirect(deps, pending.redirectUri, pending.state, { code }));
}
