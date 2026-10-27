# Web API contract

All writes use `Content-Type: application/json`. Authenticated writes also send the session cookie and `X-CSRF-Token` returned by sign-in or `/api/auth/me`. Errors are `{error,code,request_id}` with the appropriate HTTP status. API responses use `Cache-Control: no-store`. All `_paise` fields are integer paise; BV fields are integer business volume.

## Public and authentication

| Method/path | Body or result |
|---|---|
| GET `/api/health` | `{status:'ok',service}` |
| GET `/runtime-config.js` | Production frontend activation script, never secrets |
| GET `/api/public` | `{company:{name},production:true,products:[{id,name,description,price_paise,bv,active,updated_at}]}`; active products only |
| POST `/api/enquiries` | `{name,email?,phone?,message}`; requires email or phone |
| POST `/api/auth/login` | `{username,password}` → `{user,csrf}` and session cookie |
| GET `/api/auth/me` | `{user,csrf}`;401 when unauthenticated |
| POST `/api/auth/logout` | `{}`; invalidates current session |
| POST `/api/auth/change-password` | `{current_password,new_password}`; invalidates other sessions |

`user` is `{id,username,name,role:'admin'|'member',member_id,force_password_change}`. Password hashes and plaintext credentials are never returned. A forced-password account receives only user/session context, public products and empty private arrays/zero balances from bootstrap until its password changes. Other protected reads and all writes except logout/change-password are denied. This allows the security form to render without revealing account records.

## Scoped bootstrap and member actions

GET `/api/bootstrap` returns `{company,user,csrf,plan,products,members,orders,ledger,withdrawals,fundingRequests,benefits,enquiries,audit,summary}`. Admin arrays cover the installation; members receive their own money/request/order rows, descendant placements with other phones removed and empty enquiry/audit arrays. Recent financial/report lists have a1000-row limit; audit has200. Use the ledger CSV endpoint for a complete financial export.

Member metric fields are `left_bv,right_bv,self_bv,matched_bv,carry_left_bv,carry_right_bv`. Summary includes `available_paise,purchase_balance_paise,reserved_paise,paid_paise,total_income_paise`; admin summary additionally contains `member_pool_remaining_paise,member_count`.

| Method/path | Body |
|---|---|
| POST `/api/profile` | `{phone}` |
| POST `/api/funding` | `{amount_paise,reference}` |
| POST `/api/orders` | `{product_id,quantity}`; approved plan and sufficient purchase wallet required |
| POST `/api/withdrawals` | `{amount_paise}`; approved plan and sufficient commission required |
| POST `/api/benefits` | `{type:'Education'|'Monthly',period:'YYYY-MM',note}` |
| GET `/api/ledger.csv` | Complete own ledger; private downloadable CSV |

Orders, funding, realized-profit and withdrawal creation accept an optional `Idempotency-Key` header. Repeating the same key and body returns the prior result; using that key for another body returns409. Client interfaces should generate and retain one key until an uncertain submission is resolved.

## Administrator actions

| Method/path | Body |
|---|---|
| POST `/api/admin/members` | `{id,name,phone,parent_id:null|'ID',side:null|'left'|'right',username,password}`; temporary password12+ characters, forced change |
| POST `/api/admin/members/import` | `{members:[{id,name,phone,username?,parent_id,side}],dry_run:true|false}`; `parentId` also accepted; preview by default |
| POST `/api/admin/members/:id/credentials` | `{password}`; activates account, revokes prior sessions, forces change |
| POST `/api/admin/products` | `{id,name,description,price_paise,bv,active:true|false}` |
| PATCH `/api/admin/products/:id` | Any product fields except ID |
| PATCH `/api/admin/plan` | `{approved,pair_bv,pair_income_paise,max_pairs_per_closing,approval_reference,profit_share_bps?:5000}` |
| POST `/api/admin/profit` | `{amount_paise,reference}`; verified realized profit, no implied bank transaction |
| POST `/api/admin/closing` | `{idempotency_key}`; funded server-computed closing; returns `{ok,id,total_paise,members}` or replay flag |
| POST `/api/admin/orders/:id/review` | `{decision:'approve'|'reject',reference,reason?}` |
| POST `/api/admin/funding/:id/review` | `{decision:'approve'|'reject',reference,reason?}`; reference is external verification evidence |
| POST `/api/admin/withdrawals/:id/review` | `{decision:'approve'|'reject'|'paid',reference,reason?}` |
| POST `/api/admin/benefits/:id/review` | `{decision:'approve'|'reject',reference,reason?}`; approval requires external eligibility reference |
| PATCH `/api/admin/enquiries/:id` | `{status:'Open'|'Resolved'}` |
| GET `/api/admin/ledger.csv` | Complete installation ledger; private downloadable CSV |

Rejections require `reason`; approvals and externally paid withdrawals require `reference`. Review transitions reject repeat or invalid processing with409. Successful creates return201 `{ok:true,id}`; other writes normally return200 `{ok:true}`.

Import validates every row before committing: IDs/usernames unique, one root, parents present in existing data or the same import, no occupied Left/Right position, no cycle or invalid phone. Rows may arrive out of parent order; the server topologically sorts them. Commit is atomic. Imported member accounts are disabled with unusable disabled credentials; no incoming password/BV/income fields are imported. Activate them one at a time using the credential endpoint and privately deliver unique temporary credentials. Preview returns the normalized ordered records; treat that result as private personal information.

## Row fields and statuses

- Every record has `id` and `created_at` (members use `joined_at`; products use `updated_at`). Financial rows include `member_id`.
- Orders: `product_id,quantity,unit_price_paise,unit_bv,amount_paise,bv,status,reference,reason,reviewed_at`; status `Pending|Approved|Rejected`.
- Funding: `amount_paise,reference,verification_reference,status,reason,reviewed_at`; status `Pending|Approved|Rejected`.
- Withdrawals: `amount_paise,status,reference,reason,reviewed_at`; status `Pending|Approved|Rejected|Paid`.
- Benefits: `type,period,note,status,reference,reason,reviewed_at`; status `Pending|Reviewed|Approved|Rejected`. Education approval yields `Reviewed` and no loan or credit.
- Ledger: `account:'commission'|'purchase',kind,amount_paise` (signed), `source_id,description,created_at`. Zero-valued payout records are audit evidence, not additional debits.

No endpoint accepts arbitrary client-calculated balance, income, BV history, payout amount or complete application state. There is no unauthenticated state-save or member financial-adjustment API.
