import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ALERT_SINK_ACK_LOSS_RATE,
  ALERT_SINK_FAILURE_RATE,
  ALERT_SINK_SEED,
  RETRY_CONFIG,
  RULE_CONFIG,
  WITA_OFFSET_MINUTES,
} from "./config.js";
import { ResilientDispatcher } from "./dispatcher.js";
import { evaluateRules } from "./rules/index.js";
import { MockAlertSink, SeededRandom } from "./sinks/mock_alert_sink.js";
import { loadTelemetry } from "./telemetry_loader.js";
import type {
  AlertPayload,
  AlertSink,
  Clock,
  Incident,
  RandomSource,
  ReconciliationReport,
  Sleeper,
  TelemetryRecord,
} from "./types.js";

const DEFAULT_SOURCE = "data/outage_telemetry.json";
const DEFAULT_OUTPUT = "output/incident_reconciliation.json";
const SEVERITY_ORDER: Readonly<Record<Incident["severity"], number>> = {
  CRITICAL: 0,
  OFFLINE: 1,
  MAINTENANCE: 2,
};

class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

class TimerSleeper implements Sleeper {
  sleep(milliseconds: number): Promise<void> {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
  }
}

function toWitaIso(timestampMs: number): string {
  const shifted = new Date(timestampMs + WITA_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().replace("Z", "+08:00");
}

function makeAlertId(
  deviceId: string,
  incidentType: string,
  runStartedAtMs: number,
): string {
  const digest = createHash("sha256")
    .update(`${deviceId}:${incidentType}:${runStartedAtMs}`)
    .digest("hex")
    .slice(0, 24);
  return `alert_${digest}`;
}

function makePayload(
  incident: Incident,
  record: TelemetryRecord,
  startedAtMs: number,
  detectedAt: string,
): AlertPayload {
  return {
    alert_id: makeAlertId(incident.device_id, incident.incident_type, startedAtMs),
    incident_type: incident.incident_type,
    severity: incident.severity,
    device_id: record.device_id,
    plate: record.plate,
    model: record.model,
    gateway_id: record.gateway_id,
    reasons: [...incident.reasons],
    telemetry: structuredClone(record),
    detected_at: detectedAt,
    recommended_action: incident.recommended_action,
  };
}

export interface TriageEngineOptions {
  rootDir?: string;
  sourceFile?: string;
  outputFile?: string;
  clock?: Clock;
  sleeper?: Sleeper;
  random?: RandomSource;
  sink?: AlertSink;
}

export async function runTriage(
  options: TriageEngineOptions = {},
): Promise<ReconciliationReport> {
  const engineDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = options.rootDir ?? resolve(engineDir, "../..");
  const sourcePath = options.sourceFile
    ? isAbsolute(options.sourceFile)
      ? options.sourceFile
      : resolve(rootDir, options.sourceFile)
    : resolve(rootDir, DEFAULT_SOURCE);
  const outputPath = options.outputFile
    ? isAbsolute(options.outputFile)
      ? options.outputFile
      : resolve(rootDir, options.outputFile)
    : resolve(rootDir, DEFAULT_OUTPUT);
  const sourceLabel = relative(rootDir, sourcePath).replaceAll("\\", "/");
  const clock = options.clock ?? new SystemClock();
  const startedAtMs = clock.now();
  const startedAt = toWitaIso(startedAtMs);
  const random = options.random ?? new SeededRandom(ALERT_SINK_SEED);
  const sink = options.sink ?? new MockAlertSink({
    random,
    failureRate: ALERT_SINK_FAILURE_RATE,
    ackLossRate: ALERT_SINK_ACK_LOSS_RATE,
  });
  const dispatcher = new ResilientDispatcher({
    sink,
    sleeper: options.sleeper ?? new TimerSleeper(),
    random,
    retryConfig: RETRY_CONFIG,
  });

  const loaded = await loadTelemetry(sourcePath);
  const incidents: Array<{ incident: Incident; record: TelemetryRecord }> = [];
  const devicesWithoutIncidents: ReconciliationReport["devices_without_incidents"] = [];
  const incidentCounts: ReconciliationReport["summary"]["incidents_by_type"] = {
    CRITICAL_SECURITY_ALERT: 0,
    OFFLINE_TELEMETRY_DROP: 0,
    MAINTENANCE_REQUIRED: 0,
  };

  for (const record of loaded.records) {
    const recordIncidents = evaluateRules(record, RULE_CONFIG);
    if (recordIncidents.length === 0) {
      devicesWithoutIncidents.push({
        device_id: record.device_id,
        plate: record.plate,
        model: record.model,
      });
      continue;
    }
    for (const incident of recordIncidents) {
      incidentCounts[incident.incident_type] += 1;
      incidents.push({ incident, record });
    }
  }
  incidents.sort((left, right) =>
    SEVERITY_ORDER[left.incident.severity] - SEVERITY_ORDER[right.incident.severity],
  );

  const alerts: ReconciliationReport["alerts"] = [];
  const deliveryCounts: ReconciliationReport["summary"]["deliveries_by_status"] = {
    delivered: 0,
    failed_after_retries: 0,
  };
  for (const item of incidents) {
    const payload = makePayload(
      item.incident,
      item.record,
      startedAtMs,
      toWitaIso(clock.now()),
    );
    const dispatchResult = await dispatcher.dispatch(payload);
    deliveryCounts[dispatchResult.final_status] += 1;
    alerts.push({
      payload,
      attempts: dispatchResult.attempts,
      final_status: dispatchResult.final_status,
    });
  }

  const report: ReconciliationReport = {
    run_id: `triage_${createHash("sha256")
      .update(`${sourceLabel}:${startedAtMs}`)
      .digest("hex")
      .slice(0, 16)}`,
    started_at: startedAt,
    finished_at: toWitaIso(clock.now()),
    source_file: sourceLabel,
    records_processed: loaded.records.length,
    records_invalid: loaded.invalidRecords.length,
    summary: {
      incidents_by_type: incidentCounts,
      deliveries_by_status: deliveryCounts,
    },
    alerts,
    devices_without_incidents: devicesWithoutIncidents,
    invalid_records: loaded.invalidRecords,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

const directPath = process.argv[1];
const isDirectRun =
  directPath !== undefined &&
  import.meta.url === pathToFileURL(directPath).href;

if (isDirectRun) {
  runTriage()
    .then((report) => {
      console.log(`Triage complete: ${report.records_processed} records, ${report.alerts.length} alerts.`);
      console.log(`Output: ${resolve(dirname(fileURLToPath(import.meta.url)), "../../", DEFAULT_OUTPUT)}`);
      console.log(JSON.stringify(report.summary, null, 2));
    })
    .catch((error: unknown) => {
      console.error("Triage failed:", error);
      process.exitCode = 1;
    });
}
