import type { Incident, RuleConfig, TelemetryRecord } from "../types.js";

export function offlineTelemetryRule(
  record: TelemetryRecord,
  config: Readonly<RuleConfig>,
): Incident[] {
  if (
    record.status !== "rented" ||
    record.last_ping_seconds_ago <= config.offlinePingSeconds
  ) {
    return [];
  }
  return [{
    incident_type: "OFFLINE_TELEMETRY_DROP",
    severity: "OFFLINE",
    device_id: record.device_id,
    reasons: [
      `Rented vehicle has been silent for ${record.last_ping_seconds_ago} seconds (threshold: >${config.offlinePingSeconds} seconds).`,
    ],
    recommended_action: "Check gateway connectivity and request a location update from the customer or branch team.",
  }];
}