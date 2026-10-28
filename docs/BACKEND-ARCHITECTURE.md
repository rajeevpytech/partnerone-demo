# Dhanvantri web backend, release1.1.0

The backend is runnable Node.js code with a persistent SQLite database. The browser calls authenticated JSON APIs; it cannot save a computed balance, commission or complete application state. No hosting action is part of this release.

## Files and responsibilities

| File | Responsibility |
|---|---|
| `server/main.js` | HTTP listener, port/host configuration, graceful shutdown |
| `server/app.js` | Request validation, origin/CSRF/session gates, role scoping, account management and orchestration of money transactions |
| `server/auth.js` | Salted scrypt hashing and verification, random-session hashing, safe public account shape |
| `server/db.js` | Schema initialization/version guard, WAL/foreign keys, immediate transactions, immutable ledger/audit records and pool calculations |
| `server/commerce.js` | Stock holds, physical adjustments, Pending-order cancellation and recorded dispatch/delivery |
| `server/reports.js` | Immutable closing snapshots, India date filters, scoped pagination and CSV exports |
| `server/incentives.js` | Evidence-backed manual hybrid/reward credits within the approved distribution pool |
| `server/bootstrap.js` | One-time first administrator creation using privately supplied credentials |
| `server/backup.js` | Consistent owner-only database snapshots outside public assets |
| `dist/production-ui.js` | API-connected member/admin interface, import preview and review forms |
| `tests/*.test.js` | Real HTTP, database, concurrency, migration, recovery and interface/API checks |

## Transaction boundaries

1. A verified funding reference credits the member's purchase account once.
2. Order creation reserves purchase funds and, when tracked, product stock in one transaction.
3. Admin approval commits that stock hold and emits the order's BV to the appropriate ancestor branches once. Joining or importing IDs creates no BV.
4. A funded closing computes matching from approved BV, persists its exact snapshots, updates consumed BV and appends member commission credits together. Failure rolls back the whole closing.
5. A withdrawal reserves available commission once. Rejection releases it once. Marking an externally paid request records the bank reference; the application does not send a bank transfer.
6. Pending cancellation and admin rejection release purchase/stock holds once. Dispatch and delivery require an already approved order.
7. A manual hybrid/reward credit requires the plan, approval evidence and enough remaining member funding. It cannot bypass the50% pool.

## Access boundaries

Public access covers published products and enquiry submission. A member sees their own financial/request history and descendant placements; others' phones are masked. Administrative functions require a server-verified admin session. An initial-password account receives only enough context to change its password. There is no public bootstrap administrator password or demo balance in server mode.

## Run and prepare

Use the instructions in `PRODUCTION.md` and the root README. Run `npm test`, bootstrap a unique administrator privately, then use `npm run dev` for local verification. The server-mode database starts empty with an unapproved plan. The Docker/HTTPS/persistent-volume configuration is prepared for later hosting.

## Business information required before commercial activation

Confirm the final registered company name (the meeting artwork and previously supplied name differ), genuine product prices/BV, hybrid/rank rules, capping period, benefit eligibility/funding, customer policies, approved member import and deployment domain. Never import source-account credentials with member records. Online payments, bank payouts, live generative AI, lending and approved-sale refund processing require separate provider/policy implementation and verification.
