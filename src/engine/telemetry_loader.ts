import { readFile } from "node:fs/promises";
import type {
  InvalidTelemetryRecord,
  TelemetryLoadResult,
  TelemetryRecord,
} from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRecord(value: unknown): { record?: TelemetryRecord; errors: string[] } {
  if (!isObject(value)) {
    return { errors: ["record must be a JSON object"] };
  }

  const errors: string[] = [];
  const requiredStrings = [
    "device_id",
    "plate",
    "model",
    "status",
    "gateway_id",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      errors.push(`${key} must be a non-empty string`);
    }
  }

  const numericFields = [
    "current_speed_kmh",
    "battery_voltage",
    "fuel_percent",
    "last_ping_seconds_ago",
  ] as const;
  for (const key of numericFields) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      errors.push(`${key} must be a finite number`);
    }
  }
  if (typeof value.current_speed_kmh === "number" && value.current_speed_kmh < 0) {
    errors.push("current_speed_kmh must not be negative");
  }
  if (typeof value.battery_voltage === "number" && value.battery_voltage < 0) {
    errors.push("battery_voltage must not be negative");
  }
  if (
    typeof value.fuel_percent === "number" &&
    (value.fuel_percent < 0 || value.fuel_percent > 100)
  ) {
    errors.push("fuel_percent must be between 0 and 100");
  }
  if (
    typeof value.last_ping_seconds_ago === "number" &&
    value.last_ping_seconds_ago < 0
  ) {
    errors.push("last_ping_seconds_ago must not be negative");
  }

  const location = value.current_location;
  if (!isObject(location) || typeof location.zone !== "string" || location.zone.trim() === "") {
    errors.push("current_location.zone must be a non-empty string");
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    errors,
    record: {
      device_id: value.device_id as string,
      plate: value.plate as string,
      model: value.model as string,
      status: value.status as string,
      current_speed_kmh: value.current_speed_kmh as number,
      current_location: { zone: (location as Record<string, unknown>).zone as string },
      battery_voltage: value.battery_voltage as number,
      fuel_percent: value.fuel_percent as number,
      last_ping_seconds_ago: value.last_ping_seconds_ago as number,
      gateway_id: value.gateway_id as string,
    },
  };
}

export function validateTelemetryRecords(value: unknown): TelemetryLoadResult {
  if (!Array.isArray(value)) {
    return {
      records: [],
      invalidRecords: [{ index: 0, errors: ["telemetry document must be a JSON array"] }],
    };
  }

  const records: TelemetryRecord[] = [];
  const invalidRecords: InvalidTelemetryRecord[] = [];
  value.forEach((candidate, index) => {
    const result = validateRecord(candidate);
    if (result.record) {
      records.push(result.record);
    } else {
      invalidRecords.push({ index, errors: result.errors });
    }
  });
  return { records, invalidRecords };
}

export async function loadTelemetry(filePath: string): Promise<TelemetryLoadResult> {
  const content = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    return {
      records: [],
      invalidRecords: [{ index: 0, errors: [`invalid JSON document: ${message}`] }],
    };
  }
  return validateTelemetryRecords(parsed);
}
