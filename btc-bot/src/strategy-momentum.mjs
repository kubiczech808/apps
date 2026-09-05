// Trend following: buy strength, hold it, let the stop end it.
//
// This exists because the price-action engine did not work and there is a
// reason to expect this one to. Time-series momentum is the most durable
// systematic anomaly there is — documented across dozens of markets and
// decades, and, unusually, it kept working after publication. The mechanism is
// under-reaction: information enters price gradually, so a market that has
// moved tends to keep moving.
//
// It is also structurally the opposite of what failed, which matters more than
// the citation:
//
//   the old one           this one
//   fades a move          joins a move
//   tight stop            wide stop, 2 ATR
//   precise timing        timing barely matters
//   many trades           few trades
//   pays fees often       pays carry for a long time
//
// That last line is why carry had to be modelled before this could be judged
// at all: a strategy holding for weeks lives or dies on funding, and one
// holding for hours barely notices it.
//
// What this will NOT do is win often. Trend following is right about a third of
// the time and makes its money from a fat right tail. A run of losses is the
// normal operation of the system, not evidence against it — which is exactly
// why the stop is the only exit that matters and why taking profit early is
// the classic way to destroy it.

import { atr, lastDefined } from './priceaction.mjs'
import { riskRewardRatio, targetForR } from './risk.mjs'

export const DEFAULT_MOMENTUM = {
  // Donchian breakout: enter when today closes beyond the extreme of this many
  // prior days. 20 is the long-standing default and is left alone deliberately
  // — every hour spent choosing it on this data is an hour spent overfitting.
  entryLookbackDays: 20,
  // Trailing exit channel. Shorter than the entry, so a position gives back
  // less than it took to get in.
  exitLookbackDays: 10,
  // Regime filter: only take longs above this moving average, shorts below it.
  // Breakouts against the major trend are where whipsaws live.
  regimeMaDays: 100,
  // Stop distance, in daily ATR. Wide on purpose: this strategy must survive
  // ordinary noise, and a stop inside the noise converts a winning system into
  // a losing one faster than any other single choice.
  stopAtr: 2.0,
  atrDays: 20,
  // A take profit is required by the account's own rule that no position is
  // ever unbracketed. For a trend system it is a BACKSTOP, not a target: set
  // far enough out that it almost never binds, because cutting the right tail
  // is how trend following is killed.
  takeProfitR: 15,
  // Whether to take the short side at all. Kept as a switch rather than a
  // decision because it is a real question for an asset with a long-run upward
  // drift: shorting it fights the drift, and the answer belongs in a
  // measurement, not in an opinion.
  allowShorts: true,
  minCandles: 140,
}

const reject = (reason, context = {}) => ({ action: 'none', reason, context })

const simpleMovingAverage = (candles, days) => {
  if (candles.length < days) return null
  const slice = candles.slice(-days)
  return slice.reduce((sum, candle) => sum + candle.close, 0) / days
}

/** Highest high / lowest low of the `days` candles BEFORE the last one. */
export const donchian = (candles, days) => {
  if (candles.length < days + 1) return null
  const window = candles.slice(-(days + 1), -1)
  return {
    high: Math.max(...window.map((candle) => candle.high)),
    low: Math.min(...window.map((candle) => candle.low)),
  }
}

/**
 * Decide whether to open.
 *
 * `htfCandles` must be DAILY. The breakout is read from the last closed daily
 * candle and the entry is priced at the latest close available, so a signal
 * cannot be acted on before the day that produced it has ended.
 */
