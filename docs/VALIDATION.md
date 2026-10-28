# Release1.1.0 validation — 28 October2026

The application is prepared as source. No hosting, bank transfer, carrier booking or lending action was performed.

| Suite | Passing tests | Coverage |
|---|---:|---|
| Existing accounts/ledger API | 9 | Auth, CSRF, privacy, funded50/50 matching, replay/duplicate guards, withdrawal/benefit reservations, imports, malformed input and durable records |
| Backup/recovery | 1 | Consistent independent reopen, integrity check, private permissions and overwrite refusal |
| Commerce | 5 | Additive stock setup, existing Pending orders, simultaneous last-item orders, release/commit once and role/transition checks |
| Manual incentives | 3 | Approved plan/evidence, member ownership, immutable/idempotent credits and shared-pool limits |
| Saved reports | 9 | Exact snapshots, legacy unavailable details, India date boundaries, scoped export, full-history pagination, input validation and real closing integration |
| Sessions/migration/request limits | 4 | Other-session revocation, member login suspension, import size budget, usable413 response and schema preservation/future-version rejection |
| Interface/API fixture integration | 1 | Protected commerce/report forms, cancellation display from actual API fields, stable retry IDs, refreshed409 errors, saved-statement filters and permissions |
| **Total** | **32** | |

Run `npm test` to reproduce the full suite. The cancellation display was corrected after a contract review and its targeted interface test passed again with the actual `Rejected` plus `cancelled_at` server representation.

The interface/API test uses controlled fixtures; it is not a browser session in the eventual production hosting account. Final host verification must cover the real HTTPS origin, persistence, administrator credentials, products, approved plan, backup destination and actual provider connections.
