# PartnerOne interactive demonstration

A responsive concept demo with fictitious members, sample balances and illustrative business rules. No real payments, lending, authentication or shared user database are connected.

## Run and host

The contents are plain static HTML, CSS and JavaScript. Serve this directory using any static host. For local development, run `python3 -m http.server 8000` and open http://localhost:8000.

## Explore

- Overview: earnings chart, matching summary and sample profile.
- My team: traditional Left/Right placement tree with open child positions, parent selection, clickable branch focus, ancestor highlighting and individual pair-bonus cards.
- Show 1:1 example adds two fictitious members with one qualifying sale each below one parent. Credit demo bonuses settles newly formed pairs once, with separate member records and correct root-wallet credit.
- Admin console: 50/50 profit allocation, funding checks, one-time closing and request approvals.
- Earnings & wallet: simulated withdrawals, status history and CSV export.
- Benefits hub: Level 7 education application and Level 8 INR 500 monthly benefit preview.
- Reset demo restores the original records stored in this browser.

All amounts, people, rates, rank progress and volumes are illustrative. Product eligibility, payout caps, maximum levels, IDA definition, benefit duration and funding require final business approval. The prototype assumes genuine product/service sales.

The quotation and proposal PDF are provided separately and are not included in this public demo package.

## Completed validation

- One right sale creates one new pair; closing credited INR 100 once. Repeated closing was disabled.
- Zero profit blocked additional closing while preserving prior credits.
- Withdrawal reservation and simulated payout reconciled without double debit.
- Level 7 approval remained funding-pending and did not credit loan principal.
- Level 8 approval created exactly one INR 500 credit; the month could not be requested twice.
- Cancel withdrawal created no request.
- Mobile menu and 375px content fit were checked in a browser preview.

## Visual tree update validation

Verified placement occupancy, sales roll-up to every ancestor, one-sided versus matched volume, no bonus for placement without a qualifying sale, separate member bonus ownership, funding checks and duplicate-credit prevention. The existing browser-local member ledger is preserved during migration. Tree search, zoom and member forms remain local demonstrations.
