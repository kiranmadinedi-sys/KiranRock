## Files Still Using users.json (OLD JSON FILE)

### CRITICAL - Need Immediate Fix:
1. **src/services/portfolioService.js** - Portfolio operations
2. **src/services/tradingAccountService.js** - Trading account management
3. **src/services/tradingService.js** - Trade execution
4. **src/services/aiTradingBotService.js** - AI Trading bot
5. **src/services/aiTradingScheduler.js** - AI Trading scheduler
6. **src/services/userService.js** - User lookup (used by auth)
7. **src/services/alertService.js** - Alert management
8. **src/services/backtestService.js** - Backtesting
9. **src/services/optionsScheduler.js** - Options scheduling

### MEDIUM Priority:
10. **src/routes/aiTradingRoutes.js** - AI Trading API routes
11. **src/routes/enhancedAITradingRoutes.js** - Enhanced AI routes

### LOW Priority (Reporting/Batches):
12. **src/scheduleWeeklyReportBatch.js** - Weekly reports
13. **src/sendWeeklyReportToTelegram.js** - Telegram reports
14. **src/testTelegramHello.js** - Test script

### Database Migration:
15. **src/config/migrateData.js** - Migration script (intentional)

## Action Plan:
These services need to be updated to query PostgreSQL database instead of reading users.json.

The authentication middleware has been fixed, but all other services still use the old file.
