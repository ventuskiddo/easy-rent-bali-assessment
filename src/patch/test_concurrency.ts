import { pathToFileURL } from "node:url";
import { createCheckoutHandler } from "./checkout_handler.js";
import { InMemoryIdempotencyStore } from "./lib/idempotency_store.js";
import { MockPaymentGateway } from "./lib/payment_gateway.js";
import { InMemoryReservationRepository } from "./lib/reservation_repository.js";
import { InMemoryVehicleLock } from "./lib/vehicle_lock.js";
import type {
  CheckoutRequest,
  CheckoutResponse,
  RandomSource,
  Sleeper,
} from "./lib/types.js";

class SystemClock {
  now(): number {
    return Date.now();
  }
}

class TimerSleeper implements Sleeper {
  sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

class SeededRandom implements RandomSource {
  constructor(private state: number) {}

  next(): number {
    this.state = (this.state * 48271) % 2_147_483_647;
    return this.state / 2_147_483_647;
  }
}

interface ScenarioResult {
  name: string;
  requests: number;
  iterations: number;
  successCount: number;
  conflictCount: number;
  captureCount: number;
  replayVerified: boolean;
}

function request(
  idempotencyKey: string,
  index: number,
  vehicleId = "car_avanza_04",
  customerId = `customer_${index}`,
  bookingId = `booking_${index}`,
): CheckoutRequest {
  return {
    idempotency_key: idempotencyKey,
    booking_id: bookingId,
    vehicle_id: vehicleId,
    customer_id: customerId,
    amount_cents: 125_00,
  };
}

function createHarness(seed: number) {
  const clock = new SystemClock();
  const sleeper = new TimerSleeper();
  const random = new SeededRandom(seed);
  const paymentGateway = new MockPaymentGateway({
    sleeper,
    random,
    maxLatencyMs: 6,
  });
  let tokenNumber = 0;
  const handler = createCheckoutHandler({
    idempotencyStore: new InMemoryIdempotencyStore(),
    vehicleLock: new InMemoryVehicleLock(clock),
    reservations: new InMemoryReservationRepository(["car_avanza_04"]),
    paymentGateway,
    clock,
    vehicleLockTtlMs: 5_000,
    createOwnerToken: () => `owner_${seed}_${++tokenNumber}`,
  });
  return { handler, paymentGateway };
}

function countResponses(responses: readonly CheckoutResponse[]) {
  return {
    successCount: responses.filter((item) => item.status === 200).length,
    conflictCount: responses.filter((item) => item.status === 409).length,
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertSameResponse(
  actual: CheckoutResponse,
  expected: CheckoutResponse | undefined,
): void {
  if (!expected || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Completed same-key retry did not replay the stored response");
  }
}

async function runScenarioA(iteration: number): Promise<ScenarioResult> {
  const { handler, paymentGateway } = createHarness(iteration + 100);
  const requests = Array.from({ length: 5 }, (_, index) =>
    request(`unique-key-${iteration}-${index}`, index),
  );
  const responses = await Promise.all(requests.map((item) => handler.handle(item)));
  const counts = countResponses(responses);
  const correctConflicts = responses.filter(
    (item) => item.status === 409 && item.body.code === "VEHICLE_UNAVAILABLE",
  ).length;

  assertEqual(counts.successCount, 1, "Scenario A successes");
  assertEqual(counts.conflictCount, 4, "Scenario A conflicts");
  assertEqual(correctConflicts, 4, "Scenario A VEHICLE_UNAVAILABLE conflicts");
  assertEqual(paymentGateway.captureCount, 1, "Scenario A captures");
  return {
    name: "Different customers/keys, same vehicle",
    requests: 5,
    iterations: 1,
    ...counts,
    captureCount: paymentGateway.captureCount,
    replayVerified: true,
  };
}

async function runScenarioB(iteration: number): Promise<ScenarioResult> {
  const { handler, paymentGateway } = createHarness(iteration + 10_000);
  const sameRequest = request(
    `erb-kuta-retry-${iteration}`,
    0,
    "car_avanza_04",
    "cust_foreign_881",
    "erb_kuta_9941",
  );
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => handler.handle(sameRequest)),
  );
  const counts = countResponses(responses);
  const inProgressCount = responses.filter(
    (item) => item.status === 409 && item.body.code === "REQUEST_IN_PROGRESS",
  ).length;
  const success = responses.find((item) => item.status === 200);

  assertEqual(counts.successCount, 1, "Scenario B successes");
  assertEqual(counts.conflictCount, 4, "Scenario B conflicts");
  assertEqual(inProgressCount, 4, "Scenario B REQUEST_IN_PROGRESS conflicts");
  assertEqual(paymentGateway.captureCount, 1, "Scenario B captures before replay");

  const replay = await handler.handle(sameRequest);
  assertSameResponse(replay, success);
  assertEqual(paymentGateway.captureCount, 1, "Scenario B captures after replay");

  const reusedKey = await handler.handle({
    ...sameRequest,
    customer_id: "different_customer",
  });
  assertEqual(reusedKey.status, 422, "Changed payload status");
  assertEqual(reusedKey.body.code, "IDEMPOTENCY_KEY_REUSED", "Changed payload code");

  const missingKey = await handler.handle({
    ...sameRequest,
    idempotency_key: undefined,
  });
  assertEqual(missingKey.status, 422, "Missing idempotency key status");
  assertEqual(missingKey.body.code, "MISSING_IDEMPOTENCY_KEY", "Missing key code");
  assertEqual(paymentGateway.captureCount, 1, "Scenario B captures after validation checks");
  return {
    name: "Same-key kiosk retry storm + replay",
    requests: 5,
    iterations: 1,
    ...counts,
    captureCount: paymentGateway.captureCount,
    replayVerified: true,
  };
}

export async function runConcurrencySuite(): Promise<ScenarioResult[]> {
  const aggregate = [
    {
      name: "Scenario A: distinct keys, one vehicle",
      requests: 5,
      iterations: 50,
      successCount: 0,
      conflictCount: 0,
      captureCount: 0,
      replayVerified: true,
    },
    {
      name: "Scenario B: same-key retry storm",
      requests: 5,
      iterations: 50,
      successCount: 0,
      conflictCount: 0,
      captureCount: 0,
      replayVerified: true,
    },
  ];

  for (let iteration = 0; iteration < 50; iteration += 1) {
    const scenarioA = await runScenarioA(iteration);
    aggregate[0]!.successCount += scenarioA.successCount;
    aggregate[0]!.conflictCount += scenarioA.conflictCount;
    aggregate[0]!.captureCount += scenarioA.captureCount;

    const scenarioB = await runScenarioB(iteration);
    aggregate[1]!.successCount += scenarioB.successCount;
    aggregate[1]!.conflictCount += scenarioB.conflictCount;
    aggregate[1]!.captureCount += scenarioB.captureCount;
    aggregate[1]!.replayVerified &&= scenarioB.replayVerified;
  }
  return aggregate;
}

function printSummary(results: readonly ScenarioResult[]): void {
  const rows = results.map((result) => ({
    Scenario: result.name,
    Runs: result.iterations,
    Requests: result.requests * result.iterations,
    "200 OK": result.successCount,
    "409 Conflict": result.conflictCount,
    Captures: result.captureCount,
    Replay: result.replayVerified ? "PASS" : "FAIL",
  }));
  console.table(rows);
}

const directPath = process.argv[1];
const isDirectRun =
  directPath !== undefined &&
  import.meta.url === pathToFileURL(directPath).href;

if (isDirectRun) {
  runConcurrencySuite()
    .then(printSummary)
    .catch((error: unknown) => {
      console.error("Concurrency suite failed:", error);
      process.exitCode = 1;
    });
} else {
  const { describe, expect, it } = await import("vitest");
  describe("checkout concurrency and idempotency", () => {
    it("passes both concurrency scenarios 50 times with exact replay", async () => {
      const results = await runConcurrencySuite();
      expect(results[0]?.successCount).toBe(50);
      expect(results[0]?.conflictCount).toBe(200);
      expect(results[0]?.captureCount).toBe(50);
      expect(results[1]?.successCount).toBe(50);
      expect(results[1]?.conflictCount).toBe(200);
      expect(results[1]?.captureCount).toBe(50);
      expect(results[1]?.replayVerified).toBe(true);
    }, 30_000);
  });
}
