# Dhanvantri Global Pvt Ltd web server

This package separates the existing browser demonstration from the real server mode. The server always returns `window.DhanvantriRuntime={mode:'production'}` at `/runtime-config.js`. The production UI must use only the API. No browser-local financial state is accepted by any endpoint.

## Runtime and data

- Node.js 24.13 or newer, using the built-in HTTP, crypto and SQLite modules; no third-party runtime packages.
- SQLite is durable **only when `DATABASE_PATH` resides on a persistent disk/volume**. WAL, foreign keys, full synchronous writes, immediate transactions and a 5-second busy timeout are enabled.
- Use **one service replica** with the database on local persistent storage. Do not place SQLite on NFS or share it across independent hosts. For multiple replicas, migrate to a transactionally equivalent PostgreSQL implementation before scaling.
- The schema initializes an empty installation and an **unapproved** plan. No real or invented members, contacts, products, prices, funds or passwords are seeded.
- Store the database and backups outside `dist/` and outside any Git checkout being published. Backup files contain private customer information and password hashes.

## First startup

1. Set `DATABASE_PATH` to an absolute writable persistent path. Supply `PUBLIC_ORIGIN` as the exact HTTPS origin without a trailing slash, for example `https://portal.company.example`. Set `NODE_ENV=production` for the public service.
2. Run `npm run bootstrap` once with `ADMIN_USERNAME`, `ADMIN_PASSWORD` and optional `ADMIN_NAME` set privately in the command environment. Use a unique password of at least 12 characters. The command refuses to run if an admin already exists and never prints the password.
3. Remove `ADMIN_PASSWORD` from the environment after bootstrap. Start the service with `npm start`.
4. Put the HTTP listener behind an HTTPS reverse proxy. Keep the application port private. Production startup refuses HTTP public origins or insecure cookies.
5. Sign in as admin, enter genuine products/prices/BV, create or import verified member placements, activate individual accounts privately, and configure the business-approved plan. Imported accounts are disabled until individually activated; temporary passwords must be changed on first sign-in.
6. Record realized profit with a verifiable accounting reference before running any commission closing. Nothing is paid to banks by this server.

Do not commit `.env`, `data/`, databases, backups or credentials. Do not point the production frontend at the GitHub Pages sample ledger.

## Container deployment

`Dockerfile` runs as the unprivileged Node user and expects a writable `/data` volume. `docker-compose.yml` binds port3000 to `127.0.0.1`, enables a read-only root filesystem and drops capabilities. Supply `PUBLIC_ORIGIN` through your deployment's environment. Map the service through your existing HTTPS reverse proxy. Do not create a public listener without TLS.

For Render or Railway, select a **persistent disk/volume**, mount `/data`, set `DATABASE_PATH=/data/dhanvantri.sqlite`, set the correct `PUBLIC_ORIGIN`, and retain one replica. Static GitHub Pages cannot run this backend. Ephemeral free web instances will lose SQLite state and must not be described as production storage.

The provided health check calls `/api/health` and confirms database accessibility without revealing data. The service listens on `PORT` and handles SIGTERM/SIGINT with a graceful close.

## Reverse proxy IP configuration

The default trusts no forwarded headers. If a reverse proxy is used, configure `TRUST_PROXY_IPS` with **only its exact socket-peer IP addresses**, comma-separated. The proxy must overwrite `X-Real-IP` with the actual client address, not pass through a visitor-supplied value. The app uses that header only when its direct peer matches the allowlist and the value parses as an IP address. Never use wildcards or an untrusted proxy address. Without configuration, visitors behind one proxy share login/enquiry IP limits.

When Nginx runs on the host and Node runs inside Docker, its observed peer is normally the Docker bridge gateway, not `127.0.0.1`. Verify the actual private peer address in your deployment before setting the allowlist. Compose forwards `TRUST_PROXY_IPS` from its environment.

