import type { Clock, VehicleLock } from "./types.js";

interface LockEntry {
  ownerToken: string;
  expiresAt: number;
}

/** Atomic keyed mutex with expiring ownership for this Node process. */
export class InMemoryVehicleLock implements VehicleLock {
  private readonly locks = new Map<string, LockEntry>();

  constructor(private readonly clock: Clock) {}

  async acquire(
    key: string,
    ownerToken: string,
    ttlMs: number,
  ): Promise<boolean> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("Lock TTL must be a positive finite number");
    }

    const now = this.clock.now();
    const existing = this.locks.get(key);
    if (existing && existing.expiresAt > now) {
      return false;
    }

    // Compare-and-set happens synchronously with no await between read/write.
    this.locks.set(key, { ownerToken, expiresAt: now + ttlMs });
    return true;
  }

  async release(key: string, ownerToken: string): Promise<boolean> {
    const existing = this.locks.get(key);
    if (
      !existing ||
      existing.ownerToken !== ownerToken ||
      existing.expiresAt <= this.clock.now()
    ) {
      return false;
    }

    // Redis equivalent: SET lock:<key> <token> NX PX <ttl>; release with a
    // Lua script that DELs only when GET lock:<key> equals the supplied token.
    this.locks.delete(key);
    return true;
  }
}
