import { describe, expect, it } from "vitest";
import { RULE_CONFIG } from "./config.js";
import { evaluateRules } from "./rules/index.js";
import { loadTelemetry, validateTelemetryRecords } from "./telemetry_loader.js";
import type { TelemetryRecord } from "./types.js";

function record(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    device_id: "iot_test_01",
    plate: "DK 0000 AA",
    model: "Test Vehicle",
    status: "rented",
    current_speed_kmh: 0,
    current_location: { zone: "KUTA_HUB" },
    battery_voltage: 12.6,
    fuel_percent: 50,
    last_ping_seconds_ago: 30,
    gateway_id: "gw_kuta_01",
    ...overrides,
  };
}

describe("telemetry rules", () => {
  it("flags an available moving vehicle and restricted-zone presence with reasons", () => {
    const incidents = evaluateRules(record({
      status: "available",
      current_speed_kmh: 52,
      current_location: { zone: "RESTRICTED_OFFROAD_BATUKARU" },
    }), RULE_CONFIG);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.incident_type).toBe("CRITICAL_SECURITY_ALERT");
    expect(incidents[0]?.reasons).toHaveLength(2);
    expect(incidents[0]?.reasons.join(" ")).toContain("52 km/h");
    expect(incidents[0]?.reasons.join(" ")).toContain("RESTRICTED_OFFROAD_BATUKARU");
  });

  it("does not flag the critical rule for a stationary available vehicle in a normal zone", () => {
    const incidents = evaluateRules(record({ status: "available" }), RULE_CONFIG);
    expect(incidents.some((item) => item.incident_type === "CRITICAL_SECURITY_ALERT")).toBe(false);
  });

  it("flags rented telemetry only above 900 seconds", () => {
    expect(evaluateRules(record({ last_ping_seconds_ago: 900 }), RULE_CONFIG)).toHaveLength(0);
    const aboveBoundary = evaluateRules(record({ last_ping_seconds_ago: 901 }), RULE_CONFIG);
    expect(aboveBoundary.map((item) => item.incident_type)).toContain("OFFLINE_TELEMETRY_DROP");
    expect(evaluateRules(record({ status: "available", last_ping_seconds_ago: 1_320 }), RULE_CONFIG))
      .not.toContainEqual(expect.objectContaining({ incident_type: "OFFLINE_TELEMETRY_DROP" }));
  });

  it("uses strict maintenance boundaries and includes each low metric", () => {
    expect(evaluateRules(record({ battery_voltage: 11.5, fuel_percent: 15 }), RULE_CONFIG))
      .not.toContainEqual(expect.objectContaining({ incident_type: "MAINTENANCE_REQUIRED" }));

    const lowBattery = evaluateRules(record({ battery_voltage: 11.2 }), RULE_CONFIG)
      .find((item) => item.incident_type === "MAINTENANCE_REQUIRED");
    expect(lowBattery?.reasons.join(" ")).toContain("11.2 V");
    expect(lowBattery?.reasons).toHaveLength(1);

    const lowFuel = evaluateRules(record({ fuel_percent: 9 }), RULE_CONFIG)
      .find((item) => item.incident_type === "MAINTENANCE_REQUIRED");
    expect(lowFuel?.reasons.join(" ")).toContain("9%");

    const bothLow = evaluateRules(record({ battery_voltage: 11.3, fuel_percent: 11 }), RULE_CONFIG)
      .find((item) => item.incident_type === "MAINTENANCE_REQUIRED");
    expect(bothLow?.reasons).toHaveLength(2);
  });
});

describe("telemetry loader", () => {
  it("skips malformed records and returns their validation errors", () => {
    const result = validateTelemetryRecords([
      record(),
      { ...record(), battery_voltage: "unknown" },
      { ...record(), fuel_percent: 101 },
      null,
    ]);
    expect(result.records).toHaveLength(1);
    expect(result.invalidRecords).toHaveLength(3);
    expect(result.invalidRecords[0]?.index).toBe(1);
    expect(result.invalidRecords[0]?.errors.join(" ")).toContain("battery_voltage");
    expect(result.invalidRecords[1]?.errors.join(" ")).toContain("between 0 and 100");
  });

  it("matches the expected incident set for the starter telemetry dataset", async () => {
    const loaded = await loadTelemetry("data/outage_telemetry.json");
    expect(loaded.invalidRecords).toEqual([]);
    const actual = Object.fromEntries(loaded.records.map((item) => [
      item.device_id,
      evaluateRules(item, RULE_CONFIG).map((incident) => incident.incident_type),
    ]));
    expect(actual).toEqual({
      iot_car_01: [],
      iot_car_02: ["CRITICAL_SECURITY_ALERT"],
      iot_car_03: ["MAINTENANCE_REQUIRED"],
      iot_car_04: ["MAINTENANCE_REQUIRED"],
      iot_car_05: ["CRITICAL_SECURITY_ALERT"],
      iot_car_06: ["OFFLINE_TELEMETRY_DROP"],
      iot_car_07: [],
      iot_car_08: ["MAINTENANCE_REQUIRED"],
    });
  });
});
