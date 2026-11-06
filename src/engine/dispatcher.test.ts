import { describe, expect, it } from "vitest";
import { RETRY_CONFIG } from "./config.js";
import {
  calculateRetryDelay,
  DispatchError,
  ResilientDispatcher,
} from "./dispatcher.js";
import { MockAlertSink } from "./sinks/mock_alert_sink.js";
import type {
  AlertPayload,
  AlertSink,
  RandomSource,
  Sleeper,
} from "./types.js";

class FixedRandom implements RandomSource {
  constructor(private readonly value: number) {}
  next(): number { return this.value; }
}

class SequenceRandom implements RandomSource {
  private index = 0;
  constructor(private readonly values: number[]) {}
  next(): number {
    const value = this.values[this.index] ?? this.values.at(-1) ?? 0;
    this.index += 1;
    return value;
  }
}

class ImmediateSleeper implements Sleeper {
  readonly delays: number[] = [];
  async sleep(milliseconds: number): Promise<void> {
    this.delays.push(milliseconds);
  }
}

function payload(alertId = "alert_test_01"): AlertPayload {
  return {
    alert_id: alertId,
    incident_type: "CRITICAL_SECURITY_ALERT",
    severity: "CRITICAL",
    device_id: "iot_test_01",
    plate: "DK 0000 AA",
    model: "Test Vehicle",
    gateway_id: "gw_kuta_01",
    reasons: ["test reason"],
    telemetry: {
      device_id: "iot_test_01",
      plate: "DK 0000 AA",
      model: "Test Vehicle",
      status: "available",
      current_speed_kmh: 1,
      current_location: { zone: "KUTA_HUB" },
      battery_voltage: 12.5,
      fuel_percent: 80,
      last_ping_seconds_ago: 5,
      gateway_id: "gw_kuta_01",
    },
    detected_at: "2026-10-29T18:30:00.000+08:00",
    recommended_action: "Investigate.",
  };
}

describe("resilient dispatcher", () => {
  it("calculates full-jitter delays within exponential ceilings and cap", () => {
    expect(calculateRetryDelay(1, new FixedRandom(0))).toBe(0);
    expect(calculateRetryDelay(1, new FixedRandom(0.9999))).toBeLessThan(200);
    expect(calculateRetryDelay(2, new FixedRandom(0.5))).toBe(200);
    expect(calculateRetryDelay(9, new FixedRandom(0.5))).toBe(2_500);
    expect(calculateRetryDelay(20, new FixedRandom(0.9999))).toBeLessThanOrEqual(5_000);
  });

  it("does not retry a non-retryable 4xx validation error", async () => {
    const sleeper = new ImmediateSleeper();
    let calls = 0;
    const sink: AlertSink = {
      async deliver() {
        calls += 1;
        throw new DispatchError("invalid payload", { kind: "http", statusCode: 422 });
      },
    };
    const dispatcher = new ResilientDispatcher({
      sink,
      sleeper,
      random: new FixedRandom(0.5),
    });
    const result = await dispatcher.dispatch(payload());
    expect(calls).toBe(1);
    expect(sleeper.delays).toEqual([]);
    expect(result.final_status).toBe("failed_after_retries");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toBe("non_retryable_error");
  });

  it("stops after max attempts and records bounded full-jitter delays", async () => {
    const sleeper = new ImmediateSleeper();
    let calls = 0;
    const sink: AlertSink = {
      async deliver() {
        calls += 1;
        throw new DispatchError("service unavailable", { kind: "http", statusCode: 503 });
      },
    };
    const dispatcher = new ResilientDispatcher({
      sink,
      sleeper,
      random: new FixedRandom(0.999999),
      retryConfig: RETRY_CONFIG,
    });
    const result = await dispatcher.dispatch(payload());
    expect(calls).toBe(5);
    expect(result.final_status).toBe("failed_after_retries");
    expect(result.attempts).toHaveLength(5);
    expect(result.attempts.map((item) => item.delay_ms)).toEqual([0, 199, 399, 799, 1_599]);
    expect(sleeper.delays).toEqual([199, 399, 799, 1_599]);
  });

  it("deduplicates an accepted alert after an ACK-loss retry and repeated dispatch", async () => {
    const random = new SequenceRandom([0.1, 0.1, 0.5]);
    const sink = new MockAlertSink({ random, failureRate: 1, ackLossRate: 1 });
    const sleeper = new ImmediateSleeper();
    const dispatcher = new ResilientDispatcher({
      sink,
      sleeper,
      random,
    });
    const alert = payload();
    const result = await dispatcher.dispatch(alert);
    expect(result.final_status).toBe("delivered");
    expect(result.attempts).toHaveLength(2);
    expect(sink.deliveredCount).toBe(1);
    expect(sink.duplicateDeliveryCount).toBe(1);

    const repeated = await dispatcher.dispatch(alert);
    expect(repeated.final_status).toBe("delivered");
    expect(repeated.attempts).toEqual([]);
    expect(sink.deliveredCount).toBe(1);
  });
});
