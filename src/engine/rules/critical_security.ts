import type { Incident, RuleConfig, TelemetryRecord } from "../types.js";

export function criticalSecurityRule(
  record: TelemetryRecord,
  config: Readonly<RuleConfig>,
): Incident[] {
  const reasons: string[] = [];
  if (
    record.status === "available" &&
    record.current_speed_kmh > config.movingSpeedThresholdKmh
  ) {
    reasons.push(
      `Vehicle is marked available while moving at ${record.current_speed_kmh} km/h.`,
    );
  }
  if (record.current_location.zone.startsWith(config.restrictedZonePrefix)) {
    reasons.push(`Vehicle is in restricted zone ${record.current_location.zone}.`);
  }
  if (reasons.length === 0) {
    return [];
  }
  return [{
    incident_type: "CRITICAL_SECURITY_ALERT",
    severity: "CRITICAL",
    device_id: record.device_id,
    reasons,
    recommended_action: "Contact the customer and fleet operations immediately; verify vehicle status and location.",
  }];
}
