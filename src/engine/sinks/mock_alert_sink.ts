import { DispatchError } from "../dispatcher.js";
import type { AlertPayload, AlertSink, RandomSource } from "../types.js";

export class SeededRandom implements RandomSource {
  constructor(private state: number) {
    if (!Number.isInteger(state) || state <= 0) {
      throw new RangeError("Seed must be a positive integer");
    }
  }

  next(): number {
    this.state = (this.state * 48_271) % 2_147_483_647;
    return this.state / 2_147_483_647;
  }
}

export interface MockAlertSinkOptions {
  random: RandomSource;
  failureRate: number;
  ackLossRate?: number;
}

/** Deterministic fake webhook; accepted alert IDs are deduplicated at the sink. */
export class MockAlertSink implements AlertSink {
  private readonly acceptedIds = new Set<string>();
  private readonly acceptedPayloads: AlertPayload[] = [];
  private duplicateDeliveries = 0;

  constructor(private readonly options: MockAlertSinkOptions) {
    if (options.failureRate < 0 || options.failureRate > 1) {
      throw new RangeError("failureRate must be between 0 and 1");
    }
  }

  get deliveredCount(): number {
    return this.acceptedPayloads.length;
  }

  get duplicateDeliveryCount(): number {
    return this.duplicateDeliveries;
  }

  get deliveries(): readonly AlertPayload[] {
    return this.acceptedPayloads.map((payload) => structuredClone(payload));
  }

  async deliver(payload: AlertPayload): Promise<void> {
    if (this.acceptedIds.has(payload.alert_id)) {
      this.duplicateDeliveries += 1;
      return;
    }

    if (this.options.random.next() < this.options.failureRate) {
      const ackLossRate = this.options.ackLossRate ?? 0;
      if (this.options.random.next() < ackLossRate) {
        this.accept(payload);
        throw new DispatchError("Webhook accepted alert but ACK was lost", {
          kind: "network",
        });
      }
      throw new DispatchError("Mock webhook returned HTTP 503", {
        kind: "http",
        statusCode: 503,
      });
    }

    this.accept(payload);
  }

  private accept(payload: AlertPayload): void {
    if (this.acceptedIds.has(payload.alert_id)) {
      this.duplicateDeliveries += 1;
      return;
    }
    this.acceptedIds.add(payload.alert_id);
    this.acceptedPayloads.push(structuredClone(payload));
  }
}