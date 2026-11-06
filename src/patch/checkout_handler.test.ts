import { describe, expect, it } from "vitest";
import { createCheckoutHandler } from "./checkout_handler.js";
import { InMemoryIdempotencyStore } from "./lib/idempotency_store.js";
import { MockPaymentGateway } from "./lib/payment_gateway.js";
import { InMemoryReservationRepository } from "./lib/reservation_repository.js";
import { InMemoryVehicleLock } from "./lib/vehicle_lock.js";
import type {
  CheckoutRequest,
  Clock,
  RandomSource,
  ReservationRepository,
  Sleeper,
} from "./lib/types.js";

class FixedClock implements Clock {
  now(): number {
    return 1_000;
  }
}

class FixedRandom implements RandomSource {
  next(): number {
    return 0.5;
  }
}

class InstantSleeper implements Sleeper {
  async sleep(): Promise<void> {}
}

const checkoutRequest: CheckoutRequest = {
  idempotency_key: "retryable-checkout-key",
  booking_id: "booking_retry_01",
  vehicle_id: "car_avanza_04",
  customer_id: "customer_retry_01",
  amount_cents: 125_00,
};

describe("checkout idempotency after transient failures", () => {
  it("releases a 500 key so the same request can succeed on retry", async () => {
    const clock = new FixedClock();
    const baseReservations = new InMemoryReservationRepository(["car_avanza_04"]);
    let failFirstReserve = true;
    const reservations: ReservationRepository = {
      async reserveIfAvailable(vehicleId, bookingId) {
        if (failFirstReserve) {
          failFirstReserve = false;
          throw new Error("temporary repository failure");
        }
        return baseReservations.reserveIfAvailable(vehicleId, bookingId);
      },
      confirmReservation: (vehicleId, bookingId) =>
        baseReservations.confirmReservation(vehicleId, bookingId),
      releaseReservation: (vehicleId, bookingId) =>
        baseReservations.releaseReservation(vehicleId, bookingId),
    };
    const paymentGateway = new MockPaymentGateway({
      sleeper: new InstantSleeper(),
      random: new FixedRandom(),
      maxLatencyMs: 1,
    });
    let tokenNumber = 0;
    const handler = createCheckoutHandler({
      idempotencyStore: new InMemoryIdempotencyStore(),
      vehicleLock: new InMemoryVehicleLock(clock),
      reservations,
      paymentGateway,
      clock,
      vehicleLockTtlMs: 1_000,
      createOwnerToken: () => `owner_${++tokenNumber}`,
    });

    const firstAttempt = await handler.handle(checkoutRequest);
    expect(firstAttempt.status).toBe(500);
    expect(firstAttempt.body.code).toBe("CHECKOUT_FAILED");
    expect(paymentGateway.captureCount).toBe(0);

    const retry = await handler.handle(checkoutRequest);
    expect(retry.status).toBe(200);
    expect(retry.body.code).toBe("CHECKOUT_CONFIRMED");
    expect(paymentGateway.captureCount).toBe(1);

    const replay = await handler.handle(checkoutRequest);
    expect(replay).toEqual(retry);
    expect(paymentGateway.captureCount).toBe(1);
  });
});
