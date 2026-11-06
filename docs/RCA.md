# Root Cause Analysis: Kuta Sunset Outage

**Incident date:** 2026-10-29  
**Location:** Easy Rent Bali, Kuta Hub  
**Timezone:** WITA (UTC+08:00)  
**Status:** Root cause identified from the supplied incident description and error record; exact transaction traces and customer/vehicle counts were not supplied.

## Summary

A thunderstorm cut the Kuta Hub primary fiber. The dual-WAN gateway moved traffic to cellular, but the backup path was severely impaired: jitter exceeded 400 ms, packet loss reached 18%, and the link repeatedly changed state. At the same time, guest Wi-Fi traffic was not constrained and competed with checkout, POS, and controller traffic for the small cellular uplink.

Kiosk requests took longer than the client timeout to complete. A kiosk retried while its original checkout was still executing. Because retries carried no idempotency key, the service treated them as new checkouts. Parallel transactions tried to reserve the same vehicle and acquired database locks in inconsistent order; PostgreSQL detected a deadlock and aborted a transaction. Payment capture had already occurred before, or outside, the transaction that confirmed the vehicle hold, so rolling back the database work could not reverse the external charge. The result was duplicate capture risk and vehicle reservation state that could remain locked or inconsistent.

This was a system design and resilience gap exposed by a network failure, not an individual error. The corrective design combines stable failover and traffic priority with checkout idempotency, consistent row-level locking, an explicit hold/authorize/commit/capture sequence, and reconciliation for external payment outcomes.

## Impact

- Kiosk checkouts timed out and retried during a degraded cellular failover. A retry could create a second payment capture for one customer intent.
- A deadlock victim's database transaction rolled back. Depending on the transaction boundary and recovery path, the associated vehicle could remain held/locked or disagree with payment state.
- POS traffic and cloud controller heartbeats competed with unthrottled guest Wi-Fi on the backup uplink, reducing the availability of branch operations and network management.
- The IoT gateway lost connectivity, so some returning vehicles were not reported to fleet operations in a timely way.
- The brief does not provide confirmed counts of affected bookings, captures, vehicles, or outage duration. Those should be established from payment-provider records, checkout/idempotency logs (if available), reservation history, and IoT last-seen data before customer remediation is finalized.

## Timeline (WITA, around 18:30 on 2026-10-29)

This is a best-effort reconstruction from the scenario and the supplied error record; times other than the logged database event are approximate.

| Approximate WITA time | Event |
|---|---|
| Around 18:30 | Thunderstorm damage cuts primary fiber at Kuta Hub. The gateway moves traffic to cellular backup. |
| Shortly after failover | Cellular path shows severe jitter, packet loss, and connection flapping. Guest Wi-Fi remains able to consume shared uplink capacity, competing with POS, kiosks, and controller heartbeats. |
| During degraded service | Checkout responses exceed kiosk timeout. The client retries before the original request has completed; each attempt is treated as a separate checkout because no idempotency key is supplied. Concurrent transactions contend for the same vehicle and related payment/booking records. |
| 18:32:14.218 | Checkout worker logs `TransactionRollbackError: deadlock detected`. Process 9182 waits for an `ExclusiveLock` on relation `vehicle_reservations`, blocked by process 9188. Payload identifies booking `erb_kuta_9941`, vehicle `car_avanza_04`, customer `cust_foreign_881`. PostgreSQL aborts a deadlock participant so the database can make progress. |
| During/after the incident | A database rollback cannot undo a payment capture already made by the external processor. Some vehicle holds and payment outcomes require reconciliation. IoT disconnects leave some returning-car location updates stale. |

## Root causes

1. **Retries were not idempotent.** The kiosk request had no durable idempotency key. A retry was indistinguishable from a new checkout, so the server could create a second reservation attempt and payment operation for the same customer intent.
2. **Concurrent checkout did not have a single lock order and narrow lock scope.** Two attempts for one vehicle could acquire booking/payment and reservation locks in opposite orders. The resulting wait cycle was detected by PostgreSQL; it aborted one transaction.
3. **Payment capture was not coupled safely to the durable vehicle decision.** Capture ran before, or outside, the database transaction that committed the vehicle hold. The external processor is not part of the PostgreSQL transaction, so a SQL rollback cannot reverse a successful capture.
4. **The cellular backup did not have an effective degraded-link policy.** Failover restored a route but did not provide a sufficiently stable service path, and unthrottled guest traffic was allowed to compete with checkout, POS, and control-plane traffic.

## Contributing factors

