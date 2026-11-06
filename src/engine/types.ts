export const INCIDENT_TYPES = [
  "CRITICAL_SECURITY_ALERT",
  "OFFLINE_TELEMETRY_DROP",
  "MAINTENANCE_REQUIRED",
] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number];
export type Severity = "CRITICAL" | "OFFLINE" | "MAINTENANCE";
export type DeliveryStatus = "delivered" | "failed_after_retries";

export interface TelemetryRecord {
  device_id: string;
  plate: string;
  model: string;
  status: string;
  current_speed_kmh: number;
  current_location: { zone: string };
  battery_voltage: number;
  fuel_percent: number;
  last_ping_seconds_ago: number;
  gateway_id: string;
}

export interface Incident {
  incident_type: IncidentType;
  severity: Severity;
  device_id: string;
  reasons: string[];
  recommended_action: string;
}

export interface AlertPayload {
  alert_id: string;
  incident_type: IncidentType;
  severity: Severity;
  device_id: string;
  plate: string;
  model: string;
  gateway_id: string;
  reasons: string[];
  telemetry: TelemetryRecord;
  detected_at: string;
  recommended_action: string;
}

export type DispatchAttemptOutcome =
  | "delivered"
  | "retryable_error"
  | "non_retryable_error";

export interface DispatchAttempt {
  attempt: number;
  /** Delay before this attempt; the first attempt always has 0 ms. */
  delay_ms: number;
  outcome: DispatchAttemptOutcome;
  error?: string;
}

export interface DispatchResult {
  final_status: DeliveryStatus;
  attempts: DispatchAttempt[];
}

export interface AlertSink {
  /** The receiver must deduplicate by alert_id because a network ACK can be lost. */
  deliver(payload: AlertPayload): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface Sleeper {
  sleep(milliseconds: number): Promise<void>;
}

/** Returns a number in [0, 1). */
export interface RandomSource {
  next(): number;
}

export interface RuleConfig {
  restrictedZonePrefix: string;
  movingSpeedThresholdKmh: number;
  offlinePingSeconds: number;
  lowBatteryVoltage: number;
  lowFuelPercent: number;
}

export interface RetryConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export interface InvalidTelemetryRecord {
  index: number;
  errors: string[];
}

export interface TelemetryLoadResult {
  records: TelemetryRecord[];
  invalidRecords: InvalidTelemetryRecord[];
}

export interface ReconciledAlert {
  payload: AlertPayload;
  attempts: DispatchAttempt[];
  final_status: DeliveryStatus;
}

export interface ReconciliationSummary {
  incidents_by_type: Record<IncidentType, number>;
  deliveries_by_status: Record<DeliveryStatus, number>;
}

export interface ReconciliationReport {
  run_id: string;
  started_at: string;
  finished_at: string;
  source_file: string;
  records_processed: number;
  records_invalid: number;
  summary: ReconciliationSummary;
  alerts: ReconciledAlert[];
  devices_without_incidents: Array<{
    device_id: string;
    plate: string;
    model: string;
  }>;
  invalid_records: InvalidTelemetryRecord[];
}
