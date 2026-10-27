import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

export type CallbackFailureReason =
  'challenge_failed' | 'timeout' | 'connection_refused' | 'tls_error' | 'http_4xx' | 'http_5xx';

export class CallbackError extends Error {
  readonly reason: CallbackFailureReason;

  constructor(reason: CallbackFailureReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CallbackError';
    this.reason = reason;
  }
}

export type CallbackRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

export type CallbackResponse = { status: number; body: string };
export type CallbackSender = (request: CallbackRequest) => Promise<CallbackResponse>;

export const MAX_EVENT_BYTES = 256 * 1024;
export const MAX_CALLBACK_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 5_000;

function ipv4Number(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  if (!octets.every((part) => part >= 0 && part <= 255)) return null;
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function ipv4Range(a: number, b: number, c: number, d: number, bits: number): [number, number] {
  const start = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return [start, start + 2 ** (32 - bits) - 1];
}

const BLOCKED_IPV4: readonly (readonly [number, number])[] = [
  ipv4Range(0, 0, 0, 0, 8),
  ipv4Range(10, 0, 0, 0, 8),
  ipv4Range(100, 64, 0, 0, 10),
  ipv4Range(127, 0, 0, 0, 8),
  ipv4Range(169, 254, 0, 0, 16),
  ipv4Range(172, 16, 0, 0, 12),
  ipv4Range(192, 0, 0, 0, 24),
  ipv4Range(192, 0, 2, 0, 24),
  ipv4Range(192, 88, 99, 0, 24),
  ipv4Range(192, 168, 0, 0, 16),
  ipv4Range(198, 18, 0, 0, 15),
  ipv4Range(198, 51, 100, 0, 24),
  ipv4Range(203, 0, 113, 0, 24),
  ipv4Range(224, 0, 0, 0, 4),
  ipv4Range(240, 0, 0, 0, 4),
];

function isPublicIPv4(address: string): boolean {
  const number = ipv4Number(address);
  if (number === null) return false;
  return !BLOCKED_IPV4.some(([start, end]) => number >= start && number <= end);
}

type Halves = { left: string[]; right: string[]; compressed: boolean };

function splitIPv6(value: string): Halves | null {
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  return { left, right, compressed: halves.length === 2 };
}

function expandIPv6(address: string): number[] | null {
  const clean = address.toLowerCase().split('%')[0];
  if (!clean) return null;
  const halves = splitIPv6(clean);
  if (!halves) return null;
  const dotted = halves.right[halves.right.length - 1]?.includes('.') ? 1 : 0;
  const missing = 8 - halves.left.length - halves.right.length - dotted;
  if (halves.compressed ? missing < 0 : missing !== 0) return null;
  const tokens = [...halves.left, ...Array<string>(missing).fill('0'), ...halves.right];
  const last = tokens[tokens.length - 1];
  if (last?.includes('.')) {
    const ipv4 = ipv4Number(last);
    if (ipv4 === null) return null;
    tokens.splice(tokens.length - 1, 1, (ipv4 >>> 16).toString(16), (ipv4 & 0xffff).toString(16));
  }
  const words = tokens.map((word) =>
    /^[0-9a-f]{1,4}$/.test(word) ? Number.parseInt(word, 16) : -1,
  );
  return words.length === 8 && words.every((word) => word >= 0) ? words : null;
}

function embeddedIPv4(high: number, low: number) {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

type Prefix = { words: readonly number[]; bits: number };

function matchesPrefix(words: readonly number[], prefix: Prefix): boolean {
  let remaining = prefix.bits;
  let index = 0;
  while (remaining > 0) {
    const take = Math.min(16, remaining);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((words[index] & mask) !== (prefix.words[index] & mask)) return false;
    remaining -= take;
    index += 1;
  }
  return true;
}

const BLOCKED_IPV6: readonly Prefix[] = [
  { words: [0xfc00], bits: 7 },
  { words: [0xfe80], bits: 10 },
  { words: [0xfec0], bits: 10 },
  { words: [0xff00], bits: 8 },
  { words: [0x0100, 0, 0, 0], bits: 64 },
  { words: [0x2001, 0x0db8], bits: 32 },
  { words: [0x2001, 0x0000], bits: 32 },
  { words: [0x2001, 0x0002], bits: 48 },
  { words: [0x2001, 0x0010], bits: 28 },
  { words: [0x2001, 0x0020], bits: 28 },
  { words: [0x3fff, 0], bits: 20 },
  { words: [0x0064, 0xff9b, 0x0001], bits: 48 },
];
const MAPPED_PREFIX: Prefix = { words: [0, 0, 0, 0, 0, 0xffff], bits: 96 };
const TRANSLATED_PREFIX: Prefix = { words: [0, 0, 0, 0, 0xffff, 0], bits: 96 };
const NAT64_PREFIX: Prefix = { words: [0x0064, 0xff9b], bits: 96 };

// Reject every IPv6 range that is not globally routable unicast. IPv4-embedding forms are
// unwrapped and checked against the IPv4 rules rather than being trusted as "IPv6".
function isPublicIPv6(address: string): boolean {
  const words = expandIPv6(address);
  if (!words) return false;
  if (words.every((word) => word === 0)) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return false;
  if (matchesPrefix(words, MAPPED_PREFIX)) return isPublicIPv4(embeddedIPv4(words[6], words[7]));
  if (matchesPrefix(words, TRANSLATED_PREFIX)) {
    return isPublicIPv4(embeddedIPv4(words[6], words[7]));
  }
  if (words.slice(0, 6).every((word) => word === 0)) {
    return isPublicIPv4(embeddedIPv4(words[6], words[7]));
  }
  if (words[0] === 0x2002) return isPublicIPv4(embeddedIPv4(words[1], words[2]));
  if (matchesPrefix(words, NAT64_PREFIX)) return isPublicIPv4(embeddedIPv4(words[6], words[7]));
  return !BLOCKED_IPV6.some((prefix) => matchesPrefix(words, prefix));
}

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family === 6) return isPublicIPv6(address);
  return false;
}

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.test',
  '.invalid',
];

