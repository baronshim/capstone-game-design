/** Sliding-window counter per key in isolate memory: best effort, resets when the isolate restarts (spec 4.5). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  /** Records a hit for `key` and returns whether it is within the limit. A limit of 0 or less disables the limiter. */
  allow(key: string, now: number): boolean {
    if (this.limit <= 0) return true;
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
