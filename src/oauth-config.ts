import { homedir } from 'node:os';
import path from 'node:path';
import { ConfigError } from './errors.ts';
import {
  absolute,
  asString,
  firstFound,
  fromEnv,
  type Env,
  type FileConfig,
} from './config-primitives.ts';
import { resolveToken } from './token.ts';

// What the OAuth surface needs beyond the static bearer token. It exists only when a public URL
// is configured: without one the bridge behaves exactly as it did before OAuth was added.
export type RedirectRules = { exact: string[]; loopback: boolean };
export type OAuthConfig = {
  // Scheme and host of the public URL, no trailing slash. Also the OAuth issuer.
  origin: string;
  hostname: string;
  // The MCP endpoint as clients see it: `${origin}/mcp`. Tokens are bound to this value.
  resource: string;
  approvalSecret: string;
  redirects: RedirectRules;
  statePath: string;
};

export const MIN_APPROVAL_SECRET_CHARS = 24;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const APP_DIR = 'taskferry-mcp';
const LOOPBACK_KEYWORD = 'loopback';

// Claude's hosted surfaces (claude.ai, Desktop, mobile) share one callback; the second is the
// documented future host. Claude Code uses a loopback redirect on an ephemeral port. Anything
// else, including another MCP client, has to be added on purpose.
export const DEFAULT_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  LOOPBACK_KEYWORD,
];

export const isLoopbackHost = (hostname: string) => LOOPBACK_HOSTS.includes(hostname);

// Parses an http(s) URL that may carry a redirect or a public origin. https is required except for
// a loopback host, which RFC 8252 allows over http. Credentials and fragments are never valid.
export function parseWebUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (e) {
    throw new ConfigError(`${name} is not a valid URL: ${JSON.stringify(value)}`, { cause: e });
  }
  const secure = url.protocol === 'https:';
  const loopbackHttp = url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if (!secure && !loopbackHttp) {
    throw new ConfigError(`${name} must be https (http only for loopback), got ${value}`);
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new ConfigError(`${name} must not carry credentials or a fragment, got ${value}`);
  }
  return url;
}

function parsePublicUrl(value: string): { origin: string; hostname: string } {
  const url = parseWebUrl('public URL', value);
  if (url.pathname !== '/' || url.search !== '') {
    throw new ConfigError(
      `public URL must be a bare origin such as https://mcp.example.com, got ${value}; the MCP endpoint is always /mcp`,
    );
  }
  return { origin: url.origin, hostname: url.hostname };
}

function asList(value: unknown): unknown[] | undefined {
  if (typeof value === 'string') return value.split(',').map((item) => item.trim());
  return Array.isArray(value) ? value : undefined;
}

function asRedirects(value: unknown): RedirectRules {
  const items = asList(value);
  if (!items || items.length === 0 || !items.every((i) => typeof i === 'string' && i !== '')) {
    throw new ConfigError('OAuth allowed redirects must be a list of non-empty strings');
  }
  const rules: RedirectRules = { exact: [], loopback: false };
  for (const item of items as string[]) {
    if (item === LOOPBACK_KEYWORD) rules.loopback = true;
    else rules.exact.push(parseWebUrl('OAuth allowed redirect', item).href);
  }
  return rules;
}

function defaultStatePath(env: Env) {
  const base = env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
  return path.join(base, APP_DIR, 'oauth.json');
}

export type OAuthFlags = {
  'public-url'?: string;
  'oauth-secret-file'?: string;
  'oauth-allowed-redirects'?: string;
  'oauth-state'?: string;
};

// OAuth turns on when a public URL is set and the approval secret exists. Any OAuth setting
// without a public URL is an error, not a silently ignored knob, the same way a gateway port
// without a gateway token is.
export function resolveOAuth(
  flags: OAuthFlags,
  env: Env,
  file: FileConfig,
  others: { token: string; gatewayToken: string | undefined },
): OAuthConfig | undefined {
  const publicUrl = firstFound<unknown>(
    flags['public-url'],
    fromEnv(env, 'TASKFERRY_MCP_PUBLIC_URL'),
    file.publicUrl,
  );
  const secretFile = firstFound<unknown>(
    flags['oauth-secret-file'],
    fromEnv(env, 'TASKFERRY_MCP_OAUTH_SECRET_FILE'),
    file.oauthSecretFile,
  );
  const redirects = firstFound<unknown>(
    flags['oauth-allowed-redirects'],
    fromEnv(env, 'TASKFERRY_MCP_OAUTH_ALLOWED_REDIRECTS'),
    file.oauthAllowedRedirects,
  );
  const state = firstFound<unknown>(
    flags['oauth-state'],
    fromEnv(env, 'TASKFERRY_MCP_OAUTH_STATE'),
    file.oauthStatePath,
  );
  const direct = fromEnv(env, 'TASKFERRY_MCP_OAUTH_SECRET');
  if (!publicUrl) {
    if (secretFile || direct !== undefined || redirects || state) {
      throw new ConfigError(
        'OAuth settings need a public URL: set TASKFERRY_MCP_PUBLIC_URL (or --public-url)',
      );
    }
    return undefined;
  }
  const { origin, hostname } = parsePublicUrl(asString('public URL', publicUrl.value));
  const approvalSecret = resolveToken({
    env,
    directName: 'TASKFERRY_MCP_OAUTH_SECRET',
    flagName: '--oauth-secret-file',
    fileEnvName: 'TASKFERRY_MCP_OAUTH_SECRET_FILE',
    label: 'OAuth approval secret',
    tokenFile: secretFile,
  });
  validateApprovalSecret(approvalSecret, others);
  return {
    origin,
    hostname,
    approvalSecret,
    resource: `${origin}/mcp`,
    redirects: asRedirects(redirects ? redirects.value : DEFAULT_REDIRECTS),
    statePath: state
      ? absolute('OAuth state path', asString('OAuth state path', state.value))
      : defaultStatePath(env),
  };
}

function validateApprovalSecret(
  secret: string,
  others: { token: string; gatewayToken: string | undefined },
) {
  if (secret.length < MIN_APPROVAL_SECRET_CHARS) {
    throw new ConfigError(
      `OAuth approval secret must be at least ${MIN_APPROVAL_SECRET_CHARS} characters; generate one with: openssl rand -base64 32`,
    );
  }
  if (secret === others.token || secret === others.gatewayToken) {
    throw new ConfigError(
      'OAuth approval secret must differ from the bridge and gateway tokens: it is typed into a web page, the tokens are not',
    );
  }
}
