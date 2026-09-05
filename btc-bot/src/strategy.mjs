// The trading decision.
//
// One idea, stated plainly: trade WITH the higher-timeframe trend, only from a
// level the market has already turned at, and only once a candle has closed
// showing it turned there again. Everything else is a filter that says no.
//
// This is deliberately narrow. The previous price-action engine in the openclaw
// repo scored a dozen weak signals into one number, and its own measurement
// notes record the result: 26-45% win rate, losing across every exchange and
// window tested. A score built from weak parts hides which part was wrong. Here
// every rejection is named, so a losing run can be read afterwards and the
// specific gate that let it through can be found.
//
// MEASURED RESULT, 2026-09-04: this does NOT have an edge. Over eight months of
// LN Markets hourly candles it returns -37% with a profit factor of 0.61 across
// 133 trades, and every single-rule variation of it also loses (best: 0.74).
// The risk machinery around it is sound — losses land on the intended 1% — but
// the entries do not. See the README's "What the backtest says".
//
// Do not tune these constants against that window to find a positive number.
// The openclaw engine's own notes record where that leads, and this is the
// second independent attempt at the same idea to measure the same thing.

import { riskRewardRatio, targetForR } from './risk.mjs'
import {
  atr,
  buildZones,
  candleSignal,
  lastDefined,
  marketStructure,
  nextSwingAbove,
  nextSwingBelow,
} from './priceaction.mjs'

export const DEFAULT_STRATEGY = {
  // Structure
  htfLookback: 2,
  ltfLookback: 2,
  // Reward/risk gate. A system that is right 40% of the time still makes money
  // at 2R; at 1R it needs to be right more often than price action is.
  minRR: 2.0,
  tpMinR: 2.0,
  // An uncapped target passes the R/R gate with a price the market rarely
  // reaches. The openclaw engine measured this directly and capping was better
  // over full history on all three exchanges tested.
  tpMaxR: 5.0,
  // Stop sits this many ATR beyond the zone edge, so it is outside the noise
  // that created the zone rather than on its exact tick.
  stopAtrBuffer: 0.5,
  // How far above a demand zone (below a supply zone) the trigger candle may
  // close and still count as trading "from" the zone.
  zoneMaxDistanceAtr: 1.0,
  minZoneTouches: 1,
  // Quality filters from the supply-and-demand school this was tuned towards.
  // Both ask whether a level is worth trading rather than whether it exists,
  // which is the question the original engine never asked — and a 26% win rate
  // is what not asking it looks like.
  //
  // requireSweep: the candle forming the zone must have taken out the previous
  //   candle's extreme. A zone that left stops sitting under it tends to get
  //   traded through on the way to collect them.
  // requireImbalance: an unfilled three-candle gap must sit at the zone. It
  //   marks a one-sided move rather than a two-way auction.
  requireSweep: true,
  requireImbalance: true,
  // Volatility band, ATR as a percentage of price on the entry timeframe. Too
  // quiet and the stop is inside the spread; too violent and the zone is noise.
  atrPctMin: 0.15,
  atrPctMax: 4.0,
  minHtfCandles: 60,
  minLtfCandles: 60,
}

const reject = (reason, context = {}) => ({ action: 'none', reason, context })

/**
 * Decide whether to open a position.
 *
 * `htfCandles` sets the trend (4h by default), `ltfCandles` provides the entry
 * trigger (1h). Both must be CLOSED candles — see `dropForming` in candles.mjs.
 */
