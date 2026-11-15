// Counts failed approval attempts in a sliding window and reports when the page should refuse
// to check the secret at all. It is deliberately global: behind a tunnel every request arrives
// from the same address, so a per-client limit would limit nothing.
export class FailureLimiter {
  private readonly times: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  // Seconds until another attempt is allowed, or 0 when one is.
  retryAfterSeconds(): number {
    const t = this.now();
    while (this.times.length > 0 && this.times[0] + this.windowMs <= t) this.times.shift();
    if (this.times.length < this.max) return 0;
    return Math.ceil((this.times[0] + this.windowMs - t) / 1000);
  }

  fail() {
    this.times.push(this.now());
  }

  reset() {
    this.times.length = 0;
  }
}
