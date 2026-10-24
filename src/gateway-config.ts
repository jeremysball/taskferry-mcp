import { ConfigError } from './errors.ts';
import { asPort, firstFound, fromEnv, type Env, type FileConfig } from './config-primitives.ts';
import { resolveToken } from './token.ts';

export type GatewayConfig = { token: string; port: number };
const DEFAULT_GATEWAY_PORT = 8788;

// The gateway surface exists only when its token is configured. A port without a token is a
// configuration mistake, not a request to start an unauthenticated listener.
export function resolveGateway(
  flags: { 'gateway-port'?: string; 'gateway-token-file'?: string },
  env: Env,
  file: FileConfig,
): GatewayConfig | undefined {
  if (fromEnv(env, 'TASKFERRY_UPSTREAM_URL') !== undefined) {
    throw new ConfigError(
      'TASKFERRY_UPSTREAM_URL is no longer supported: the gateway serves the local daemon in this process; remove it',
    );
  }
  const direct = fromEnv(env, 'TASKFERRY_GATEWAY_TOKEN');
  const tokenFile = firstFound<unknown>(
    flags['gateway-token-file'],
    fromEnv(env, 'TASKFERRY_GATEWAY_TOKEN_FILE'),
    file.gatewayTokenFile,
  );
  const port = firstFound<unknown>(
    flags['gateway-port'],
    fromEnv(env, 'TASKFERRY_GATEWAY_PORT'),
    file.gatewayPort,
  );
  if (direct === undefined && tokenFile === undefined) {
    if (port !== undefined) {
      throw new ConfigError(
        'gateway port set but no gateway token: set TASKFERRY_GATEWAY_TOKEN, or pass --gateway-token-file / set TASKFERRY_GATEWAY_TOKEN_FILE',
      );
    }
    return undefined;
  }
  return {
    token: resolveToken({
      directName: 'TASKFERRY_GATEWAY_TOKEN',
      flagName: '--gateway-token-file',
      fileEnvName: 'TASKFERRY_GATEWAY_TOKEN_FILE',
      label: 'gateway token',
      env,
      tokenFile,
    }),
    port: port ? asPort('gateway port', port.value) : DEFAULT_GATEWAY_PORT,
  };
}