- The kiosk's request timeout was shorter than worst-case server processing time on a path with >400 ms jitter and 18% loss. A timeout described the client's wait, not whether the server had stopped processing.
- Connection flapping made a request's completion or response delivery uncertain. A response lost after a successful server-side action looks like failure to a client unless the API supports safe replay and result lookup.
- Database transaction and external-payment boundaries were not represented as an explicit state machine. That made “charge succeeded, database rolled back” possible without a durable workflow record.
- Reservation locking was broad enough to involve a relation-level `ExclusiveLock`, increasing contention risk. The exact source of this lock needs confirmation from the SQL, migrations, and lock telemetry for process 9188.
- There was no cellular traffic shaping to protect POS/checkout and controller heartbeats from guest Wi-Fi or bulk traffic.
- The IoT gateway and telemetry path shared the impaired uplink; there was no documented priority/reserve for operational telemetry or local-only CCTV recording.

## Why retries caused deadlocks

The network failure created overlapping work rather than cancelling the first request:

1. A kiosk sends checkout request A. The server begins processing it, but the degraded link delays or loses packets and the response does not arrive before the client timeout.
2. The kiosk times out and sends request B while request A is **still running**. On the >400 ms-jitter / 18%-loss link, this overlap is plausible even when the application is otherwise healthy. The timeout cannot safely prove that the server did not receive or commit the operation.
3. With no idempotency key, the service treats A and B as separate checkouts. Both target the same vehicle and may both proceed into booking/payment/reservation logic.
4. If A locks the payment or booking row and then requests `vehicle_reservations`, while B locks the reservation/vehicle first and then requests the payment or booking row, each waits for a lock held by the other. That forms a cycle. PostgreSQL's deadlock detector identifies the cycle and aborts one participant, returning a deadlock error instead of allowing both transactions to wait forever.

The supplied log says process 9182 was waiting for an `ExclusiveLock` on relation `vehicle_reservations`, blocked by process 9188. That is evidence of a relation-level lock wait, but the one log line alone does not show the full cycle or prove which SQL acquired the other locks. PostgreSQL normally uses tuple locks for row updates and does **not** automatically escalate accumulated row locks into a table-level exclusive lock as some other database systems do. A relation `ExclusiveLock` can result from explicit `LOCK TABLE`, DDL, or another operation that requests a broad relation lock. The investigation should inspect `pg_locks`, `pg_stat_activity`, the SQL for both processes, and migration/maintenance activity to identify the exact source. Whether caused by an explicit broad lock or another conflicting lock order, the fix is to avoid relation-wide reservation locking and use a consistent, narrow row-level protocol.

## Why payments were captured without a confirmed vehicle hold

The checkout workflow crossed two independent systems: PostgreSQL and the payment processor. The database can roll back only its own changes. It cannot roll back a capture that the processor has accepted. In the observed ordering, capture ran before the database transaction committed the vehicle hold (or ran outside that transaction). If the later reservation write deadlocked and rolled back, the processor still had a successful capture. A retry could then issue another capture because it was treated as a new checkout.

This is an ordering and recovery design issue. The processor response may also be lost even when the processor completed the operation, so “request timed out” must never be interpreted as “capture did not happen.” The service needs a durable payment/checkout state, provider-side idempotency, and reconciliation for uncertain outcomes.

## Fix

### Request and concurrency behavior

- Require an `Idempotency-Key` for every checkout. Persist the key and a hash of the normalized request under a unique constraint. Reuse of the same key and same request returns the stored/in-progress result; reuse with a different request body is rejected. Concurrent duplicate requests never create another reservation or capture.
- Use one documented lock order for all checkout paths: idempotency key, then vehicle row, then reservation/booking rows, then payment workflow rows. Avoid `LOCK TABLE` on `vehicle_reservations`.
- Lock only the vehicle row with `FOR UPDATE NOWAIT`, or claim availability with one conditional update and inspect `RETURNING`. Keep transactions short. Set a small `lock_timeout`; do not wait indefinitely.
- If a different checkout owns the vehicle or the row is already locked, return **409 Conflict** promptly with a stable reason and `Retry-After` guidance where appropriate. For a same-key request still being processed, return the existing operation state (or a bounded conflict response) and tell the client to retry with the **same** key.
- The kiosk retries only with the same idempotency key and bounded exponential backoff with jitter. It first queries/replays the prior operation result; it never generates a new key just because a response timed out.

### Payment and reservation ordering

Use a durable state machine and never capture before the vehicle decision is committed:

