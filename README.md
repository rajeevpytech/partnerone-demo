# Dhanvantri Global Pvt Ltd

Web storefront and partner portal with the requested classic dashboard and Left/Right tree layout, a new emerald-and-gold company emblem, member reports and administrator workflows.

This repository has two explicitly separate modes:

- **Public demonstration:** the GitHub Pages link serves fictitious records in browser-local storage. It is for reviewing the interface; it is not a live financial system.
- **Server application:** `npm start` serves the database-connected application, real account sessions and server-calculated records. Production starts empty. It never imports demonstration balances or members.

## Included server workflows

Member/admin login, forced initial-password change, protected member data, product management, verified CSV/JSON tree import, purchase-wallet requests, orders, administrator review, approved-sale BV roll-up, funded 1:1 closing, carry forward, income/ledger exports, payout reservations and review, benefit requests, enquiries and audit history. Financial amounts use integer paise. The member allocation is 50% of verified realised profit; the company retains the other 50% outside member credits.

The server rejects duplicate processed actions and unfunded closings. Adding a member generates no income. Imported accounts remain disabled until the administrator issues individual credentials. Other members' phone numbers are hidden from member accounts. No private OM account records have been fabricated or published.

## Run locally

Use Node.js 24.13 or newer. No third-party runtime dependencies are needed.

```sh
npm test
npm run dev
```

Open the URL printed by the server. The initial catalogue and accounts are empty. To create the first administrator, use the bootstrap command with a unique password supplied privately through the environment. See [production setup](docs/PRODUCTION.md). Never use a reference-site password for this application.

The repository's GitHub Pages files live at the root. `prepare-dist.cjs` copies only the public asset allowlist into `dist/` for the server. The packaged source distribution already contains `dist/`. Database files, `.env`, backups and server code are outside that static directory.

## VPS deployment

The Docker configuration runs one application process as a non-root user, keeps the application port on loopback and stores SQLite in a persistent volume. It requires an existing HTTPS reverse proxy and the real company domain.

```sh
cp .env.example .env
```

Set `PUBLIC_ORIGIN` in `.env` to the exact HTTPS company origin. Keep `.env` private. Then:

```sh
docker compose build
export ADMIN_USERNAME=companyadmin
export ADMIN_NAME='Company Administrator'
read -rsp 'Unique initial admin password: ' ADMIN_PASSWORD
export ADMIN_PASSWORD
docker compose run --rm --no-deps -e ADMIN_USERNAME -e ADMIN_NAME -e ADMIN_PASSWORD web npm run bootstrap
unset ADMIN_PASSWORD
docker compose up -d
```

Use `nginx.conf.example` with your existing certificate workflow, replacing its placeholder domain. Configure only the actual reverse-proxy peer in `TRUST_PROXY_IPS` after verifying its address. The production server refuses a non-HTTPS public origin. Configure and test restricted off-host backups and restoration before accepting customer money.

```sh
docker compose exec web npm run backup
```

Backups are written inside the persistent data volume by default, outside public assets. Copy them to your restricted backup destination. Retain one replica; this SQLite deployment is not a multi-host database.

## Launch inputs still required

The company must supply its actual domain/hosting access, products/prices/BV, written compensation rules (including cap period, hybrid bonuses and levels), authorised member data, registered/contact information and final customer/partner policies. Configure and verify these on the selected host before activating real operations.

Payments, bank transfers and benefit eligibility are externally verified manual workflows. This version does not include a payment gateway, automated bank transfers, KYC document processing, live generative AI, shipping integration, automatic loan approval or approved-sale refund/reversal processing. Education requests create no loan disbursement. A monthly support approval requires external eligibility evidence and available company funding. These integrations cannot be described as live before they are separately configured and tested.

## Validation and operation

`npm test` covers authentication, CSRF/origin checks, member privacy, forced-password access restrictions, atomic member import, funded commission closing, duplicate-action prevention, concurrent withdrawal reservations, payout transitions, malformed requests and backup recovery. Public production pages and forms are also checked in the browser. See [API contract](docs/API.md) and [production operation](docs/PRODUCTION.md) for exact capabilities and limits.
