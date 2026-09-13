/**
 * Ingest endpoint for the daily macro/news briefing, called by a scheduled
 * cloud agent (Claude routine, not part of this codebase) that researches
 * Fed/economic and geopolitical catalysts each weekday morning — see
 * macroRiskService.js for the full data-flow explanation and why this
 * exists at all (api.telegram.org is unreachable from that agent's sandbox).
 *
 * No user session exists for this caller, so this does NOT use the normal
 * `protect` auth middleware — a shared secret (MACRO_BRIEFING_INGEST_SECRET)
 * is the only gate. Accepts GET (not POST) specifically because the calling
 * agent delivers this via WebFetch, which fetches a URL rather than sending
 * a request body — the same reason Telegram's own Bot API accepts GET.
 */
const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const macroRiskService = require('../services/macroRiskService');
const telegramAlertService = require('../services/telegramAlertService');

const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

router.get('/macro-briefing', async (req, res) => {
    const configuredSecret = process.env.MACRO_BRIEFING_INGEST_SECRET;
    if (!configuredSecret) {
        logger.error('[MacroBriefing] MACRO_BRIEFING_INGEST_SECRET not configured — refusing all ingests');
        return res.status(503).json({ ok: false, error: 'not_configured' });
    }
    if (req.query.secret !== configuredSecret) {
        logger.warn('[MacroBriefing] Rejected ingest — bad secret', { ip: req.ip });
        return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const { risk_level: riskLevel, message } = req.query;
    if (!message) {
        return res.status(400).json({ ok: false, error: 'message is required' });
    }
    if (!riskLevel || !macroRiskService.VALID_LEVELS.includes(riskLevel)) {
        return res.status(400).json({ ok: false, error: `risk_level must be one of ${macroRiskService.VALID_LEVELS.join(', ')}` });
    }

    // Store first — this is the part the trading bot depends on, so it must
    // succeed (or fail loudly) independent of whether the Telegram send below
    // works. A Telegram outage should never silently lose the risk flag.
    try {
        await macroRiskService.recordDailyRiskFlag({ riskLevel, message });
    } catch (err) {
        logger.error('[MacroBriefing] Failed to record risk flag', { error: err.message });
        return res.status(500).json({ ok: false, error: 'storage_failed' });
    }

    let telegramSent = false;
    if (ADMIN_CHAT_ID) {
        telegramSent = await telegramAlertService.sendTelegramMessage(ADMIN_CHAT_ID, message).catch(() => false);
    } else {
        logger.warn('[MacroBriefing] TELEGRAM_CHAT_ID not configured — risk flag stored but no message sent');
    }

    logger.info('[MacroBriefing] Ingested daily briefing', { riskLevel, telegramSent });
    res.json({ ok: true, telegramSent });
});

module.exports = router;