1. **Hold:** in a short database transaction, claim an available vehicle and create a time-limited reservation hold; persist the idempotency record. Commit the hold.
2. **Authorize:** request authorization from the payment processor using a stable provider idempotency key derived from the checkout key. Authorization places a hold on funds but does not capture them.
3. **Commit:** in a second short database transaction, verify that the hold is still valid, mark the reservation confirmed/vehicle rented, persist the authorization reference, mark the checkout state, and insert a capture command into a transactional outbox. Commit.
4. **Capture:** an outbox worker captures after commit using the same provider idempotency key. Repeated delivery is safe. If authorization fails, release the vehicle hold and record the failure. If final database commit fails after authorization, void the authorization. If capture outcome is uncertain, query/retry with the same provider key and reconcile before taking another payment action.

The API must not claim that a payment was captured until the processor confirms it. A confirmed reservation with capture pending is represented as such and retried from the outbox. A sweeper expires abandoned holds and safely releases them. Payment webhooks and periodic provider reconciliation update the same durable payment state idempotently.

### PostgreSQL schema and fixed-flow SQL

The following is a reference schema for the real database. It uses a conditional row update as the availability claim and includes a `FOR UPDATE NOWAIT` alternative. Names and payment-provider fields can be adapted to the production schema, but the uniqueness and transaction boundaries should remain.

```sql
CREATE TABLE vehicles (
    vehicle_id       text PRIMARY KEY,
    status           text NOT NULL CHECK (status IN ('available', 'held', 'rented')),
    hold_booking_id  text,
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicle_reservations (
    booking_id       text PRIMARY KEY,
    vehicle_id       text NOT NULL REFERENCES vehicles(vehicle_id),
    customer_id      text NOT NULL,
    status           text NOT NULL CHECK (status IN ('held', 'confirmed', 'released', 'expired')),
    hold_expires_at  timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX one_live_reservation_per_vehicle
    ON vehicle_reservations (vehicle_id)
    WHERE status IN ('held', 'confirmed');

CREATE TABLE checkout_idempotency (
    idempotency_key  text PRIMARY KEY,
    request_hash     text NOT NULL,
    booking_id       text,
    state            text NOT NULL CHECK (state IN ('in_progress', 'payment_pending', 'completed', 'failed')),
    response_status  integer,
    response_body    jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_outbox (
    outbox_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key   text NOT NULL UNIQUE REFERENCES checkout_idempotency(idempotency_key),
    booking_id        text NOT NULL REFERENCES vehicle_reservations(booking_id),
    provider_auth_id  text NOT NULL,
    action            text NOT NULL CHECK (action IN ('capture', 'void')),
    status            text NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
    attempts          integer NOT NULL DEFAULT 0,
    next_attempt_at   timestamptz NOT NULL DEFAULT now(),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
```

**Phase A — idempotency record and vehicle hold.** `$1` is the client idempotency key, `$2` the canonical request hash, `$3` booking ID, `$4` vehicle ID, `$5` customer ID, and `$6` hold expiry. Keep the key insertion and hold in the same transaction so they commit or roll back together.

```sql
BEGIN;
SET LOCAL lock_timeout = '150ms';

INSERT INTO checkout_idempotency (idempotency_key, request_hash, booking_id, state)
VALUES ($1, $2, $3, 'in_progress')
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING idempotency_key;
```

If this returns no row, this key already exists (or its competing transaction held the unique-key conflict). Roll back this attempt, then read the existing record in a new statement/transaction:

```sql
ROLLBACK;

SELECT request_hash, booking_id, state, response_status, response_body
FROM checkout_idempotency
WHERE idempotency_key = $1;
```

Compare `request_hash`. If it differs, return `409 Conflict` for key reuse with a different request. If it matches and the state is complete, replay the stored response; if it is in progress, return its current state or bounded `409 Conflict` with guidance to retry using the same key. A lock timeout is handled as a bounded conflict/retry result, not as an unbounded wait.

For the newly inserted key, claim the vehicle atomically. A successful update returns one row; zero rows means the vehicle is not available. The row-level update lock is held only until this short transaction commits.

```sql
UPDATE vehicles
SET status = 'held', hold_booking_id = $3, updated_at = now()
WHERE vehicle_id = $4
  AND status = 'available'
RETURNING vehicle_id;
```

If one row is returned, create the hold and commit. The partial unique index is a second invariant protecting against multiple live reservations even if another code path is added later:

```sql
INSERT INTO vehicle_reservations
    (booking_id, vehicle_id, customer_id, status, hold_expires_at)
VALUES
    ($3, $4, $5, 'held', $6);

UPDATE checkout_idempotency
SET state = 'payment_pending', updated_at = now()
WHERE idempotency_key = $1;

COMMIT;
```

If the conditional update returns no row, persist the conflict result for this idempotency key and commit that result without creating a reservation:

