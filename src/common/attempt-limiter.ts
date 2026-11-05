import { HttpException, HttpStatus } from '@nestjs/common'

/**
 * Counts wrong guesses per key (an email address, a user id) and locks that key
 * for a while after too many. Kept in memory, which is fine for one server;
 * move it to Redis if you ever run more than one instance.
 */
export class AttemptLimiter {
  private entries = new Map<string, { count: number; first: number; lockedUntil: number }>()

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly lockMs: number,
    private readonly message: string,
  ) {}

  /** Throws 429 if this key is currently locked. */
  assertAllowed(key: string) {
    const e = this.entries.get(key)
    if (e && e.lockedUntil > Date.now()) {
      throw new HttpException(this.message, HttpStatus.TOO_MANY_REQUESTS)
    }
  }

  fail(key: string) {
    const now = Date.now()
    let e = this.entries.get(key)
    if (!e || now - e.first > this.windowMs) {
      e = { count: 0, first: now, lockedUntil: 0 }
    }
    e.count += 1
    if (e.count >= this.maxFailures) {
      e.lockedUntil = now + this.lockMs
      e.count = 0
      e.first = now
    }
    this.entries.set(key, e)
    if (this.entries.size > 10000) this.prune(now)
  }

  success(key: string) {
    this.entries.delete(key)
  }

  private prune(now: number) {
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= now && now - e.first > this.windowMs) this.entries.delete(k)
    }
  }
}