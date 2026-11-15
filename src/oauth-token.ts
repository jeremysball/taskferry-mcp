import { createHash } from 'node:crypto';
import type http from 'node:http';
import type { Client, Issued } from './oauth-store.ts';
import {
  BodyTooLargeError,
  SECURITY_HEADERS,
  isFormContent,
  methodNotAllowed,
  readBody,
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
  if (!isFormContent(req)) {
    sendOAuthError(res, 400, 'invalid_request', 'use application/x-www-form-urlencoded');
    return undefined;
  }
  try {
    return new URLSearchParams(await readBody(req, res));
  } catch (error) {
    if (!(error instanceof BodyTooLargeError)) throw error;
    sendOAuthError(res, 413, 'invalid_request', 'request too large');
    return undefined;
  }
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

// Public clients only: the client is identified by client_id and proved by PKCE, not a secret.
function knownClient(deps: OAuthDeps, params: URLSearchParams, res: Res): Client | undefined {
  const id = single(params, 'client_id');
  const client = id ? deps.store.getClient(id) : undefined;
  if (!client) sendOAuthError(res, 400, 'invalid_client', 'unknown client_id');
  return client;
}

type Form = { params: URLSearchParams; client: Client };

// The parsed form body and its client, or undefined once an error response has been sent.
async function clientForm(
  deps: OAuthDeps,
  req: http.IncomingMessage,
  res: Res,
): Promise<Form | undefined> {
  const params = await readForm(req, res);
  const client = params && knownClient(deps, params, res);
  return params && client ? { params, client } : undefined;
}

export async function handleToken(deps: OAuthDeps, req: http.IncomingMessage, res: Res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const form = await clientForm(deps, req, res);
  if (!form) return undefined;
  const { params, client } = form;
  const resource = single(params, 'resource');
  if (resource !== undefined && !sameResource(resource, deps.config.resource)) {
    return sendOAuthError(res, 400, 'invalid_target', 'resource must be this server MCP endpoint');
  }
  const grant = single(params, 'grant_type');
  if (grant === 'authorization_code') return codeGrant(deps, params, res, client);
  if (grant === 'refresh_token') return refreshGrant(deps, params, res, client);
  return sendOAuthError(res, 400, 'unsupported_grant_type');
}

function codeGrant(deps: OAuthDeps, params: URLSearchParams, res: Res, client: Client) {
  const code = single(params, 'code');
  const verifier = single(params, 'code_verifier');
  const redirectUri = single(params, 'redirect_uri');
  if (!code || !verifier || !redirectUri) {
    return sendOAuthError(
      res,
      400,
      'invalid_request',
      'code, code_verifier and redirect_uri are required',
    );
  }
  if (!VERIFIER_PATTERN.test(verifier)) {
    return sendOAuthError(res, 400, 'invalid_request', 'malformed code_verifier');
  }
  const spent = deps.store.consumeCode(code);
  if (spent.kind !== 'ok') return sendOAuthError(res, 400, 'invalid_grant', 'code is not valid');
  const { grant, codeHash } = spent;
  if (grant.clientId !== client.clientId || grant.redirectUri !== redirectUri) {
    return sendOAuthError(
      res,
      400,
      'invalid_grant',
      'code was not issued for this client and redirect',
    );
  }
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  if (!constantTimeEqual(challenge, grant.codeChallenge)) {
    deps.log('pkce_failed', { client_id: client.clientId });
    return sendOAuthError(res, 400, 'invalid_grant', 'PKCE verification failed');
  }
  const issued = deps.store.issueTokens({
    clientId: client.clientId,
    scope: grant.scope,
    resource: grant.resource,
    codeHash,
  });
  deps.log('token_issued', { client_id: client.clientId, grant: 'authorization_code' });
  return sendTokens(res, issued);
}

function refreshGrant(deps: OAuthDeps, params: URLSearchParams, res: Res, client: Client) {
  const token = single(params, 'refresh_token');
  if (!token) return sendOAuthError(res, 400, 'invalid_request', 'refresh_token is required');
  const rawScope = single(params, 'scope');
  const requested = rawScope === undefined ? undefined : parseScope(rawScope);
  if (rawScope !== undefined && !requested) {
    return sendOAuthError(res, 400, 'invalid_scope', 'unsupported scope');
  }
  const result = deps.store.rotateRefresh(token, client.clientId, requested);
  if (result.kind === 'ok') {
    deps.log('token_issued', { client_id: client.clientId, grant: 'refresh_token' });
    return sendTokens(res, result.issued);
  }
  if (result.kind === 'reuse') deps.log('refresh_reuse', { client_id: client.clientId });
  if (result.kind === 'invalid_scope') {
    return sendOAuthError(res, 400, 'invalid_scope', 'scope exceeds the original grant');
  }
  return sendOAuthError(res, 400, 'invalid_grant', 'refresh token is not valid');
}

// RFC 7009. Always answers 200 so a caller cannot learn whether a token existed.
export async function handleRevoke(deps: OAuthDeps, req: http.IncomingMessage, res: Res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const form = await clientForm(deps, req, res);
  if (!form) return undefined;
  const token = single(form.params, 'token');
  if (token) deps.store.revokeToken(token, form.client.clientId);
  deps.log('revoked', { client_id: form.client.clientId });
  res.writeHead(200, SECURITY_HEADERS);
  return res.end();
}
