import type { RetryConfig, RuleConfig } from "./types.js";

export const RULE_CONFIG: Readonly<RuleConfig> = Object.freeze({
  restrictedZonePrefix: "RESTRICTED_",
  movingSpeedThresholdKmh: 0,
  offlinePingSeconds: 900,
  lowBatteryVoltage: 11.5,
  lowFuelPercent: 15,
});

export const RETRY_CONFIG: Readonly<RetryConfig> = Object.freeze({
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  maxAttempts: 5,
});

export const ALERT_SINK_SEED = 1;
export const ALERT_SINK_FAILURE_RATE = 0.3;
export const ALERT_SINK_ACK_LOSS_RATE = 0.25;
export const WITA_OFFSET_MINUTES = 8 * 60;
