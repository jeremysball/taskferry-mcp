import type http from 'node:http';
import type { OAuthConfig } from './oauth-config.ts';
import { handleAuthorize } from './oauth-authorize.ts';
import { CimdResolver, type CimdFetch } from './oauth-cimd.ts';
import { parseRegistration } from './oauth-clients.ts';
import { FailureLimiter } from './oauth-limiter.ts';
import {
  SECURITY_HEADERS,
  consoleLog,
  methodNotAllowed,
  readBody,
  BodyTooLargeError,
  sendJson,
  sendOAuthError,
  type OAuthDeps,
  type OAuthLog,
} from './oauth-http.ts';
import { SCOPES_SUPPORTED } from './oauth-scope.ts';
import { OAuthStore, StoreFullError } from './oauth-store.ts';
import { handleRevoke, handleToken } from './oauth-token.ts';

const FAILURES_ALLOWED = 10;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

export type OAuth = {
  config: OAuthConfig;
  store: OAuthStore;
  // True for every path this module answers, so the transport can route before MCP auth.
  owns: (pathname: string) => boolean;
  handle: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  // True when `token` is a live access token issued for this server's MCP endpoint.
  verify: (token: string) => boolean;
  // The WWW-Authenticate value for a 401. `presented` adds the RFC 6750 invalid_token error.
  challenge: (presented: boolean) => string;
};

export type OAuthOptions = {
  now?: () => number;
  log?: OAuthLog;
  // Injection point for tests; production uses the process-wide fetch.
  fetchClientMetadata?: CimdFetch;
};

// CORS only on the public discovery documents, so a browser-based client (an MCP inspector, say)
// can read them. Registration, authorization and token endpoints stay same-origin: a
// browser-based client is not a supported deployment, and these carry or mint credentials.
const DISCOVERY_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
};

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => unknown;

function resourceMetadata(config: OAuthConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.origin],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
    resource_name: 'TaskFerry MCP',
  };
}

function serverMetadata(config: OAuthConfig) {
  return {
    issuer: config.origin,
    authorization_endpoint: `${config.origin}/oauth/authorize`,
    token_endpoint: `${config.origin}/oauth/token`,
    registration_endpoint: `${config.origin}/oauth/register`,
    revocation_endpoint: `${config.origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES_SUPPORTED,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

function discovery(body: unknown): Handler {
  return (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...SECURITY_HEADERS, ...DISCOVERY_HEADERS });
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, OPTIONS');
    return sendJson(res, 200, body, DISCOVERY_HEADERS);
  };
}

async function readRegistration(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<unknown> {
  try {
    return JSON.parse(await readBody(req, res));
  } catch (error) {
    return error instanceof BodyTooLargeError ? error : undefined;
  }
}

function register(deps: OAuthDeps): Handler {
  return async (req, res) => {
    if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      return sendOAuthError(res, 400, 'invalid_client_metadata', 'send application/json');
    }
    const body = await readRegistration(req, res);
    if (body instanceof BodyTooLargeError) {
      return sendOAuthError(res, 413, 'invalid_client_metadata', 'request too large');
    }
    const parsed = parseRegistration(body, deps.config.redirects);
    if (!parsed.ok) return sendOAuthError(res, 400, parsed.error, parsed.description);
    try {
      const client = deps.store.registerClient(parsed.value);
      deps.log('registered', { client_id: client.clientId });
      return sendJson(res, 201, {
        client_id: client.clientId,
        client_name: client.clientName,
        client_id_issued_at: Math.floor(client.createdAt / 1000),
        redirect_uris: client.redirectUris,
        grant_types: parsed.value.grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    } catch (error) {
      if (!(error instanceof StoreFullError)) throw error;
      return sendOAuthError(res, 503, 'temporarily_unavailable', 'too many registered clients');
    }
  };
}

function buildRoutes(deps: OAuthDeps): Record<string, Handler> {
  const { config } = deps;
  const prm = discovery(resourceMetadata(config));
  return {
    '/.well-known/oauth-protected-resource': prm,
    '/.well-known/oauth-protected-resource/mcp': prm,
    '/.well-known/oauth-authorization-server': discovery(serverMetadata(config)),
    '/oauth/register': register(deps),
    '/oauth/authorize': (req, res, url) => handleAuthorize(deps, req, res, url),
    '/oauth/token': (req, res) => handleToken(deps, req, res),
    '/oauth/revoke': (req, res) => handleRevoke(deps, req, res),
  };
}

export function createOAuth(config: OAuthConfig, options: OAuthOptions = {}): OAuth {
  const now = options.now ?? Date.now;
  const store = new OAuthStore(config.statePath, now);
  const log = options.log ?? consoleLog;
  const cimd = new CimdResolver({
    log,
    now,
    redirects: config.redirects,
    fetch: options.fetchClientMetadata,
  });
  const deps: OAuthDeps = {
    config,
    store,
    log,
    limiter: new FailureLimiter(FAILURES_ALLOWED, FAILURE_WINDOW_MS, now),
    resolveClient: async (clientId) => store.getClient(clientId) ?? (await cimd.resolve(clientId)),
  };
  const routes = buildRoutes(deps);
  const metadataUrl = `${config.origin}/.well-known/oauth-protected-resource/mcp`;
  return {
    config,
    store,
    owns: (pathname) => Object.hasOwn(routes, pathname),
    async handle(req, res) {
      const url = new URL(req.url ?? '/', config.origin);
      await routes[url.pathname](req, res, url);
    },
    verify: (token) => store.verifyAccess(token, config.resource) !== undefined,
    challenge: (presented) =>
      `Bearer resource_metadata="${metadataUrl}"${presented ? ', error="invalid_token"' : ''}`,
  };
}
