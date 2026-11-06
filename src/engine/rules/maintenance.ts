import type { Incident, RuleConfig, TelemetryRecord } from "../types.js";

export function maintenanceRule(
  record: TelemetryRecord,
  config: Readonly<RuleConfig>,
): Incident[] {
  const reasons: string[] = [];
  if (record.battery_voltage < config.lowBatteryVoltage) {
    reasons.push(
      `Battery voltage is low: ${record.battery_voltage} V (threshold: <${config.lowBatteryVoltage} V).`,
    );
  }
  if (record.fuel_percent < config.lowFuelPercent) {
    reasons.push(
      `Fuel is low: ${record.fuel_percent}% (threshold: <${config.lowFuelPercent}%).`,
    );
  }
  if (reasons.length === 0) {
    return [];
  }
  return [{
    incident_type: "MAINTENANCE_REQUIRED",
    severity: "MAINTENANCE",
    device_id: record.device_id,
    reasons,
    recommended_action: "Arrange vehicle inspection and service before the next rental.",
  }];
}