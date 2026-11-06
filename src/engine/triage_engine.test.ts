import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runTriage } from "./triage_engine.js";
import { MockAlertSink, SeededRandom } from "./sinks/mock_alert_sink.js";
import type { Clock, Sleeper } from "./types.js";

class FixedClock implements Clock {
  constructor(private readonly timestamp: number) {}
  now(): number { return this.timestamp; }
}

class InstantSleeper implements Sleeper {
  async sleep(): Promise<void> {}
}

describe("triage engine", () => {
  it("writes a WITA reconciliation report and dispatches in severity order", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "erb-triage-test-"));
    const outputPath = join(tempDir, "incident_reconciliation.json");
    const sinkRandom = new SeededRandom(5);
    const sink = new MockAlertSink({ random: sinkRandom, failureRate: 0 });
    const timestamp = Date.parse("2026-10-29T10:30:00.000Z");
    try {
      const report = await runTriage({
        rootDir: process.cwd(),
        outputFile: outputPath,
        clock: new FixedClock(timestamp),
        sleeper: new InstantSleeper(),
        random: new SeededRandom(6),
        sink,
      });
      expect(report.records_processed).toBe(8);
      expect(report.records_invalid).toBe(0);
      expect(report.alerts).toHaveLength(6);
      expect(report.started_at).toBe("2026-10-29T18:30:00.000+08:00");
      expect(report.alerts.map((alert) => alert.payload.severity)).toEqual([
        "CRITICAL",
        "CRITICAL",
        "OFFLINE",
        "MAINTENANCE",
        "MAINTENANCE",
        "MAINTENANCE",
      ]);
      expect(report.devices_without_incidents.map((device) => device.device_id)).toEqual([
        "iot_car_01",
        "iot_car_07",
      ]);
      expect(report.summary.incidents_by_type).toEqual({
        CRITICAL_SECURITY_ALERT: 2,
        OFFLINE_TELEMETRY_DROP: 1,
        MAINTENANCE_REQUIRED: 3,
      });
      expect(report.summary.deliveries_by_status).toEqual({
        delivered: 6,
        failed_after_retries: 0,
      });
      expect(sink.deliveredCount).toBe(6);

      const written = JSON.parse(await readFile(outputPath, "utf8")) as typeof report;
      expect(written).toEqual(report);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});