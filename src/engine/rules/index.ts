import { criticalSecurityRule } from "./critical_security.js";
import { maintenanceRule } from "./maintenance.js";
import { offlineTelemetryRule } from "./offline_telemetry.js";
import type { Incident, RuleConfig, TelemetryRecord } from "../types.js";

export type TelemetryRule = (
  record: TelemetryRecord,
  config: Readonly<RuleConfig>,
) => Incident[];

/** Pure rule registry; each rule can add an incident independently. */
export const RULES: readonly TelemetryRule[] = [
  criticalSecurityRule,
  offlineTelemetryRule,
  maintenanceRule,
];

export function evaluateRules(
  record: TelemetryRecord,
  config: Readonly<RuleConfig>,
): Incident[] {
  return RULES.flatMap((rule) => rule(record, config));
}

export { criticalSecurityRule, maintenanceRule, offlineTelemetryRule };