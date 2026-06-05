const fs = require('fs').promises;
const path = require('path');
const { query, transaction } = require('../config/database');

function parseCliArgs(argv = process.argv.slice(2)) {
    const parsed = {};

    for (let index = 0; index < argv.length; index += 1) {
        const current = argv[index];
        if (current === '--users-file' && argv[index + 1]) {
            parsed.usersFile = argv[index + 1];
            index += 1;
        }
    }

    return parsed;
}

function resolveUsersFilePath(explicitUsersFile) {
    const candidate = explicitUsersFile || process.env.MIGRATION_USERS_FILE;
    if (!candidate) {
        throw new Error('Migration input file is required. Provide --users-file <path> or set MIGRATION_USERS_FILE.');
    }

    return path.resolve(candidate);
}

/**
 * Migrate data from JSON files to PostgreSQL
 */
async function migrateFromJSON(options = {}) {
    console.log('\n=== Starting Data Migration from JSON to PostgreSQL ===\n');

    try {
        const usersFilePath = resolveUsersFilePath(options.usersFile);

        // Read JSON export file
        const usersData = JSON.parse(await fs.readFile(usersFilePath, 'utf8'));

        console.log(`Found ${usersData.length} users in JSON file`);

        let usersMigrated = 0;
        let holdingsMigrated = 0;
        let tradesMigrated = 0;
        let accountsMigrated = 0;

        // Migrate each user in a transaction
        for (const user of usersData) {
            await transaction(async (client) => {
                // 1. Insert user
                await client.query(`
                    INSERT INTO users (
                        id, username, password, email, full_name, phone,
                        created_at, last_login, is_active, ai_trading_enabled, telegram_chat_id
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    ON CONFLICT (id) DO UPDATE SET
                        username = EXCLUDED.username,
                        password = EXCLUDED.password,
                        email = EXCLUDED.email,
                        full_name = EXCLUDED.full_name,
                        phone = EXCLUDED.phone,
                        ai_trading_enabled = EXCLUDED.ai_trading_enabled,
                        telegram_chat_id = EXCLUDED.telegram_chat_id
                `, [
                    user.id,
                    user.username,
                    user.password,
                    user.email || null,
                    user.fullName || null,
                    user.phone || null,
                    user.createdAt || new Date(),
                    user.lastLogin || null,
                    user.isActive !== undefined ? user.isActive : true,
                    user.aiTradingEnabled || false,
                    user.telegramChatId || null
                ]);

                // 2. Insert trading account
                await client.query(`
                    INSERT INTO trading_accounts (
                        user_id, balance, initial_balance
                    ) VALUES ($1, $2, $3)
                    ON CONFLICT (user_id) DO UPDATE SET
                        balance = EXCLUDED.balance,
                        initial_balance = EXCLUDED.initial_balance
                `, [
                    user.id,
                    user.tradingAccount?.balance || 0,
                    user.tradingAccount?.initialBalance || 0
                ]);
                accountsMigrated++;

                // 3. Insert holdings
                if (user.holdings && Array.isArray(user.holdings)) {
                    for (const holding of user.holdings) {
                        await client.query(`
                            INSERT INTO holdings (
                                user_id, symbol, quantity, average_price, current_price,
                                market_value, gain_loss, gain_loss_percent,
                                peak_price, partial_profit_taken, sector, purchase_date
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                            ON CONFLICT (user_id, symbol) DO UPDATE SET
                                quantity = EXCLUDED.quantity,
                                average_price = EXCLUDED.average_price,
                                current_price = EXCLUDED.current_price,
                                market_value = EXCLUDED.market_value,
                                gain_loss = EXCLUDED.gain_loss,
                                gain_loss_percent = EXCLUDED.gain_loss_percent,
                                peak_price = EXCLUDED.peak_price,
                                partial_profit_taken = EXCLUDED.partial_profit_taken
                        `, [
                            user.id,
                            holding.symbol,
                            holding.quantity || 0,
                            holding.averagePrice || holding.purchasePrice || 0,
                            holding.currentPrice || 0,
                            holding.marketValue || 0,
                            holding.gainLoss || 0,
                            holding.gainLossPercent || 0,
                            holding.peakPrice || holding.currentPrice || 0,
                            holding.partialProfitTaken || false,
                            holding.sector || null,
                            holding.purchaseDate || new Date()
                        ]);
                        holdingsMigrated++;
                    }
                }

                // 4. Insert transaction history (if available)
                if (user.transactionHistory && Array.isArray(user.transactionHistory)) {
                    for (const trade of user.transactionHistory) {
                        await client.query(`
                            INSERT INTO trades (
                                user_id, symbol, action, quantity, price, total,
                                trade_date, executed_by, notes
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        `, [
                            user.id,
                            trade.symbol,
                            trade.action || trade.type,
                            trade.quantity || trade.shares,
                            trade.price,
                            trade.total || (trade.price * trade.quantity),
                            trade.date || trade.timestamp || new Date(),
                            trade.executedBy || 'MANUAL',
                            trade.notes || null
                        ]);
                        tradesMigrated++;
                    }
                }

                // 5. Insert risk configuration (if available)
                if (user.aiRiskConfig) {
                    const config = user.aiRiskConfig;
                    await client.query(`
                        INSERT INTO risk_configs (
                            user_id, max_position_size, min_position_size, max_portfolio_risk,
                            min_buy_score, stop_loss, trailing_stop_percent, take_profit_percent,
                            partial_take_profit_percent, max_open_positions, min_market_cap,
                            max_daily_trades, max_vix, reduce_positions_vix, max_sector_allocation
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                        ON CONFLICT (user_id) DO UPDATE SET
                            max_position_size = EXCLUDED.max_position_size,
                            min_position_size = EXCLUDED.min_position_size,
                            max_portfolio_risk = EXCLUDED.max_portfolio_risk,
                            min_buy_score = EXCLUDED.min_buy_score,
                            stop_loss = EXCLUDED.stop_loss,
                            trailing_stop_percent = EXCLUDED.trailing_stop_percent,
                            take_profit_percent = EXCLUDED.take_profit_percent,
                            partial_take_profit_percent = EXCLUDED.partial_take_profit_percent,
                            max_open_positions = EXCLUDED.max_open_positions,
                            min_market_cap = EXCLUDED.min_market_cap,
                            max_daily_trades = EXCLUDED.max_daily_trades,
                            max_vix = EXCLUDED.max_vix,
                            reduce_positions_vix = EXCLUDED.reduce_positions_vix,
                            max_sector_allocation = EXCLUDED.max_sector_allocation
                    `, [
                        user.id,
                        config.maxPositionSize || 0.15,
                        config.minPositionSize || 0.02,
                        config.maxPortfolioRisk || 0.60,
                        config.minBuyScore || 65,
                        config.stopLoss || -0.12,
                        config.trailingStopPercent || 0.08,
                        config.takeProfitPercent || 0.25,
                        config.partialTakeProfitPercent || 0.15,
                        config.maxOpenPositions || 25,
                        config.minMarketCap || 5000000000,
                        config.maxDailyTrades || 10,
                        config.maxVix || 30,
                        config.reducePositionsVix || 25,
                        config.maxSectorAllocation || 0.35
                    ]);
                }

                usersMigrated++;
                console.log(`✓ Migrated user: ${user.username}`);
            });
        }

        console.log('\n=== Migration Summary ===');
        console.log(`✓ Users migrated: ${usersMigrated}`);
        console.log(`✓ Trading accounts migrated: ${accountsMigrated}`);
        console.log(`✓ Holdings migrated: ${holdingsMigrated}`);
        console.log(`✓ Trades migrated: ${tradesMigrated}`);
        console.log('\n✓ Migration completed successfully!\n');

        // Create backup of the import file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${usersFilePath}.backup.${timestamp}`;
        await fs.copyFile(usersFilePath, backupPath);
        console.log(`✓ Created backup: ${path.basename(backupPath)}\n`);

        return {
            usersFilePath,
            usersMigrated,
            accountsMigrated,
            holdingsMigrated,
            tradesMigrated
        };

    } catch (error) {
        console.error('\n✗ Migration failed:', error);
        throw error;
    }
}

// Run migration if called directly
if (require.main === module) {
    migrateFromJSON(parseCliArgs())
        .then((result) => {
            console.log('Migration completed!', result);
            process.exit(0);
        })
        .catch((error) => {
            console.error('Migration failed:', error);
            process.exit(1);
        });
}

module.exports = { migrateFromJSON, parseCliArgs, resolveUsersFilePath };
