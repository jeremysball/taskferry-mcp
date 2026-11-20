import { createHash } from 'node:crypto';
import type http from 'node:http';
import { isClientIdUrl } from './oauth-cimd.ts';
import { StoreFullError, type CodeGrant, type Issued, type RotateResult } from './oauth-store.ts';
import {
  SECURITY_HEADERS,
  methodNotAllowed,
  readFormBody,
  repeatedParam,
  sendJson,
  sendOAuthError,
  single,
  type OAuthDeps,
} from './oauth-http.ts';
import { parseScope, sameResource } from './oauth-scope.ts';
import { constantTimeEqual } from './transport.ts';

// RFC 7636 code_verifier: 43 to 128 characters from the unreserved set.
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

type Res = http.ServerResponse;

async function readForm(req: http.IncomingMessage, res: Res): Promise<URLSearchParams | undefined> {
  const params = await readFormBody(req, res);
  if (params === 'unsupported') {
    sendOAuthError(res, 400, 'invalid_request', 'use application/x-www-form-urlencoded');
    return undefined;
  }
  if (params === 'too_large') {
    sendOAuthError(res, 413, 'invalid_request', 'request too large');
    return undefined;
  }
  return params;
}

function sendTokens(res: Res, issued: Issued) {
  sendJson(res, 200, {
    access_token: issued.accessToken,
    token_type: 'Bearer',
    expires_in: issued.expiresIn,
    refresh_token: issued.refreshToken,
    scope: issued.scope.join(' '),
  });
}

function knownId(deps: OAuthDeps, clientId: string): boolean {
  return deps.store.getClient(clientId) !== undefined || isClientIdUrl(clientId);
}

// These endpoints never re-fetch client metadata: the authorization code or refresh record
// already binds the client, and revocation must work while the metadata host is down. A
// registered client or a URL-shaped CIMD id passes here; anything else is refused before a grant
// is examined.
function clientIdOf(deps: OAuthDeps, params: URLSearchParams, res: Res): string | undefined {
  const id = single(params, 'client_id');
  if (id === undefined || !knownId(deps, id)) {
    sendOAuthError(res, 400, 'invalid_client', 'unknown client_id');
    return undefined;
  }
  return id;
}

// A token minted for a different resource would be accepted nowhere, so a mismatched `resource`
// is refused before any grant is examined.
function targetAllowed(deps: OAuthDeps, params: URLSearchParams, res: Res): boolean {
  const resource = single(params, 'resource');
  if (resource === undefined || sameResource(resource, deps.config.resource)) return true;
  sendOAuthError(res, 400, 'invalid_target', 'resource must be this server MCP endpoint');
  return false;
}

function dispatchGrant(deps: OAuthDeps, params: URLSearchParams, res: Res, clientId: string) {
  const grant = single(params, 'grant_type');
  if (grant === 'authorization_code') return codeGrant(deps, params, res, clientId);
  if (grant === 'refresh_token') return refreshGrant(deps, params, res, clientId);
  return sendOAuthError(res, 400, 'unsupported_grant_type');
}

export async function handleToken(deps: OAuthDeps, req: http.IncomingMessage, res: Res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const params = await readForm(req, res);
  if (!params) return undefined;
  if (repeatedParam(params)) {
    return sendOAuthError(res, 400, 'invalid_request', 'parameters must not repeat');
  }
  const clientId = clientIdOf(deps, params, res);
  if (clientId === undefined) return undefined;
  if (!targetAllowed(deps, params, res)) return undefined;
  return dispatchGrant(deps, params, res, clientId);
}

type CodeRequest = { code: string; verifier: string; redirectUri: string };

function codeRequest(params: URLSearchParams, res: Res): CodeRequest | undefined {
  const code = single(params, 'code');
  const verifier = single(params, 'code_verifier');
  const redirectUri = single(params, 'redirect_uri');
  if (!code || !verifier || !redirectUri) {
    sendOAuthError(
      res,
      400,
      'invalid_request',
      'code, code_verifier and redirect_uri are required',
    );
    return undefined;
  }
  if (!VERIFIER_PATTERN.test(verifier)) {
    sendOAuthError(res, 400, 'invalid_request', 'malformed code_verifier');
    return undefined;
  }
  return { code, verifier, redirectUri };
}

function sendCapacity(deps: OAuthDeps, res: Res, clientId: string) {
  deps.log('token_capacity', { client_id: clientId });
  return sendOAuthError(res, 503, 'temporarily_unavailable', 'too many grants; try again shortly');
}

