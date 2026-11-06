import type {
  CheckoutHandlerDependencies,
  CheckoutRequest,
  CheckoutResponse,
  CheckoutErrorBody,
  IdempotencyClaim,
} from "./lib/types.js";

const response = (
  status: CheckoutResponse["status"],
  code: CheckoutErrorBody["code"],
  message: string,
): CheckoutResponse => ({ status, body: { code, message } });

function idempotencyKeyFrom(request: CheckoutRequest): string | undefined {
  const header = Object.entries(request.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "idempotency-key",
  )?.[1];
  const headerKey = header?.trim();
  const fieldKey = request.idempotency_key?.trim();

  if (headerKey && fieldKey && headerKey !== fieldKey) {
    return undefined;
  }
  return headerKey || fieldKey || undefined;
}

function isValidRequest(request: CheckoutRequest): boolean {
  return (
    typeof request.booking_id === "string" &&
    request.booking_id.trim().length > 0 &&
    typeof request.vehicle_id === "string" &&
    request.vehicle_id.trim().length > 0 &&
    typeof request.customer_id === "string" &&
    request.customer_id.trim().length > 0 &&
    Number.isSafeInteger(request.amount_cents) &&
    request.amount_cents > 0
  );
}

function fingerprint(request: CheckoutRequest): string {
  return JSON.stringify([
    request.booking_id,
    request.vehicle_id,
    request.customer_id,
    request.amount_cents,
  ]);
}

function claimResponse(claim: IdempotencyClaim): CheckoutResponse | undefined {
  switch (claim.kind) {
    case "in_progress":
      return response(
        409,
        "REQUEST_IN_PROGRESS",
        "This checkout is still being processed; retry with the same idempotency key.",
      );
    case "payload_mismatch":
      return response(
        422,
        "IDEMPOTENCY_KEY_REUSED",
        "The idempotency key was already used with a different checkout payload.",
      );
    case "replay":
      return structuredClone(claim.response);
    case "claimed":
      return undefined;
  }
}

/**
 * Lock order is always idempotency key → vehicle → payment. The idempotency
 * claim is atomic, then the keyed vehicle lock serializes competing checkouts;
 * the repository's conditional reserve is a second atomic guard. Payment calls
 * begin only after the vehicle is reserved, and capture follows confirmation.
 */
export function createCheckoutHandler(
  deps: CheckoutHandlerDependencies,
): { handle(request: CheckoutRequest): Promise<CheckoutResponse> } {
  return {
    async handle(request: CheckoutRequest): Promise<CheckoutResponse> {
      const key = idempotencyKeyFrom(request);
      if (!key) {
        return response(
          422,
          "MISSING_IDEMPOTENCY_KEY",
          "A non-empty Idempotency-Key header or idempotency_key field is required.",
        );
      }
      if (!isValidRequest(request)) {
        return response(
          422,
          "INVALID_REQUEST",
          "booking_id, vehicle_id, customer_id, and positive integer amount_cents are required.",
        );
      }

      const payloadFingerprint = fingerprint(request);
      let claim: IdempotencyClaim;
      try {
        claim = await deps.idempotencyStore.claim(key, payloadFingerprint);
      } catch {
        return response(500, "CHECKOUT_FAILED", "Unable to claim checkout key.");
      }

      const existingResponse = claimResponse(claim);
      if (existingResponse) {
        return existingResponse;
      }

      let ownerToken: string | undefined;
      let lockOwned = false;
      let reservationCreated = false;
      let reservationConfirmed = false;
      let authorizationId: string | undefined;
      let captureSucceeded = false;
      let checkoutResponse: CheckoutResponse;

      try {
        ownerToken = deps.createOwnerToken();
        lockOwned = await deps.vehicleLock.acquire(
          request.vehicle_id,
          ownerToken,
          deps.vehicleLockTtlMs,
        );
        if (!lockOwned) {
          checkoutResponse = response(
            409,
            "VEHICLE_UNAVAILABLE",
            "Another checkout currently owns this vehicle.",
          );
        } else {
          reservationCreated = await deps.reservations.reserveIfAvailable(
            request.vehicle_id,
            request.booking_id,
          );

          if (!reservationCreated) {
            checkoutResponse = response(
              409,
              "VEHICLE_UNAVAILABLE",
              "The vehicle is already held, confirmed, or unavailable.",
            );
          } else {
            const authorization = await deps.paymentGateway.authorize({
              idempotency_key: key,
              booking_id: request.booking_id,
              customer_id: request.customer_id,
              amount_cents: request.amount_cents,
            });
            authorizationId = authorization.authorization_id;

            reservationConfirmed = await deps.reservations.confirmReservation(
              request.vehicle_id,
              request.booking_id,
            );
            if (!reservationConfirmed) {
              throw new Error("Vehicle hold could not be confirmed");
            }

            // Invariant: capture is unreachable until confirmReservation succeeds.
            await deps.paymentGateway.capture({
              idempotency_key: key,
              authorization_id: authorizationId,
              amount_cents: request.amount_cents,
            });
            captureSucceeded = true;
            checkoutResponse = {
              status: 200,
              body: {
                code: "CHECKOUT_CONFIRMED",
                booking_id: request.booking_id,
                vehicle_id: request.vehicle_id,
                payment_status: "captured",
              },
            };
          }
        }
      } catch {
        if (authorizationId && !captureSucceeded) {
          try {
            await deps.paymentGateway.void({
              idempotency_key: key,
              authorization_id: authorizationId,
            });
          } catch {
            // Preserve the structured response; a production adapter must alert
            // and reconcile an authorization whose void result is uncertain.
          }
        }
        if (reservationCreated && !captureSucceeded) {
          try {
            await deps.reservations.releaseReservation(
              request.vehicle_id,
              request.booking_id,
            );
          } catch {
            // A production adapter must alert and reconcile failed hold release.
          }
        }
        checkoutResponse = response(
          500,
          "CHECKOUT_FAILED",
          "Checkout could not be completed; retry with the same idempotency key.",
        );
      } finally {
        if (lockOwned && ownerToken) {
          try {
            // Token comparison prevents an expired owner's finally block from
            // releasing a newer owner's lock.
            await deps.vehicleLock.release(request.vehicle_id, ownerToken);
          } catch {
            // TTL remains the final safety net if lock release infrastructure fails.
          }
        }
      }

      if (checkoutResponse.status === 500) {
        try {
          await deps.idempotencyStore.abandon(key, payloadFingerprint);
        } catch {
          // A store failure must not replace the structured checkout error.
        }
        return checkoutResponse;
      }

      try {
        await deps.idempotencyStore.complete(
          key,
          payloadFingerprint,
          checkoutResponse,
        );
      } catch {
        try {
          await deps.idempotencyStore.abandon(key, payloadFingerprint);
        } catch {
          // Preserve a structured response if claim cleanup also fails.
        }
        return response(
          500,
          "CHECKOUT_FAILED",
          "Checkout result could not be persisted; retry with the same idempotency key.",
        );
      }
      return checkoutResponse;
    },
  };
}
