import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { OAuthConfig } from '../src/oauth-config.ts';
import { startSurfaces } from '../src/server.ts';
import {
  GATEWAY_TOKEN,
  HEALTH,
  bridgeConfig,
  createSkillRoot,
  freePort,
  mcpUrl,
  okReply,
  removeDir,
  send,
  stubDaemon,
  tempDir,
  toolCall,
  type Sent,
} from './helpers.ts';

export const APPROVAL_SECRET = 'owner-approval-secret-0123456789';
export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
export const LOOPBACK_CALLBACK = 'http://127.0.0.1:53682/callback';
export const ROUTE = {
  prm: '/.well-known/oauth-protected-resource',
  prmMcp: '/.well-known/oauth-protected-resource/mcp',
  metadata: '/.well-known/oauth-authorization-server',
  register: '/oauth/register',
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  revoke: '/oauth/revoke',
};
export const PUBLIC_HOST = 'mcp.example.com';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

export type OAuthFixture = Awaited<ReturnType<typeof oauthFixture>>;

// A bridge with OAuth on, listening on a loopback TCP port that is also its public origin, in
// front of a stub daemon that answers every request as healthy. It starts through startSurfaces,
// the same entry the executable uses, so `gateway: true` brings up the second surface too.
export async function oauthFixture(
  overrides: Partial<OAuthConfig> = {},
  options: { gateway?: boolean } = {},
) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const stateDir = tempDir('tf-oauth-http-');
  const skillRoot = createSkillRoot();
  const daemon = await stubDaemon((req) => okReply(req, { healthy: true }));
  const oauth: OAuthConfig = {
    origin,
    hostname: '127.0.0.1',
    resource: `${origin}/mcp`,
    approvalSecret: APPROVAL_SECRET,
    redirects: { exact: [CLAUDE_CALLBACK], loopback: true },
    statePath: path.join(stateDir, 'oauth.json'),
    ...overrides,
  };
  const config = bridgeConfig({
    skillRoot,
    oauth,
    daemonSocket: daemon.socket,
    allowDirectories: [daemon.dir],
    listen: { kind: 'tcp', port },
    ...(options.gateway ? { gateway: { token: GATEWAY_TOKEN, port: 0 } } : {}),
  });
  const surfaces = await startSurfaces(config);
  const url = (route: string) => `${origin}${route}`;
  const close = async () => {
    await surfaces.close();
    await daemon.close();
    removeDir(stateDir);
    removeDir(skillRoot);
  };
  const gatewayUrl = surfaces.gateway ? mcpUrl(surfaces.gateway) : undefined;
  return { origin, url, oauth, config, daemon, stateDir, close, gatewayUrl, mcp: url('/mcp') };
}

export const pkce = () => {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

export const json = (sent: Sent) => JSON.parse(sent.text) as Record<string, unknown>;

export const getPage = (url: string) => send(url, '', { token: null, method: 'GET', headers: {} });

export const postForm = (
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) =>
  send(url, new URLSearchParams(fields).toString(), {
    token: null,
    headers: { ...FORM, ...headers },
  });

export const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  send(url, JSON.stringify(body), { token: null, headers });

export async function registerClient(
  f: OAuthFixture,
  body: Record<string, unknown> = {},
): Promise<string> {
  const sent = await postJson(f.url(ROUTE.register), {
    client_name: 'Test client',
    redirect_uris: [CLAUDE_CALLBACK],
    ...body,
  });
  if (sent.status !== 201) throw new Error(`registration failed: ${sent.status} ${sent.text}`);
  return json(sent).client_id as string;
}

export function authorizeUrl(f: OAuthFixture, params: Record<string, string>) {
  const url = new URL(f.url(ROUTE.authorize));
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.href;
}

export const requestId = (html: string) => /name="request_id" value="([^"]+)"/.exec(html)?.[1];

export const location = (sent: Sent) => new URL(sent.headers.location as string);

export type SignIn = {
  clientId: string;
  verifier: string;
  redirectUri: string;
  code: string;
};

// Registers a client and walks the owner through approval, stopping at the authorization code.
export async function approve(
  f: OAuthFixture,
  options: { redirectUri?: string; state?: string } = {},
): Promise<SignIn> {
  const redirectUri = options.redirectUri ?? CLAUDE_CALLBACK;
  const clientId = await registerClient(f, { redirect_uris: [redirectUri] });
  const { verifier, challenge } = pkce();
  const page = await getPage(
    authorizeUrl(f, {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: f.oauth.resource,
      state: options.state ?? 'state-1',
    }),
  );
  const id = requestId(page.text);
  if (!id) throw new Error(`no consent page: ${page.status} ${page.text}`);
  const decided = await postForm(f.url(ROUTE.authorize), {
    request_id: id,
    decision: 'approve',
    secret: APPROVAL_SECRET,
  });
  const code = location(decided).searchParams.get('code');
  if (!code) throw new Error(`no code: ${decided.status} ${decided.headers.location}`);
  return { clientId, verifier, redirectUri, code };
}

export const exchange = (f: OAuthFixture, s: SignIn, overrides: Record<string, string> = {}) =>
  postForm(f.url(ROUTE.token), {
    grant_type: 'authorization_code',
    client_id: s.clientId,
    code: s.code,
    code_verifier: s.verifier,
    redirect_uri: s.redirectUri,
    ...overrides,
  });

export const refresh = (f: OAuthFixture, clientId: string, token: string, extra = {}) =>
  postForm(f.url(ROUTE.token), {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: token,
    ...extra,
  });

// One health call over MCP with an arbitrary bearer token.
export const mcpHealth = (f: OAuthFixture, token: string | null) =>
  send(f.mcp, toolCall(HEALTH), { token });