// Check capacity before anything irreversible: a code burned by a temporary refusal would force
// the owner through consent again.
function newGrantAllowed(deps: OAuthDeps, res: Res, clientId: string): boolean {
  try {
    deps.store.assertNewGrantCapacity();
    return true;
  } catch (error) {
    if (!(error instanceof StoreFullError)) throw error;
    sendCapacity(deps, res, clientId);
    return false;
  }
}

// The code names the client, redirect and resource it was issued for. A mismatch means the code
// was not issued to this caller; a resource change means it must not mint a token for the new
// endpoint.
function codeGrantProblem(
  deps: OAuthDeps,
  grant: CodeGrant,
  clientId: string,
  redirectUri: string,
): string | undefined {
  if (grant.clientId !== clientId || grant.redirectUri !== redirectUri) {
    return 'code was not issued for this client and redirect';
  }
  if (grant.resource !== deps.config.resource) {
    deps.log('resource_changed', { client_id: clientId });
    return 'code was issued for another resource';
  }
  return undefined;
}

function codeGrant(deps: OAuthDeps, params: URLSearchParams, res: Res, clientId: string) {
  const request = codeRequest(params, res);
  if (!request) return undefined;
  if (!newGrantAllowed(deps, res, clientId)) return undefined;
  const spent = deps.store.consumeCode(request.code);
  if (spent.kind !== 'ok') return sendOAuthError(res, 400, 'invalid_grant', 'code is not valid');
  const { grant, codeHash } = spent;
  const problem = codeGrantProblem(deps, grant, clientId, request.redirectUri);
  if (problem) return sendOAuthError(res, 400, 'invalid_grant', problem);
  const challenge = createHash('sha256').update(request.verifier).digest('base64url');
  if (!constantTimeEqual(challenge, grant.codeChallenge)) {
    deps.log('pkce_failed', { client_id: clientId });
    return sendOAuthError(res, 400, 'invalid_grant', 'PKCE verification failed');
  }
  const issued = deps.store.issueTokens({
    scope: grant.scope,
    resource: grant.resource,
    codeHash,
    clientId,
  });
  deps.log('token_issued', { client_id: clientId, grant: 'authorization_code' });
  return sendTokens(res, issued);
}

function refreshGrant(deps: OAuthDeps, params: URLSearchParams, res: Res, clientId: string) {
  const token = single(params, 'refresh_token');
  if (!token) return sendOAuthError(res, 400, 'invalid_request', 'refresh_token is required');
  const rawScope = single(params, 'scope');
  const requested = rawScope === undefined ? undefined : parseScope(rawScope);
  if (rawScope !== undefined && !requested) {
    return sendOAuthError(res, 400, 'invalid_scope', 'unsupported scope');
  }
  let result: RotateResult;
  try {
    result = deps.store.rotateRefresh(token, clientId, requested, deps.config.resource);
  } catch (error) {
    if (!(error instanceof StoreFullError)) throw error;
    return sendCapacity(deps, res, clientId);
  }
  if (result.kind === 'ok') {
    deps.log('token_issued', { client_id: clientId, grant: 'refresh_token' });
    return sendTokens(res, result.issued);
  }
  if (result.kind === 'reuse') deps.log('refresh_reuse', { client_id: clientId });
  if (result.kind === 'invalid_scope') {
    return sendOAuthError(res, 400, 'invalid_scope', 'scope exceeds the original grant');
  }
  return sendOAuthError(res, 400, 'invalid_grant', 'refresh token is not valid');
}

// RFC 7009. Always answers 200 so a caller cannot learn whether a token existed.
export async function handleRevoke(deps: OAuthDeps, req: http.IncomingMessage, res: Res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const params = await readForm(req, res);
  if (!params) return undefined;
  if (repeatedParam(params)) {
    return sendOAuthError(res, 400, 'invalid_request', 'parameters must not repeat');
  }
  const hint = single(params, 'client_id');
  if (hint !== undefined && !knownId(deps, hint)) {
    return sendOAuthError(res, 400, 'invalid_client', 'unknown client_id');
  }
  const token = single(params, 'token');
  if (token) deps.store.revokeToken(token, hint);
  deps.log('revoked', hint === undefined ? {} : { client_id: hint });
  res.writeHead(200, SECURITY_HEADERS);
  return res.end();
}
