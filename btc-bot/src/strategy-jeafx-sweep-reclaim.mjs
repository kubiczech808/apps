// JeaFx-inspired sweep & reclaim model.
//
// This lab strategy does not treat a liquidity sweep as an entry by itself.
// It waits for three things in order:
//   1. higher-timeframe direction,
//   2. a recent sweep of the opposite-side liquidity on the entry timeframe,
//   3. a close back through that liquidity level plus candle momentum.
//
// In plain chart language: let price take stops, prove that the break failed,
// then enter only if the next closed candle has enough intent.

import {
  atr,
  candleSignal,
  findSwings,
  lastDefined,
  marketStructure,
  nextSwingAbove,
  nextSwingBelow,
} from './priceaction.mjs'
import { riskRewardRatio, targetForR } from './risk.mjs'
import { DEFAULT_MANAGEMENT, manageOpen as managePriceActionOpen } from './strategy.mjs'

export const DEFAULT_SWEEP_RECLAIM = {
  htfLookback: 2,
  ltfLookback: 2,
  minHtfCandles: 90,
  minLtfCandles: 120,
  sweepLookbackBars: 48,
  reclaimMaxBars: 6,
  triggerMaxBarsAfterReclaim: 4,
  triggerKinds: ['engulfing'],
  requireTrigger: true,
  minTriggerRangeAtr: 0.35,
  stopAtrBuffer: 0.5,
  tpMinR: 2.0,
  tpMaxR: 5.0,
  minRR: 2.0,
  atrPctMin: 0.2,
  atrPctMax: 6.0,
}

export const DEFAULT_BACKTEST_SETTINGS = DEFAULT_SWEEP_RECLAIM

const reject = (reason, context = {}) => ({ action: 'none', reason, context })

const previousSwings = (swings) => {
  const previous = new Map()
  let lastLow = null
  let lastHigh = null
  for (const swing of swings) {
    previous.set(swing, swing.kind === 'low' ? lastLow : lastHigh)
    if (swing.kind === 'low') lastLow = swing
    else lastHigh = swing
  }
  return previous
}

const reclaimCandle = ({ candles, side, sweep, level, maxBars }) => {
  const end = Math.min(candles.length - 1, sweep.index + maxBars)
  for (let index = sweep.index; index <= end; index += 1) {
    const candle = candles[index]
    if (side === 'long' && candle.close > level) return { ...candle, index }
    if (side === 'short' && candle.close < level) return { ...candle, index }
  }
  return null
}

export const findSweepReclaim = ({ candles, side, settings = {} }) => {
  const config = { ...DEFAULT_SWEEP_RECLAIM, ...settings }
  const swings = findSwings(candles, config.ltfLookback)
  const previous = previousSwings(swings)
  const kind = side === 'long' ? 'low' : 'high'
  const latestIndex = candles.length - 1
  const earliestIndex = Math.max(0, latestIndex - config.sweepLookbackBars)

  const candidates = swings
    .filter((swing) => swing.kind === kind && swing.index >= earliestIndex)
    .map((swing) => {
      const prior = previous.get(swing)
      if (!prior) return null
      const swept = side === 'long' ? swing.price < prior.price : swing.price > prior.price
      if (!swept) return null
      const reclaim = reclaimCandle({
        candles,
        side,
        sweep: swing,
        level: prior.price,
        maxBars: config.reclaimMaxBars,
      })
      if (!reclaim) return null
      if (latestIndex - reclaim.index > config.triggerMaxBarsAfterReclaim) return null
      return { sweep: swing, previous: prior, liquidityLevel: prior.price, reclaim }
    })
    .filter(Boolean)

  return candidates.at(-1) ?? null
}