export const evaluateEntry = ({ htfCandles, ltfCandles, settings = {} }) => {
  const config = { ...DEFAULT_STRATEGY, ...settings }

  if (!Array.isArray(htfCandles) || htfCandles.length < config.minHtfCandles) {
    return reject(`not enough higher-timeframe candles (${htfCandles?.length ?? 0}/${config.minHtfCandles})`)
  }
  if (!Array.isArray(ltfCandles) || ltfCandles.length < config.minLtfCandles) {
    return reject(`not enough entry-timeframe candles (${ltfCandles?.length ?? 0}/${config.minLtfCandles})`)
  }

  const htf = marketStructure(htfCandles, { lookback: config.htfLookback })
  const ltf = marketStructure(ltfCandles, { lookback: config.ltfLookback })
  const ltfAtr = lastDefined(atr(ltfCandles, 14))
  const trigger = ltfCandles.at(-1)
  const price = trigger.close
  const context = {
    htfBias: htf.bias,
    htfEvent: htf.event,
    ltfBias: ltf.bias,
    ltfEvent: ltf.event,
    price,
    ltfAtr,
    atrPct: ltfAtr ? (ltfAtr / price) * 100 : null,
  }

  if (!ltfAtr) return reject('ATR is not defined yet', context)
  if (htf.bias === 'range') return reject('higher timeframe has no trend — ranging', context)

  const atrPct = (ltfAtr / price) * 100
  if (atrPct < config.atrPctMin) return reject(`too quiet: ATR ${atrPct.toFixed(2)}% < ${config.atrPctMin}%`, context)
  if (atrPct > config.atrPctMax) return reject(`too volatile: ATR ${atrPct.toFixed(2)}% > ${config.atrPctMax}%`, context)

  // The higher timeframe turning against the trend is a reason to stand aside,
  // not to fade it. A CHoCH means the trend is under question; the next
  // pullback into it is exactly the trap this filter exists to avoid.
  if (htf.bias === 'up' && htf.event === 'CHoCH_DOWN') return reject('higher timeframe just broke down', context)
  if (htf.bias === 'down' && htf.event === 'CHoCH_UP') return reject('higher timeframe just broke up', context)

  const side = htf.bias === 'up' ? 'long' : 'short'
  const wantedZoneType = side === 'long' ? 'demand' : 'supply'
  const zones = buildZones(ltfCandles, { lookback: config.ltfLookback })
    .filter((zone) => zone.type === wantedZoneType && zone.touches >= config.minZoneTouches)

  // A zone the price has already entered still counts, and is in fact the one
  // that matters: requiring `zone.high <= price` for a long threw away every
  // pullback that closed INSIDE the demand it bounced from, and silently
  // measured the distance to the next zone far below instead. The test that
  // caught this is "reaching the zone without a trigger candle is refused" —
  // it was refused for the wrong reason.
  const candidates =
    side === 'long'
      ? zones.filter((zone) => zone.low <= price).sort((a, b) => b.high - a.high)
      : zones.filter((zone) => zone.high >= price).sort((a, b) => a.low - b.low)

  const zone = candidates[0]
  if (!zone) return reject(`no ${wantedZoneType} zone on the ${side === 'long' ? 'downside' : 'upside'}`, context)

  if (config.requireSweep && !zone.swept) {
    return reject('the zone never swept the liquidity below it — stops are still resting there', {
      ...context,
      zone,
    })
  }
  if (config.requireImbalance && !zone.imbalance) {
    return reject('no unfilled imbalance at the zone — the move away from it was two-sided', {
      ...context,
      zone,
    })
  }

  // Inside the zone the distance is zero, not negative.
  const distance = Math.max(0, side === 'long' ? price - zone.high : zone.low - price)
  if (distance > ltfAtr * config.zoneMaxDistanceAtr) {
    return reject(
      `price is ${(distance / ltfAtr).toFixed(2)} ATR from the ${wantedZoneType} zone (max ${config.zoneMaxDistanceAtr})`,
      { ...context, zone }
    )
  }

  const touched = side === 'long' ? trigger.low <= zone.high : trigger.high >= zone.low
  if (!touched) return reject('the trigger candle never reached the zone', { ...context, zone })

  const holdsZone = side === 'long' ? trigger.close > zone.low : trigger.close < zone.high
  if (!holdsZone) return reject('the trigger candle closed through the zone', { ...context, zone })

  const signal = candleSignal(ltfCandles, ltfCandles.length - 1, { atrValue: ltfAtr })
  const confirmation = side === 'long' ? signal.bullish : signal.bearish
  if (!confirmation) {
    return reject(`no ${side === 'long' ? 'bullish' : 'bearish'} trigger candle at the zone`, {
      ...context,
      zone,
      patterns: signal.patterns,
    })
  }

  const entry = price
  const stop =
    side === 'long' ? zone.low - ltfAtr * config.stopAtrBuffer : zone.high + ltfAtr * config.stopAtrBuffer
  const riskDistance = Math.abs(entry - stop)
  if (!(riskDistance > 0)) return reject('degenerate stop distance', { ...context, zone })

  // Target the next place the market has already proved it reacts, then hold it
  // inside the R band: too near and the gate rejects a good idea, too far and it
  // accepts a price that never prints.
  //
  // The R band is measured in SATS, not in price distance. See
  // `riskRewardRatio` in risk.mjs: on an inverse contract those two differ by
  // several percent, and gating on the price ratio hands the sizing step a
  // trade that fails its own 2R rule.
  const structural = side === 'long' ? nextSwingAbove(htf, entry) : nextSwingBelow(htf, entry)
  const minTarget = targetForR({ side, entry, stop, r: config.tpMinR })
  const maxTarget = targetForR({ side, entry, stop, r: config.tpMaxR })
  if (minTarget === null) {
    return reject(`no price pays ${config.tpMinR}R on this stop`, { ...context, zone })
  }

  let takeProfit = structural ? structural.price : minTarget
  takeProfit = side === 'long' ? Math.max(takeProfit, minTarget) : Math.min(takeProfit, minTarget)
  if (maxTarget !== null) {
    takeProfit = side === 'long' ? Math.min(takeProfit, maxTarget) : Math.max(takeProfit, maxTarget)
  }

  const rr = riskRewardRatio({ side, entry, stop, takeProfit })
  if (rr === null || rr < config.minRR) {
    return reject(`reward/risk ${rr === null ? 'undefined' : rr.toFixed(2)} is below ${config.minRR}`, {
      ...context,
      zone,
      takeProfit,
    })
  }

  return {
    action: 'open',
    side,
    entry,
    stop,
    takeProfit,
    rr,
    reason: `${htf.bias} trend, ${confirmation} at ${wantedZoneType} ${zone.low.toFixed(0)}-${zone.high.toFixed(0)} (${zone.touches} touch${zone.touches > 1 ? 'es' : ''})`,
    context: { ...context, zone, confirmation, patterns: signal.patterns, structuralTarget: structural?.price ?? null },
  }
}

