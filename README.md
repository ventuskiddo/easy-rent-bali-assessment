# Easy Rent Bali — Kuta Sunset Outage Assessment

A self-contained TypeScript assessment project for diagnosing and mitigating the Kuta Hub outage. It includes a network architecture and blameless RCA, an idempotent concurrent checkout patch, and a telemetry triage engine with retrying alert delivery. The runnable implementation uses in-memory adapters, so no Docker or external database is needed.

## Incident in three lines

- A thunderstorm cut Kuta Hub's primary fiber; unstable cellular failover introduced >400 ms jitter, 18% packet loss, and connection flapping.
- Kiosk retries overlapped unfinished checkouts, producing deadlocks and duplicate payment captures while guest Wi-Fi competed with POS and controller traffic.
- The IoT gateway lost connectivity, leaving some returning vehicles untracked.

## Prerequisites

- Node.js 20 or newer (the assessment was also run with Node.js 24).
- npm.

## Setup

From the project directory:

```sh
npm install
```

No Docker, PostgreSQL server, Redis server, or cloud credentials are required for the local implementation.

## Run the project

```sh
npm test
npm run test:concurrency
npm run triage
npm run typecheck
```

- `npm test` runs the Vitest suite, including telemetry rules, loader validation, dispatcher retry behavior, triage report generation, and checkout concurrency.
- `npm run test:concurrency` runs the five-request checkout scenarios directly. Each scenario runs 50 times and prints a summary table.
- `npm run triage` reads `data/outage_telemetry.json`, evaluates all rules, dispatches alerts through the seeded mock webhook, and overwrites `output/incident_reconciliation.json`.
- `npm run typecheck` runs `tsc --noEmit` with strict TypeScript settings.

## Repository layout

```text
easy-rent-bali-assessment/
├── ai_session_logs/
│   ├── STEERING_AUDIT.md
│   └── raw_logs/.gitkeep
├── data/outage_telemetry.json
├── docs/
│   ├── NETWORK_ARCHITECTURE.md
│   └── RCA.md
├── output/incident_reconciliation.json
├── src/
│   ├── engine/
│   │   ├── config.ts
│   │   ├── dispatcher.ts
│   │   ├── rules/                 # critical, offline, maintenance, registry
│   │   ├── sinks/mock_alert_sink.ts
│   │   ├── telemetry_loader.ts
│   │   ├── triage_engine.ts
│   │   └── *.test.ts
│   └── patch/
│       ├── checkout_handler.ts
│       ├── lib/                   # types, idempotency, vehicle lock, repository, payment mock
│       └── test_concurrency.ts
├── package.json
├── package-lock.json
├── tsconfig.json
└── vitest.config.ts
```

## Design decisions

### In-memory adapters behind interfaces

The checkout handler depends on `IdempotencyStore`, `VehicleLock`, `ReservationRepository`, and `PaymentGateway` interfaces. The triage path accepts injected clock, sleeper, RNG, and alert sink. The supplied in-memory adapters make the assessment reproducible without infrastructure. Their atomic map operations are safe within one Node process; they do not coordinate multiple processes and their state does not survive restarts.

### Idempotency and lock ordering

Checkout requires an idempotency key. The store claims it with one synchronous check-and-set operation; it never performs a separate read followed by a write. The request fingerprint binds the key to its booking, vehicle, customer, and amount. In-flight repeats return `409 REQUEST_IN_PROGRESS`, completed repeats replay the stored response, and a changed payload returns `422 IDEMPOTENCY_KEY_REUSED`.

Only final `200` responses and `409 VEHICLE_UNAVAILABLE` responses are cached. A `500` abandons the in-progress claim, allowing a retry with the same key to run again.

The checkout order is **idempotency key → vehicle lock/reservation → payment operations**. A token-owned vehicle lock uses a TTL and compare-token release; the repository also atomically reserves only an available vehicle. Payment capture happens only after the reservation is confirmed. A production implementation should use durable database transactions and an outbox for capture, as described in the RCA.

### Resilient dispatch

Alerts are sorted by severity: critical, offline, then maintenance. The dispatcher retries timeout, network, and 5xx failures using full jitter over an exponential ceiling (200 ms base, 5,000 ms cap, five attempts). Non-retryable 4xx responses stop immediately. The alert ID is stable for a device, incident type, and run timestamp; the sink deduplicates by this ID so an accepted alert whose acknowledgment was lost is not accepted twice.

## Replacing the in-memory adapters

- **PostgreSQL:** implement `IdempotencyStore` with a unique idempotency-key constraint and `INSERT ... ON CONFLICT DO NOTHING`; implement vehicle reservation with a conditional `UPDATE ... WHERE status = 'available' RETURNING` or `SELECT ... FOR UPDATE NOWAIT`. Use a consistent lock order and commit a confirmed hold plus a payment-outbox row atomically. The exact schema and SQL flow are in [RCA.md](docs/RCA.md).
- **Redis:** implement the vehicle lock with `SET lock:<vehicle_id> <owner-token> NX PX <ttl-ms>`. Release only with a Lua compare-and-delete script that checks the token. Keep the database conditional reservation as a second correctness guard; a Redis lock alone must not replace durable vehicle state.
- **Payment provider:** replace the mock with an adapter that uses a stable provider idempotency key for authorization and capture. Capture from a transactional outbox after the confirmed reservation commit, and reconcile uncertain outcomes.
- **Alert webhook:** implement `AlertSink` with an HTTP client that sends `alert_id` as the receiver's idempotency key. Keep retry classification limited to timeouts, network failures, and server errors.

The network failover and VLAN design is a deployment blueprint; it is not configured automatically by this code.

## Documentation and session records

- [Network architecture](docs/NETWORK_ARCHITECTURE.md) — topology, VLANs, firewall rules, dual-WAN failover, and cellular shaping.
- [Root cause analysis](docs/RCA.md) — transaction failure analysis, PostgreSQL schema/queries, and corrective workflow.
- [Steering audit](ai_session_logs/STEERING_AUDIT.md) — phase summary and verification record.
- [Raw session logs](ai_session_logs/raw_logs/) — Codex session rollouts (`.jsonl`) plus a readable transcript (`raw_logs.md`).
