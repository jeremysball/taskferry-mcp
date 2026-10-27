import { randomBytes, randomUUID } from 'node:crypto';
import {
  CallbackError,
  safeEqual,
  signWebhook,
  statusFailure,
  type CallbackSender,
} from './webhook.ts';

export type VerificationOptions = {
  sender: CallbackSender;
  timeoutMs: number;
};

// A fresh single-use challenge per call. The caller must not log the body, challenge, URL, or
// secret: a failed verification is reported only by its categorized reason.
export async function verifyCallback(
  target: { url: string; secret: Buffer; subscriptionId: string },
  options: VerificationOptions,
): Promise<void> {
  const challenge = randomBytes(32).toString('base64url');
  const body = JSON.stringify({ type: 'verification', challenge });
  const webhookId = `msg_verification_${randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  let response;
  try {
    response = await options.sender({
      body,
      url: target.url,
      timeoutMs: options.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'webhook-id': webhookId,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': signWebhook(target.secret, webhookId, timestamp, body),
        'X-MCP-Subscription-Id': target.subscriptionId,
      },
    });
  } catch (error) {
    if (error instanceof CallbackError) throw error;
    throw new CallbackError('connection_refused', 'callback verification failed', { cause: error });
  }
  const failure = statusFailure(response.status);
  if (failure) throw failure;
  let echoed: unknown;
  try {
    echoed = JSON.parse(response.body);
  } catch (error) {
    throw new CallbackError('challenge_failed', 'callback did not echo the challenge', {
      cause: error,
    });
  }
  if (
    typeof echoed !== 'object' ||
    echoed === null ||
    typeof (echoed as { challenge?: unknown }).challenge !== 'string' ||
    !safeEqual(challenge, (echoed as { challenge: string }).challenge)
  ) {
    throw new CallbackError('challenge_failed', 'callback did not echo the challenge');
  }
}

const MAX_CACHE_ENTRIES = 1000;

export class VerificationCache {
  private readonly entries = new Map<string, number>();

  get(key: string, now: number): boolean {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  set(key: string, expiresAt: number) {
    if (this.entries.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, expiresAt);
  }
}
