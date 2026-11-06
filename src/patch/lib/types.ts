export type CheckoutStatus = 200 | 409 | 422 | 500;

export interface CheckoutRequest {
  headers?: Readonly<Record<string, string | undefined>>;
  idempotency_key?: string;
  booking_id: string;
  vehicle_id: string;
  customer_id: string;
  amount_cents: number;
}

export interface CheckoutSuccessBody {
  code: "CHECKOUT_CONFIRMED";
  booking_id: string;
  vehicle_id: string;
  payment_status: "captured";
}

export interface CheckoutErrorBody {
  code:
    | "REQUEST_IN_PROGRESS"
    | "VEHICLE_UNAVAILABLE"
    | "IDEMPOTENCY_KEY_REUSED"
    | "MISSING_IDEMPOTENCY_KEY"
    | "INVALID_REQUEST"
    | "CHECKOUT_FAILED";
  message: string;
}

export type CheckoutResponseBody = CheckoutSuccessBody | CheckoutErrorBody;

export interface CheckoutResponse {
  status: CheckoutStatus;
  body: CheckoutResponseBody;
}

export type IdempotencyClaim =
  | { kind: "claimed" }
  | { kind: "in_progress" }
  | { kind: "replay"; response: CheckoutResponse }
  | { kind: "payload_mismatch" };

export interface IdempotencyStore {
  /** Atomically claims a new key or reports its existing state. */
  claim(key: string, payloadFingerprint: string): Promise<IdempotencyClaim>;
  /** Removes only a matching in-progress claim; completed results are retained. */
  abandon(key: string, payloadFingerprint: string): Promise<void>;
  complete(
    key: string,
    payloadFingerprint: string,
    response: CheckoutResponse,
  ): Promise<void>;
}

export interface VehicleLock {
  acquire(key: string, ownerToken: string, ttlMs: number): Promise<boolean>;
  /** Releases only when ownerToken still owns the unexpired lock. */
  release(key: string, ownerToken: string): Promise<boolean>;
}

export interface ReservationRepository {
  reserveIfAvailable(vehicleId: string, bookingId: string): Promise<boolean>;
  confirmReservation(vehicleId: string, bookingId: string): Promise<boolean>;
  /** Releases a held or confirmed reservation only for the matching booking. */
  releaseReservation(vehicleId: string, bookingId: string): Promise<boolean>;
}

export interface PaymentAuthorization {
  authorization_id: string;
}

export interface PaymentGateway {
  authorize(input: {
    idempotency_key: string;
    booking_id: string;
    customer_id: string;
    amount_cents: number;
  }): Promise<PaymentAuthorization>;
  capture(input: {
    idempotency_key: string;
    authorization_id: string;
    amount_cents: number;
  }): Promise<void>;
  void(input: {
    idempotency_key: string;
    authorization_id: string;
  }): Promise<void>;
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

export interface CheckoutHandlerDependencies {
  idempotencyStore: IdempotencyStore;
  vehicleLock: VehicleLock;
  reservations: ReservationRepository;
  paymentGateway: PaymentGateway;
  clock: Clock;
  vehicleLockTtlMs: number;
  createOwnerToken(): string;
}
