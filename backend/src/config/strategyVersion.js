/**
 * Strategy version stamp — recorded on every trade_decision_journal entry at execution
 * time so trades can be grouped by "which version of the logic was live" independent of
 * market conditions. Without this, six months from now there's no way to separate "the
 * strategy changed" from "the market changed" when comparing win rates across time.
 *
 * Bump this string whenever a change lands that could plausibly affect trading behavior —
 * scoring weights, gate thresholds, regime logic, position sizing, stop/target rules, etc.
 * Pure UI/reporting/infra changes (like the portfolio page or this file's own history)
 * don't need a bump. Use whatever granularity is useful to you; a date-based "epoch" is
 * simplest since it needs no coordination with a separate changelog.
 */
const STRATEGY_VERSION = '2026-07-11';

module.exports = { STRATEGY_VERSION };