Suggested Nginx location directives for a trusted private listener:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 64k;
}
```

Use your established certificate-renewal setup. An origin change requires updating `PUBLIC_ORIGIN` and restarting the service.

## Financial model and limits

- Prices, balances and ledger amounts use **integer paise**. BV and pair quantities use integers. The server calculates all totals from stored product snapshots and approved orders.
- Approved genuine product orders roll BV to ancestors on the branch where each sale occurred. Adding/importing a member creates no BV, pair or credit.
- Orders reserve the separate purchase wallet when created. An administrator verifies a funding transfer before top-up. Rejecting an order releases its purchase reservation once. Approving it emits BV once.
- A matching closing consumes equal left/right BV once, carries unmatched BV forward and credits each member's own commission account. The configured cap applies **per closing**, not per day or rank.
- The lifetime member distribution pool is50% of externally recorded realized profit, rounded down to whole paise per event. Matching and monthly-support credits consume this pool. The other50% stays unallocated to member credits. No commission closing runs if the full closing exceeds the remaining pool.
- Pair BV and pair rate cannot be edited after matching business events exist; changes require a reviewed migration. The app does not infer unverified Kizaara plan terms, tax rates, rank rules or capping policy.
- Withdrawal requests reserve available commission immediately. Rejection releases the reservation once. Approval records a review; marking externally paid requires an approved request and unique bank reference. The system **does not initiate transfers**.
- Monthly support is₹500 only after an administrator supplies an external eligibility evidence reference and the approved member pool can fund it. The server does not infer eligibility from sensitive information. One application per member/type/month prevents duplicate credits.
- Education applications can be recorded as **Reviewed**, with no loan principal credited. Real lending eligibility, agreements, funding and disbursement need a separate approved lending workflow.
- External transfers/profit/eligibility are manual attestations by an administrator. A gateway, bank reconciliation, tax filing or regulated lending service is not connected. Refunds after BV approval require an operator-reviewed compensating-entry process; do not edit the immutable ledger.

## Security and privacy

- Salted scrypt hashes (`N=32768,r=8,p=3`) with timing-safe comparison; minimum12-character passwords.
- Random session tokens stored only as SHA-256 hashes in SQLite; cookies are HTTP-only, SameSite Strict and Secure in production, with an8-hour default expiry.
- Authenticated writes require a per-session `X-CSRF-Token`. Supplied cross-origin requests are rejected. No wildcard CORS is configured.
- Login attempts are limited by username and client IP using durable counters. Public enquiries have a separate IP limit. The server never logs request bodies, passwords or cookies.
- Members see only their own money/order/request records and their own descendant placements. Other members' phone numbers are masked. Only admins can access imports, plan changes, products, reviews, financial closings, enquiries and audit history.
- Ledger, business events and audit records cannot be updated or deleted through either API routes or normal SQL mutations because of database triggers. Administrative filesystem access remains powerful; restrict database-file access and maintain backups.
- CSV exports protect text against spreadsheet formula prefixes. No uploaded customer files or government IDs are accepted by this version.
- Admin credential resets deactivate older sessions, issue a forced password change and require private delivery of a unique temporary password. There is no self-service email recovery provider yet.

## Backup, recovery and verification

Run `npm run backup` with `DATABASE_PATH` and optional absolute `BACKUP_PATH`. It uses SQLite `VACUUM INTO` for a consistent snapshot, refuses to overwrite files and creates files with owner-only permissions. Copy encrypted backups to your existing restricted off-host backup destination. Test recovery before accepting real customer money: stop the service, preserve the current disk, restore a validated snapshot to `DATABASE_PATH`, set ownership and restart. Do not copy only a live WAL database file.

Run `npm test` before deploying. The suite exercises auth, CSRF, role and member privacy, transactionally funded closing, duplicate approval/credit prevention, concurrent overdraw prevention, reservation release, payout transition rules, monthly support funding, education non-disbursal, atomic verified imports, malformed URL handling, input validation and durable records. A passing suite is a code-level check; also verify your TLS, domain, persistence, restore procedure, credentials, approved plan, products, contact/legal content and live member workflows on the selected host.
