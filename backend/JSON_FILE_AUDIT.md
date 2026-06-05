## users.json Audit Status

The backend no longer uses `users.json` on live request paths, worker paths, or helper/reporting scripts.

### Current State
1. **Live services:** PostgreSQL-backed
2. **Reporting helpers/scripts:** PostgreSQL-backed recipient resolution
3. **Manual and AI trading paths:** PostgreSQL-backed state and broker abstraction
4. **Worker health/scheduler paths:** PostgreSQL-backed coordination and status

### Remaining JSON Import Usage
1. **src/config/migrateData.js** - One-time import utility that now requires an explicit `--users-file` or `MIGRATION_USERS_FILE` input path rather than a hardcoded `users.json` dependency

## Action Plan
1. Keep one-time import tooling generic and explicit about input files.
2. Archive legacy JSON exports once migration verification is complete.
