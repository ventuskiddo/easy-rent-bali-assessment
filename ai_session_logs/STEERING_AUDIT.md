# Steering Audit

## Assessment record

- **Project:** Easy Rent Bali — Kuta Sunset Outage
- **Assessment date:** 2026-11-05 (Asia/Jakarta / WITA)
- **Scope:** Network design, checkout consistency patch, telemetry triage engine, and project documentation.

## Phase decisions and evidence

| Phase | User direction | Implemented evidence |
|---|---|---|
| 1 — Scaffold | Required project paths, strict TypeScript scripts, exact starter telemetry, placeholders, and no logic. | `package.json`, `tsconfig.json`, exact telemetry file, and required directories/files. |
| 2 — Network | Specific Kuta/HQ/cloud topology, VLAN/subnet matrix, deny-by-default flows, failover, and WAN2 shaping. | `docs/NETWORK_ARCHITECTURE.md`; guest `/22` counts are documented as 1,022 usable hosts and 973 dynamic leases after reservations. |
| 3 — RCA | Blameless explanation of retry overlap, deadlocks, payment ordering, and PostgreSQL fix SQL. | `docs/RCA.md`; notes that PostgreSQL does not normally auto-escalate row locks and that the logged relation lock needs source investigation. |
| 4 — Checkout patch | Atomic idempotency, token-owned TTL vehicle lock, reserve/authorize/confirm/capture order, structured responses, and 50-run concurrency checks. | `src/patch/` implementation and concurrency runner. |
| 5 — Triage | Validated telemetry, independent rules, seeded mock sink, full-jitter retries, and generated reconciliation output. | `src/engine/`, tests, and `output/incident_reconciliation.json`. |
| 6 — Closeout | README, rerun checks, and honest self-review. | `README.md`; verification listed below. |

## Verification record

Most recent observed checks:

- `npm run typecheck` — passed (`tsc --noEmit`).
- `npm test` — passed: 5 test files, 13 tests, including the 500-key-release regression.
- `npm run triage` — passed: 8 valid records, 6 alerts, 0 invalid records; 6 delivered and 0 failed after retries.
- `npm run test:concurrency` — passed in the previous phase: each of two scenarios ran 50 times, with 1 success / 4 conflicts per run and one capture per run.

The local `npm` PowerShell shim referenced a missing roaming-profile `npm-cli.js`; these checks were run through the installed npm CLI using Node directly. Vitest and triage needed workspace write access for temporary/generated files. Raw tool/session transcripts were not captured; `raw_logs/` therefore contains only `.gitkeep`.

## Known limits recorded for review

- Checkout stores and vehicle locks are in-memory and process-local; PostgreSQL/Redis adapters are design guidance, not implemented production adapters.
- The payment mock does not model every uncertain provider outcome or real reconciliation workflow; the production outbox pattern is documented in `docs/RCA.md`.
- The network document is a design blueprint, not a tested configuration for a specific router, firewall, carrier, or cloud controller.


## Instance 1 — Failed checkouts cached forever under the idempotency key
- **File:** src/patch/checkout_handler.ts, src/patch/lib/idempotency_store.ts, src/patch/lib/types.ts
- **What the AI generated:** After any checkout attempt, the handler always called `idempotencyStore.complete(key, fingerprint, checkoutResponse)`, including when the response was `500 CHECKOUT_FAILED`. The 500 body itself told the client: "retry with the same idempotency key."
- **Why it was wrong:** The stored 500 was replayed on every retry with that key. A kiosk hitting a transient gateway or repository failure during the outage would retry correctly with the same key and get the cached 500 forever, even after the dependency recovered. The customer could not complete checkout without a new key, which brings back the duplicate-checkout risk the patch exists to prevent.
- **How I found it:** A probe script against the original code. First call with the payment gateway down → `500`; same-key retry with the gateway back → still `500 CHECKOUT_FAILED`.
- **How I steered it:** "A failed checkout’s 500 response is cached by idempotencyStore.complete(), so retrying with the same key replays the 500 forever. Only store final results (200, and 409 VEHICLE_UNAVAILABLE). On a 500, release the key so a retry can run again, and add a test for it."
- **Result:**
  - New `abandon(key, fingerprint)` on `IdempotencyStore` removes only a matching in-progress claim.
  - The handler calls `abandon()` on a 500 (and when `complete()` itself fails) instead of caching the error.
  - `complete()` now accepts only final results: `200` or `409 VEHICLE_UNAVAILABLE`.
  - Regression test `src/patch/checkout_handler.test.ts`: a transient reservation failure returns 500 with 0 captures → a same-key retry returns 200 with 1 capture → a further retry replays the identical 200 with still 1 capture.
  - Verification: typecheck passed; Vitest 5 files / 13 tests passed; the same probe now returns 500 → 200.


## Instance 2 — Contradictory VLAN 50 DHCP scope math
- **File:** docs/NETWORK_ARCHITECTURE.md (VLAN matrix, VLAN 50 row + DHCP note)
- **What the AI generated:** The note said the `.1` addresses of 172.16.51–53 were outside the DHCP scope, while the scope 172.16.50.10–172.16.53.250 contains them and the 973-lease total already counted them.
- **Why it was wrong:** A network engineer configuring DHCP from this doc would get conflicting instructions — either excluding 3 addresses the count assumed were leasable, or doubting the whole lease calculation.
- **How I steered it:** "In the VLAN 50 DHCP note you say the .1 addresses of 172.16.51–53 are outside the scope, but they're inside 172.16.50.10–172.16.53.250 and your 973 count includes them. Fix the contradiction and show the math"
- **Result:** Note now states .51.1/.52.1/.53.1 are DHCP-eligible and shows the math: 1,022 usable; 1,009 in range; 36 exclusions in range → 973 leases; cross-check 1,022 − (32 + 16 + 1) = 973.