function validateHostname(hostname: string) {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!host) throw new CallbackError('challenge_failed', 'callback URL has no host');
  if (net.isIP(host)) return host;
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new CallbackError('challenge_failed', 'callback URL host is not public');
  }
  if (!host.includes('.')) {
    throw new CallbackError('challenge_failed', 'callback URL host must be fully qualified');
  }
  return host;
}

export type CallbackTarget = { url: URL; host: string; address: string; family: 4 | 6 };

export function validateCallbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new CallbackError('challenge_failed', 'callback URL is invalid', { cause: error });
  }
  if (url.protocol !== 'https:') {
    throw new CallbackError('challenge_failed', 'callback URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new CallbackError('challenge_failed', 'callback URL must not contain credentials');
  }
  validateHostname(url.hostname);
  return url;
}

// Resolve every address for the host and require all of them to be public. A hostname that
// resolves to a private address is rejected even if another answer would have been fine. DNS is
// bounded because an unresponsive resolver would otherwise stall verification indefinitely.
export async function resolveCallbackTarget(raw: string): Promise<CallbackTarget> {
  const url = validateCallbackUrl(raw);
  const host = validateHostname(url.hostname);
  let records: { address: string; family: number }[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    records = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new CallbackError('timeout', 'callback host lookup timed out')),
          DNS_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (error instanceof CallbackError) throw error;
    throw new CallbackError('connection_refused', 'callback host could not be resolved', {
      cause: error,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (records.length === 0) {
    throw new CallbackError('connection_refused', 'callback host has no addresses');
  }
  for (const record of records) {
    if (!isPublicAddress(record.address)) {
      throw new CallbackError('challenge_failed', 'callback host resolves to a non-public address');
    }
  }
  const chosen = records.find((record) => record.family === 4) ?? records[0];
  return { url, host, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

function reasonForError(error: unknown): CallbackFailureReason {
  if (error instanceof CallbackError) return error.reason;
  const code = (error as { code?: string } | undefined)?.code ?? '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (code.startsWith('ERR_TLS') || code.startsWith('CERT_') || code.includes('SELF_SIGNED')) {
    return 'tls_error';
  }
  return 'connection_refused';
}

function readResponse(response: import('node:http').IncomingMessage) {
  return new Promise<CallbackResponse>((resolve, reject) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_CALLBACK_RESPONSE_BYTES) {
        response.destroy(new CallbackError('challenge_failed', 'callback response is too large'));
      }
    });
    response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    response.on('error', reject);
  });
}

function handleResponse(
  response: import('node:http').IncomingMessage,
  resolve: (value: CallbackResponse) => void,
  reject: (error: unknown) => void,
) {
  readResponse(response).then(resolve, reject);
}

export type PinnedLookup = (
  hostname: string,
  options: unknown,
  callback: (...args: unknown[]) => void,
) => void;

// Node 20+ may call lookup with `{ all: true }` because of autoSelectFamily. Returning a scalar
// address in that mode throws ERR_INVALID_IP_ADDRESS before the socket is opened.
export function pinnedLookup(target: CallbackTarget): PinnedLookup {
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options !== null && (options as { all?: boolean }).all) {
      callback(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  };
}

function requestOptions(target: CallbackTarget, request: CallbackRequest): https.RequestOptions {
  return {
    protocol: 'https:',
    hostname: target.host,
    port: target.url.port || 443,
    path: `${target.url.pathname}${target.url.search}`,
    method: 'POST',
    headers: { ...request.headers, 'Content-Length': Buffer.byteLength(request.body) },
    agent: false,
    lookup: pinnedLookup(target) as NonNullable<https.RequestOptions['lookup']>,
  };
}

// DNS is pinned to the address that was just validated so a second lookup cannot swap in a
// private address. SNI still uses the original hostname. Redirects are never followed. The timer
// is a wall-clock deadline, not socket idleness: a callback that trickles bytes cannot keep the
// request alive forever.
function performRequest(target: CallbackTarget, request: CallbackRequest) {
  return new Promise<CallbackResponse>((resolve, reject) => {
    let settled = false;
    const finish = <T>(fn: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (error: unknown) => {
      finish(
        reject,
        error instanceof CallbackError
          ? error
          : new CallbackError(reasonForError(error), 'callback request failed', { cause: error }),
      );
    };
    const req = https.request(requestOptions(target, request), (response) =>
      handleResponse(response, (value) => finish(resolve, value), fail),
    );
    const timer = setTimeout(
      () => req.destroy(new CallbackError('timeout', 'callback request timed out')),
      request.timeoutMs || DEFAULT_TIMEOUT_MS,
    );
    timer.unref?.();
    req.on('error', fail);
    req.end(request.body);
  });
}

export const postCallback: CallbackSender = async (request) => {
  const target = await resolveCallbackTarget(request.url);
  return performRequest(target, request);
};

export function parseWebhookSecret(secret: string): Buffer | undefined {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return undefined;
  const encoded = secret.slice('whsec_'.length);
  if (encoded.length % 4 !== 0) return undefined;
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64) return undefined;
  return key;
}

export function signWebhook(key: Buffer, id: string, timestamp: number, body: string): string {
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${signature}`;
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function statusFailure(status: number): CallbackError | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status >= 500) return new CallbackError('http_5xx', `callback returned HTTP ${status}`);
  return new CallbackError('http_4xx', `callback returned HTTP ${status}`);
}