export const DEFAULT_MANAGEMENT = {
  breakevenAtR: 1.0,
  trailStartAtR: 1.5,
  trailAtrBuffer: 0.5,
  closeOnHtfFlip: true,
}

/**
 * Manage a position that is already open.
 *
 * The one invariant: a stop is only ever moved in the direction of profit.
 * Widening a stop turns a measured 1% risk into an unmeasured one, and it is
 * the single change most likely to turn a losing system into a ruinous one — so
 * it is refused here rather than left to the caller to remember.
 */
export const manageOpen = ({ position, ltfCandles, htfCandles, settings = {} }) => {
  const config = { ...DEFAULT_MANAGEMENT, ...DEFAULT_STRATEGY, ...settings }
  const candle = ltfCandles.at(-1)
  if (!candle) return { action: 'hold', reason: 'no candle' }

  const price = candle.close
  const { side, entry } = position
  // The field is `stopLoss` everywhere a position comes from — the paper store,
  // `normaliseTrade` for LN Markets, and the published state. This read used to
  // be `position.stop`, which is undefined on every one of them, so `improves`
  // below compared against undefined, was always false, and NO stop was ever
  // moved. Measured on 233 days: 35 trades reached 1R and zero were moved to
  // breakeven. `stop` is still accepted so a caller passing a plan works too.
  const stop = position.stopLoss ?? position.stop
  if (!(stop > 0)) return { action: 'hold', reason: 'position has no stop to manage' }
  const initialRisk = Math.abs(entry - (position.initialStop ?? stop))
  if (!(initialRisk > 0)) return { action: 'hold', reason: 'position has no measurable risk' }

  const progressR = (side === 'long' ? price - entry : entry - price) / initialRisk

  if (config.closeOnHtfFlip && Array.isArray(htfCandles) && htfCandles.length >= config.minHtfCandles) {
    const htf = marketStructure(htfCandles, { lookback: config.htfLookback })
    const flipped =
      (side === 'long' && (htf.bias === 'down' || htf.event === 'CHoCH_DOWN')) ||
      (side === 'short' && (htf.bias === 'up' || htf.event === 'CHoCH_UP'))
    if (flipped) {
      return { action: 'close', reason: `higher timeframe turned against the position (${htf.bias}/${htf.event ?? 'no event'})` }
    }
  }

  const ltfAtr = lastDefined(atr(ltfCandles, 14))
  let proposed = null
  let reason = null

  if (progressR >= config.trailStartAtR && ltfAtr) {
    const structure = marketStructure(ltfCandles, { lookback: config.ltfLookback })
    const anchor = side === 'long' ? structure.lastLow : structure.lastHigh
    if (anchor) {
      proposed =
        side === 'long'
          ? anchor.price - ltfAtr * config.trailAtrBuffer
          : anchor.price + ltfAtr * config.trailAtrBuffer
      reason = `trailing behind the last swing ${side === 'long' ? 'low' : 'high'} at ${anchor.price.toFixed(0)} (${progressR.toFixed(2)}R)`
    }
  } else if (progressR >= config.breakevenAtR) {
    proposed = entry
    reason = `moving to breakeven at ${progressR.toFixed(2)}R`
  }

  if (proposed === null) return { action: 'hold', reason: `${progressR.toFixed(2)}R, nothing to do` }

  const improves = side === 'long' ? proposed > stop : proposed < stop
  if (!improves) return { action: 'hold', reason: `${progressR.toFixed(2)}R, stop already at or beyond ${proposed.toFixed(0)}` }

  // Never place the stop the wrong side of price — that is an instant close.
  const wouldTriggerNow = side === 'long' ? proposed >= price : proposed <= price
  if (wouldTriggerNow) return { action: 'hold', reason: 'proposed stop is already through price' }

  return { action: 'move_stop', stop: proposed, progressR, reason }
}
