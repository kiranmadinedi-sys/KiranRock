Trade Lots Migration & Ledger Fixes

Summary
- Added explicit `DEPOSIT` and `WITHDRAWAL` semantics for account transactions.
- Created `trade_lots` table to persist per-buy lots for FIFO realized P/L accounting.
- Added `ledgerService` endpoints (`/api/trading/ledger`, `/api/trading/ledger/trades`, `/api/trading/ledger/export`).
- Replaced frontend CSV anchor with an authenticated fetch that downloads CSV client-side.
- Implemented backfill scripts to correct historical data and populate `trade_lots`.

Migration files / scripts
- `backend/migrations/create-trade-lots.js` — creates `trade_lots` table (idempotent).
- `backend/migrations/extend-trades-action-constraint.js` — (if present) extends `trades.action` to include `DEPOSIT`/`WITHDRAWAL`.
- `backend/migrations/backfill-trade-actions.js` — (if present) converts misrecorded deposits to `DEPOSIT` action.

Backfill scripts (run locally)
- `node backend/migrations/create-trade-lots.js` — create the table.
- `node backend/scripts/backfillTradeLots.js <userId>` — populate lots for one user.
- `node backend/scripts/backfillAllTradeLots.js` — populate lots for all BUY trades missing lots.

How FIFO accounting works (short)
- Each BUY creates a `trade_lots` row with `quantity` and `remaining_quantity`.
- SELL operations consume from the oldest `trade_lots` for that symbol/user until the sell quantity is fulfilled.
- Realized P/L is computed by matching sells to lots and subtracting buy cost (FIFO) and pro-rating commission.

Verification steps
1. Start backend (default port 3001) and ensure DB connection.
2. Run the migration: `node backend/migrations/create-trade-lots.js`.
3. Backfill lots for users: `node backend/scripts/backfillAllTradeLots.js` (idempotent — skips existing lots).
4. Confirm ledger via API: `GET /api/trading/ledger` (authenticated).
5. Download CSV via UI Ledger → Export CSV (uses authenticated fetch).

Notes / Safety
- All migration scripts are idempotent. Still, run in a test/staging environment first.
- Database connection in migration scripts uses local defaults in `backend/migrations/*`. For CI/production, run equivalent SQL migrations via your normal migration tooling.
- The README here documents the local developer workflow; include these steps in your central ops docs if deploying.

Contact
- If you want, I can open the PR for you (requires pushing the branch to your remote). If push fails, I'll provide the branch and commit details to open the PR manually.