export const evaluateEntry = ({ htfCandles, ltfCandles, settings = {} }) => {
  const config = { ...DEFAULT_SWEEP_RECLAIM, ...settings }
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
  const price = trigger?.close ?? null
  const context = {
    htfBias: htf.bias,
    htfEvent: htf.event,
    ltfBias: ltf.bias,
    ltfEvent: ltf.event,
    price,
    ltfAtr,
    atrPct: ltfAtr && price ? (ltfAtr / price) * 100 : null,
  }

  if (!ltfAtr || !price) return reject('ATR is not defined yet', context)
  if (htf.bias === 'range') return reject('higher timeframe has no trend — ranging', context)
  if (htf.bias === 'up' && htf.event === 'CHoCH_DOWN') return reject('higher timeframe just broke down', context)
  if (htf.bias === 'down' && htf.event === 'CHoCH_UP') return reject('higher timeframe just broke up', context)

  const atrPct = (ltfAtr / price) * 100
  if (atrPct < config.atrPctMin) return reject(`too quiet: ATR ${atrPct.toFixed(2)}% < ${config.atrPctMin}%`, context)
  if (atrPct > config.atrPctMax) return reject(`too volatile: ATR ${atrPct.toFixed(2)}% > ${config.atrPctMax}%`, context)

  const side = htf.bias === 'up' ? 'long' : 'short'
  const setup = findSweepReclaim({ candles: ltfCandles, side, settings: config })
  if (!setup) {
    return reject(`no recent ${side === 'long' ? 'sell-side' : 'buy-side'} liquidity sweep and reclaim`, context)
  }

  const signal = candleSignal(ltfCandles, ltfCandles.length - 1, { atrValue: ltfAtr })
  const confirmation = side === 'long' ? signal.bullish : signal.bearish
  const triggerRange = trigger.high - trigger.low
  if (config.requireTrigger) {
    if (!confirmation) {
      return reject(`no ${side === 'long' ? 'bullish' : 'bearish'} momentum trigger after reclaim`, {
        ...context,
        setup,
        patterns: signal.patterns,
      })
    }
    if (Array.isArray(config.triggerKinds) && !config.triggerKinds.some((kind) => confirmation.endsWith(kind))) {
      return reject(`trigger is ${confirmation}, and only ${config.triggerKinds.join('/')} counts here`, {
        ...context,
        setup,
        patterns: signal.patterns,
      })
    }
  }
  if (triggerRange < ltfAtr * config.minTriggerRangeAtr) {
    return reject(`trigger range is ${(triggerRange / ltfAtr).toFixed(2)} ATR after reclaim`, {
      ...context,
      setup,
      confirmation,
      patterns: signal.patterns,
    })
  }

  const stop =
    side === 'long'
      ? setup.sweep.price - ltfAtr * config.stopAtrBuffer
      : setup.sweep.price + ltfAtr * config.stopAtrBuffer
  if (!(Math.abs(price - stop) > 0)) return reject('degenerate stop distance', { ...context, setup })

  const structural = side === 'long' ? nextSwingAbove(htf, price) : nextSwingBelow(htf, price)
  const minTarget = targetForR({ side, entry: price, stop, r: config.tpMinR })
  const maxTarget = targetForR({ side, entry: price, stop, r: config.tpMaxR })
  if (minTarget === null) return reject(`no price pays ${config.tpMinR}R on this stop`, { ...context, setup })

  let takeProfit = structural ? structural.price : minTarget
  takeProfit = side === 'long' ? Math.max(takeProfit, minTarget) : Math.min(takeProfit, minTarget)
  if (maxTarget !== null) {
    takeProfit = side === 'long' ? Math.min(takeProfit, maxTarget) : Math.max(takeProfit, maxTarget)
  }

  const rr = riskRewardRatio({ side, entry: price, stop, takeProfit })
  if (rr === null || rr < config.minRR) {
    return reject(`reward/risk ${rr === null ? 'undefined' : rr.toFixed(2)} is below ${config.minRR}`, {
      ...context,
      setup,
      takeProfit,
    })
  }

  return {
    action: 'open',
    side,
    entry: price,
    stop,
    takeProfit,
    rr,
    reason:
      `${htf.bias} trend, ${side === 'long' ? 'sell-side' : 'buy-side'} sweep/reclaim ` +
      `${Math.round(setup.liquidityLevel)} with ${confirmation ?? 'no trigger required'}`,
    context: {
      ...context,
      setup,
      confirmation,
      patterns: signal.patterns,
      structuralTarget: structural?.price ?? null,
    },
  }
}

export const manageOpen = ({ position, ltfCandles, htfCandles, settings = {} }) =>
  managePriceActionOpen({
    position,
    ltfCandles,
    htfCandles,
    settings: { ...DEFAULT_MANAGEMENT, ...DEFAULT_SWEEP_RECLAIM, ...settings },
  })
