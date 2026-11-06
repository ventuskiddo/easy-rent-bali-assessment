import type {
  PaymentGateway,
  RandomSource,
  Sleeper,
} from "./types.js";

interface AuthorizationState {
  idempotencyKey: string;
  amountCents: number;
  state: "authorized" | "captured" | "voided";
}

export interface MockPaymentGatewayOptions {
  sleeper: Sleeper;
  random: RandomSource;
  /** Maximum additional random delay; each gateway call waits at least 1 ms. */
  maxLatencyMs?: number;
}

/** In-memory gateway mock with provider-style idempotency and call counters. */
export class MockPaymentGateway implements PaymentGateway {
  private readonly authorizations = new Map<string, AuthorizationState>();
  private nextAuthorizationNumber = 1;
  private successfulCaptureCount = 0;
  private captureCallCount = 0;
  private voidCallCount = 0;
  private readonly maxLatencyMs: number;

  constructor(private readonly options: MockPaymentGatewayOptions) {
    this.maxLatencyMs = options.maxLatencyMs ?? 8;
  }

  get captureCount(): number {
    return this.successfulCaptureCount;
  }

  get captureCalls(): number {
    return this.captureCallCount;
  }

  get voidCalls(): number {
    return this.voidCallCount;
  }

  async authorize(input: {
    idempotency_key: string;
    booking_id: string;
    customer_id: string;
    amount_cents: number;
  }): Promise<{ authorization_id: string }> {
    await this.addLatency();
    const existing = this.findByKey(input.idempotency_key);
    if (existing) {
      if (existing.amountCents !== input.amount_cents) {
        throw new Error("Payment idempotency key reused with a different amount");
      }
      return { authorization_id: existing.id };
    }

    const authorizationId = `auth_${this.nextAuthorizationNumber++}`;
    this.authorizations.set(authorizationId, {
      idempotencyKey: input.idempotency_key,
      amountCents: input.amount_cents,
      state: "authorized",
    });
    return { authorization_id: authorizationId };
  }

  async capture(input: {
    idempotency_key: string;
    authorization_id: string;
    amount_cents: number;
  }): Promise<void> {
    this.captureCallCount += 1;
    await this.addLatency();
    const authorization = this.authorizations.get(input.authorization_id);
    if (
      !authorization ||
      authorization.idempotencyKey !== input.idempotency_key ||
      authorization.amountCents !== input.amount_cents ||
      authorization.state === "voided"
    ) {
      throw new Error("Cannot capture an invalid or voided authorization");
    }
    if (authorization.state === "captured") {
      return;
    }
    authorization.state = "captured";
    this.successfulCaptureCount += 1;
  }

  async void(input: {
    idempotency_key: string;
    authorization_id: string;
  }): Promise<void> {
    this.voidCallCount += 1;
    await this.addLatency();
    const authorization = this.authorizations.get(input.authorization_id);
    if (!authorization) {
      return;
    }
    if (authorization.idempotencyKey !== input.idempotency_key) {
      throw new Error("Payment idempotency key does not match authorization");
    }
    if (authorization.state === "captured") {
      throw new Error("A captured payment cannot be voided");
    }
    authorization.state = "voided";
  }

  private async addLatency(): Promise<void> {
    const random = Math.min(Math.max(this.options.random.next(), 0), 0.999999);
    const delayMs = 1 + Math.floor(random * Math.max(this.maxLatencyMs, 1));
    await this.options.sleeper.sleep(delayMs);
  }

  private findByKey(key: string):
    | (AuthorizationState & { id: string })
    | undefined {
    for (const [id, authorization] of this.authorizations) {
      if (authorization.idempotencyKey === key) {
        return { ...authorization, id };
      }
    }
    return undefined;
  }
}