```sql
UPDATE checkout_idempotency
SET state = 'completed', response_status = 409,
    response_body = jsonb_build_object('error', 'vehicle_unavailable'),
    updated_at = now()
WHERE idempotency_key = $1;

COMMIT;
```

If using explicit `NOWAIT` instead of relying on the conditional update's row lock, execute this inside Phase A before the update. SQLSTATE `55P03` (`lock_not_available`) is caught by the application, which rolls back and returns a bounded `409 Conflict`:

```sql
SELECT vehicle_id
FROM vehicles
WHERE vehicle_id = $4
FOR UPDATE NOWAIT;
```

**Phase B — authorize outside the database transaction.** Call the processor only after Phase A commits. Send `$1` (or a deterministic provider-scoped derivative of it) as the provider idempotency key. Do not call capture here. If authorization is declined, use a short transaction to release the matching hold and store the failure result. If authorization succeeds but the next DB commit cannot be completed, enqueue/perform a void using the same provider reference.

**Phase C — confirm and enqueue capture atomically.** `$7` is the processor authorization ID. Verify the hold has not expired and belongs to this booking, then confirm it and enqueue one capture command in the same commit. This transaction uses the same lock order as Phase A and never locks the whole relation.

```sql
BEGIN;
SET LOCAL lock_timeout = '150ms';

-- Preserve the global order: idempotency key, vehicle, reservation, payment workflow.
SELECT idempotency_key
FROM checkout_idempotency
WHERE idempotency_key = $1
FOR UPDATE;

SELECT vehicle_id
FROM vehicles
WHERE vehicle_id = $4
  AND status = 'held'
  AND hold_booking_id = $3
FOR UPDATE NOWAIT;

UPDATE vehicle_reservations
SET status = 'confirmed', hold_expires_at = NULL, updated_at = now()
WHERE booking_id = $3
  AND vehicle_id = $4
  AND customer_id = $5
  AND status = 'held'
  AND hold_expires_at > now()
RETURNING booking_id;
```

Only if the update returns one row, finalize the vehicle and queue capture:

```sql
UPDATE vehicles
SET status = 'rented', updated_at = now()
WHERE vehicle_id = $4
  AND status = 'held'
  AND hold_booking_id = $3
RETURNING vehicle_id;

INSERT INTO payment_outbox
    (idempotency_key, booking_id, provider_auth_id, action, status)
VALUES
    ($1, $3, $7, 'capture', 'pending')
ON CONFLICT (idempotency_key) DO NOTHING;

UPDATE checkout_idempotency
SET state = 'completed', response_status = 202,
    response_body = jsonb_build_object(
        'booking_id', $3,
        'reservation_status', 'confirmed',
        'payment_status', 'capture_pending'
    ),
    updated_at = now()
WHERE idempotency_key = $1;

COMMIT;
```

If either confirmation update returns no row, roll back, enqueue a void for the authorization, and release/expire the hold through the recovery path. A capture worker reads pending outbox rows using a short claim transaction such as `FOR UPDATE SKIP LOCKED`, calls the processor outside the transaction with the same idempotency key, and records the result in another short transaction. It retries transient failures with backoff; it does not create a new capture identity on retry.

## Prevention

- Deploy the Kuta VLAN isolation, WAN health thresholds, five-minute failback hysteresis, and WAN2 shaping described in [NETWORK_ARCHITECTURE.md](NETWORK_ARCHITECTURE.md). On cellular, guest access is dropped and checkout/controller traffic retains reserved service.
- Require idempotency keys at the API boundary and reject checkout requests that omit them. Propagate the same key from kiosk through checkout, payment authorization, capture, and reconciliation.
- Enforce one lock order, row-level vehicle claims, short transactions, and bounded `lock_timeout`; prohibit relation-wide reservation locks in checkout paths.
- Use the hold → authorize → commit → capture-outbox sequence. Track authorization, capture, void, and reservation states durably; reconcile uncertain processor outcomes before retrying a payment action.
- Return prompt conflict/in-progress responses instead of letting kiosks wait indefinitely. Configure kiosk retries with bounded exponential backoff and jitter, reusing the original key.
- Alert on checkout latency versus client timeout, idempotency conflict/replay rates, deadlock and lock-timeout counts, payment/reservation mismatches, outbox age, WAN loss/jitter, controller heartbeat misses, and IoT last-seen age.
- Exercise concurrent same-key and different-key checkout attempts, forced deadlocks/lock timeouts, payment timeouts with uncertain outcomes, WAN cuts, and cellular impairment in a repeatable staging drill. Reconcile provider captures against confirmed bookings after any incident.