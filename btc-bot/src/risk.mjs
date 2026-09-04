// Position sizing for LN Markets inverse futures.
//
// LN Markets quotes size in USD and settles in sats, so profit and loss are
// NOT linear in price. For a position of `quantity` USD:
//
//   long  PnL_sats = quantity * 1e8 * (1/entry - 1/exit)
//   short PnL_sats = quantity * 1e8 * (1/exit  - 1/entry)
//
// Both give a loss at the stop of `quantity * 1e8 * |1/stop - 1/entry|`, which
// is the equation this module inverts. Sizing off a linear approximation
// (notional * stop distance) overshoots on wide stops, and a bot that risks
// more than it thinks is the failure mode that ends accounts, so the exact
// inverse formula is used throughout.
//
// Leverage is DERIVED, never configured. It is chosen so that liquidation sits
// beyond the stop by a safety factor; the stop is the risk decision, and
// leverage is only the arithmetic that follows from it.

export const SATS_PER_BTC = 1e8

export const pnlSats = ({ side, entry, exit, quantityUsd }) => {
  const delta = side === 'long' ? 1 / entry - 1 / exit : 1 / exit - 1 / entry
  return quantityUsd * SATS_PER_BTC * delta
}

export const stopDistancePct = ({ side, entry, stop }) =>
  side === 'long' ? (entry - stop) / entry : (stop - entry) / entry

/**
 * Liquidation price for an inverse position at `leverage`.
 *
 * Long liquidates 1/(L+1) below entry, short 1/(L-1) above it — the asymmetry
 * is real and comes from the 1/price payoff, not from a fee model.
 */
export const liquidationPrice = ({ side, entry, leverage }) => {
  if (side === 'long') return (entry * leverage) / (leverage + 1)
  if (leverage <= 1) return Number.POSITIVE_INFINITY
  return (entry * leverage) / (leverage - 1)
}

export const marginSatsFor = ({ entry, quantityUsd, leverage }) =>
  (quantityUsd * SATS_PER_BTC) / (entry * leverage)

/**
 * True reward/risk of an inverse position, measured in sats.
 *
 * This is NOT the same as the ratio of the price distances, and the difference
 * is not a rounding detail. On an inverse contract a move up earns fewer sats
 * than an equal move down loses, so a "2R" target measured on the chart is
 * worth about 1.9R in the account for a long. Sizing is done in sats, the
 * account is denominated in sats, so the gate has to be in sats too — a system
 * that gates on the price ratio is quietly taking trades it believes are 2R and
 * that are not.
 *
 * Quantity cancels out, so this can be computed before a size is chosen.
 */
export const riskRewardRatio = ({ side, entry, stop, takeProfit }) => {
  const riskPerUsd = Math.abs(1 / stop - 1 / entry)
  if (!(riskPerUsd > 0)) return null
  const rewardPerUsd = side === 'long' ? 1 / entry - 1 / takeProfit : 1 / takeProfit - 1 / entry
  return rewardPerUsd / riskPerUsd
}

/**
 * The exit price at which an inverse position earns exactly `r` times what it
 * risks.
 *
 * A long has a ceiling: the reward per USD of an inverse long approaches
 * 1/entry as price goes to infinity, so beyond `entry/(stop) - 1`-ish multiples
 * of risk there is no price that pays R. `null` says so rather than returning a
 * number nobody can trade to.
 */
export const targetForR = ({ side, entry, stop, r }) => {
  const riskPerUsd = Math.abs(1 / stop - 1 / entry)
  if (!(riskPerUsd > 0) || !(r > 0)) return null
  if (side === 'long') {
    const inverse = 1 / entry - r * riskPerUsd
    return inverse > 0 ? 1 / inverse : null
  }
  return 1 / (1 / entry + r * riskPerUsd)
}

export const DEFAULT_RISK_SETTINGS = {
  riskPct: 1.0,
  maxLeverage: 10,
  liquidationSafety: 2.0,
  maxNotionalPct: 300,
  minQuantityUsd: 1,
  minMarginSats: 1000,
  feeRate: 0.0006,
}

