import type {
  CheckoutResponse,
  IdempotencyClaim,
  IdempotencyStore,
} from "./types.js";

interface IdempotencyEntry {
  payloadFingerprint: string;
  state: "in_progress" | "completed";
  response?: CheckoutResponse;
}

/**
 * Single-process implementation. The check-and-set section contains no await,
 * so JavaScript's run-to-completion semantics make each claim atomic in this
 * process. A multi-process deployment must use a shared atomic store (for
 * example, PostgreSQL INSERT ... ON CONFLICT or Redis SET NX).
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, IdempotencyEntry>();

  async claim(
    key: string,
    payloadFingerprint: string,
  ): Promise<IdempotencyClaim> {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.payloadFingerprint !== payloadFingerprint) {
        return { kind: "payload_mismatch" };
      }
      if (existing.state === "in_progress") {
        return { kind: "in_progress" };
      }
      if (existing.response) {
        return {
          kind: "replay",
          response: structuredClone(existing.response),
        };
      }
      return { kind: "in_progress" };
    }

    // This synchronous map insertion is the atomic claim; never split it into
    // a get followed by a later set that could race with another request.
    this.entries.set(key, {
      payloadFingerprint,
      state: "in_progress",
    });
    return { kind: "claimed" };
  }

  async complete(
    key: string,
    payloadFingerprint: string,
    response: CheckoutResponse,
  ): Promise<void> {
    const isFinalResult =
      response.status === 200 ||
      (response.status === 409 && response.body.code === "VEHICLE_UNAVAILABLE");
    if (!isFinalResult) {
      throw new Error("Only successful or vehicle-unavailable responses may be cached");
    }

    const existing = this.entries.get(key);
    if (!existing || existing.payloadFingerprint !== payloadFingerprint) {
      throw new Error("Cannot complete an unclaimed idempotency key");
    }
    if (existing.state === "completed") {
      return;
    }
    this.entries.set(key, {
      payloadFingerprint,
      state: "completed",
      response: structuredClone(response),
    });
  }

  async abandon(key: string, payloadFingerprint: string): Promise<void> {
    const existing = this.entries.get(key);
    if (
      existing &&
      existing.state === "in_progress" &&
      existing.payloadFingerprint === payloadFingerprint
    ) {
      this.entries.delete(key);
    }
  }
}