export const evaluateEntry = ({ htfCandles, ltfCandles, settings = {} }) => {
  const config = { ...DEFAULT_MOMENTUM, ...settings }

  if (!Array.isArray(htfCandles) || htfCandles.length < config.minCandles) {
    return reject(`not enough daily candles (${htfCandles?.length ?? 0}/${config.minCandles})`)
  }

  const today = htfCandles.at(-1)
  const price = ltfCandles?.at(-1)?.close ?? today.close
  const channel = donchian(htfCandles, config.entryLookbackDays)
  const previousChannel = donchian(htfCandles.slice(0, -1), config.entryLookbackDays)
  const regime = simpleMovingAverage(htfCandles, config.regimeMaDays)
  const dailyAtr = lastDefined(atr(htfCandles, config.atrDays))

  const context = {
    price,
    dailyClose: today.close,
    channelHigh: channel?.high ?? null,
    channelLow: channel?.low ?? null,
    regimeMa: regime,
    dailyAtr,
  }

  if (!channel || !previousChannel || !regime || !dailyAtr) {
    return reject('indicators are not defined yet', context)
  }

  const brokeUp = today.close > channel.high
  const brokeDown = today.close < channel.low
  if (!brokeUp && !brokeDown) {
    return reject(
      `no breakout: ${Math.round(today.close)} is inside ${Math.round(channel.low)}-${Math.round(channel.high)}`,
      context
    )
  }

  // Only the day the breakout HAPPENS is tradeable. Without this the signal
  // stays true for as long as price holds above the old channel, and the bot
  // would re-enter the same trade every pass after any exit.
  const previousClose = htfCandles.at(-2).close
  const isFresh = brokeUp
    ? previousClose <= previousChannel.high
    : previousClose >= previousChannel.low
  if (!isFresh) return reject('breakout is not fresh — it happened on an earlier day', context)

  const side = brokeUp ? 'long' : 'short'
  if (side === 'short' && !config.allowShorts) {
    return reject('short breakouts are disabled for this portfolio', context)
  }
  if (side === 'long' && price < regime) {
    return reject(`long breakout below the ${config.regimeMaDays}-day average — wrong side of the trend`, context)
  }
  if (side === 'short' && price > regime) {
    return reject(`short breakout above the ${config.regimeMaDays}-day average — wrong side of the trend`, context)
  }

  const stop = side === 'long' ? price - dailyAtr * config.stopAtr : price + dailyAtr * config.stopAtr
  if (!(Math.abs(price - stop) > 0)) return reject('degenerate stop distance', context)

  const takeProfit = targetForR({ side, entry: price, stop, r: config.takeProfitR })
  if (takeProfit === null) {
    return reject(`no price pays ${config.takeProfitR}R on this stop`, context)
  }

  return {
    action: 'open',
    side,
    entry: price,
    stop,
    takeProfit,
    rr: riskRewardRatio({ side, entry: price, stop, takeProfit }),
    reason: `${side} on a fresh ${config.entryLookbackDays}-day breakout ${
      side === 'long' ? 'above' : 'below'
    } ${Math.round(side === 'long' ? channel.high : channel.low)}, with the ${config.regimeMaDays}-day trend`,
    context,
  }
}

/**
 * Manage an open position.
 *
 * One rule: trail the stop to the opposite Donchian channel, never against the
 * position. No breakeven move and no profit taking — both cut the right tail
 * this strategy is entirely made of.
 */
export const manageOpen = ({ position, ltfCandles, htfCandles, settings = {} }) => {
  const config = { ...DEFAULT_MOMENTUM, ...settings }
  const price = ltfCandles?.at(-1)?.close
  const stop = position.stopLoss ?? position.stop

  if (!Array.isArray(htfCandles) || htfCandles.length < config.exitLookbackDays + 2) {
    return { action: 'hold', reason: 'not enough history to trail' }
  }
  if (!(stop > 0) || !(price > 0)) return { action: 'hold', reason: 'position has no stop to manage' }

  const channel = donchian(htfCandles, config.exitLookbackDays)
  if (!channel) return { action: 'hold', reason: 'exit channel is not defined' }

  const proposed = position.side === 'long' ? channel.low : channel.high
  const improves = position.side === 'long' ? proposed > stop : proposed < stop
  if (!improves) return { action: 'hold', reason: `trail at ${Math.round(proposed)} is not beyond the stop` }

  const wouldTriggerNow = position.side === 'long' ? proposed >= price : proposed <= price
  if (wouldTriggerNow) return { action: 'hold', reason: 'the trailing stop is already through price' }

  return {
    action: 'move_stop',
    stop: proposed,
    reason: `trailing to the ${config.exitLookbackDays}-day channel at ${Math.round(proposed)}`,
  }
}
