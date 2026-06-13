/**
 * @fileoverview
 * Centralized Risk Configuration for the PANTHEON system.
 *
 * This file consolidates all risk management parameters. The trading bot reads
 * these values to enforce rules on position sizing, loss limits, and overall
* portfolio exposure. This makes it easy to adjust the system's risk profile
 * without changing the core application logic.
 *
 * These values are inspired by the RISK_POLICY from the PANTHEON design document.
 */

const riskConfig = {
  // --- Position Sizing ---
  
  // The fraction of the Kelly Criterion to use. 0.5 means we bet half of the
  // amount suggested by the Kelly formula, which is a common conservative approach.
  kellyFraction: 0.5,

  // The absolute maximum percentage of portfolio capital to allocate to a single position,
  // regardless of what the Kelly Criterion suggests. This is a critical safety cap.
  maxPositionSize: 0.15, // 15% of portfolio

  // The minimum percentage of portfolio capital to allocate to a position.
  // This prevents the bot from opening impractically small positions.
  // Raised from 2% → 5%: ATR sizing was floor-capping positions to 1 share
  // because baseRisk=2% × confidence × regime was producing ~$244 notional.
  minPositionSize: 0.05, // 5% of portfolio

  // The minimum required risk/reward ratio for a trade to be considered.
  // A value of 2.0 means the potential profit must be at least twice the potential loss.
  minRiskRewardRatio: 2.0,

  // --- Portfolio Level Risk ---

  // The maximum number of open positions allowed at any given time.
  maxOpenPositions: 5,

  // The maximum number of open positions allowed in the same market sector.
  // This helps to enforce diversification.
  maxPositionsPerSector: 2,

  // The maximum gross exposure of the portfolio (sum of all position values).
  maxGrossExposure: 0.75, // 75% of total portfolio value

  // --- Stop Loss and Loss Limits ---

  // The multiplier for the Average True Range (ATR) to set the initial stop loss.
  // A larger value gives the trade more room to move before being stopped out.
  atrStopMultiplier: 1.5,

  // The maximum percentage of the portfolio that can be lost in a single day.
  // If this limit is hit, the bot should stop all new trading activity for the day.
  dailyLossLimit: 0.05, // 5% of portfolio

  // The maximum percentage of the portfolio that can be lost in a single week.
  weeklyLossLimit: 0.10, // 10% of portfolio
};

module.exports = riskConfig;