/**
 * Turn a trade idea into an order, or explain why it cannot become one.
 *
 * Returns `{ ok: false, reason }` rather than throwing: a refusal is an
 * ordinary outcome the run log has to be able to show, not an error.
 */
export const planPosition = ({ side, entry, stop, takeProfit, equitySats, settings = {} }) => {
  const config = { ...DEFAULT_RISK_SETTINGS, ...settings }

  if (!(entry > 0) || !(stop > 0) || !(takeProfit > 0)) {
    return { ok: false, reason: 'entry, stop and take profit must all be positive prices' }
  }
  if (side === 'long' && !(stop < entry && takeProfit > entry)) {
    return { ok: false, reason: 'long needs stop below and take profit above entry' }
  }
  if (side === 'short' && !(stop > entry && takeProfit < entry)) {
    return { ok: false, reason: 'short needs stop above and take profit below entry' }
  }
  if (!(equitySats > 0)) {
    return { ok: false, reason: 'no equity to risk' }
  }

  const distancePct = stopDistancePct({ side, entry, stop })
  if (!(distancePct > 0)) return { ok: false, reason: 'stop distance is zero' }

  // Liquidation must sit beyond the stop by `liquidationSafety`, otherwise the
  // exchange closes the trade before the thesis is disproved. This is a
  // property of the stop alone, so it is answered before the account size is
  // consulted — otherwise a stop no leverage can survive is reported as
  // "position too small", which sends the reader looking at the wrong thing.
  const leverageCeiling = 1 / (distancePct * config.liquidationSafety) - 1
  if (leverageCeiling < 1) {
    return {
      ok: false,
      reason: `stop is ${(distancePct * 100).toFixed(2)}% away; even 1x liquidates before it`,
    }
  }
  const leverage = Math.max(1, Math.min(config.maxLeverage, Math.floor(leverageCeiling)))

  const riskSats = equitySats * (config.riskPct / 100)
  const lossPerUsd = SATS_PER_BTC * Math.abs(1 / stop - 1 / entry)
  let quantityUsd = riskSats / lossPerUsd

  const maxNotionalUsd = ((equitySats / SATS_PER_BTC) * entry * config.maxNotionalPct) / 100
  let notionalCapped = false
  if (quantityUsd > maxNotionalUsd) {
    quantityUsd = maxNotionalUsd
    notionalCapped = true
  }

  quantityUsd = Math.floor(quantityUsd)
  if (quantityUsd < config.minQuantityUsd) {
    return {
      ok: false,
      reason: `position would be ${quantityUsd} USD, below the ${config.minQuantityUsd} USD minimum — equity or stop distance too small`,
    }
  }

  const marginSats = Math.ceil(marginSatsFor({ entry, quantityUsd, leverage }))
  if (marginSats < config.minMarginSats) {
    return { ok: false, reason: `margin ${marginSats} sats is below the ${config.minMarginSats} sats minimum` }
  }
  if (marginSats > equitySats) {
    return { ok: false, reason: `margin ${marginSats} sats exceeds ${Math.floor(equitySats)} sats of equity` }
  }

  const actualRiskSats = Math.abs(pnlSats({ side, entry, exit: stop, quantityUsd }))
  const rewardSats = Math.abs(pnlSats({ side, entry, exit: takeProfit, quantityUsd }))
  const feeSats = ((quantityUsd * SATS_PER_BTC) / entry) * config.feeRate * 2

  return {
    ok: true,
    side,
    entry,
    stop,
    takeProfit,
    quantityUsd,
    leverage,
    marginSats,
    riskSats: actualRiskSats,
    rewardSats,
    feeSats,
    rr: rewardSats / actualRiskSats,
    rrNetOfFees: (rewardSats - feeSats) / (actualRiskSats + feeSats),
    stopDistancePct: distancePct,
    liquidation: liquidationPrice({ side, entry, leverage }),
    notionalCapped,
  }
}
