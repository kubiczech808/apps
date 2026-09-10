// JeaFx-inspired higher-timeframe supply/demand swing model.
//
// This is a lab strategy, not the live default. It keeps the current strategy's
// deterministic S/D engine, but moves the decision one timeframe higher:
// daily structure for direction, 4h for the point of interest and trigger.
// The aim is not prettier chart reading; it is lower fee share of risk through
// fewer, wider, cleaner trades.

import {
  DEFAULT_MANAGEMENT,
  DEFAULT_STRATEGY,
  evaluateEntry as evaluatePriceActionEntry,
  manageOpen as managePriceActionOpen,
} from './strategy.mjs'

export const DEFAULT_JEAFX_SWING = {
  ...DEFAULT_STRATEGY,
  // Daily structure changes more slowly, so ask for more complete candles
  // before trusting the bias. 4h entries likewise need enough local structure
  // for zones and candle momentum to mean something.
  minHtfCandles: 90,
  minLtfCandles: 120,
  // This model should be selective. A first measured variant favours decisive
  // momentum over pin-bar rejection, because the existing diagnosis found the
  // rejection half weak.
  triggerKinds: ['engulfing'],
  requireTrigger: true,
  // JeaFx-style POIs care about liquidity and imbalance. The older imbalance
  // implementation did not improve the 1h strategy; here it is tested where
  // the idea belongs: higher timeframe zones with wider stops.
  requireSweep: true,
  requireImbalance: true,
  // Higher timeframe entries can tolerate wider stops while reducing friction.
  stopAtrBuffer: 0.75,
  zoneMaxDistanceAtr: 0.75,
  minRR: 2.0,
  tpMinR: 2.0,
  tpMaxR: 4.0,
  atrPctMin: 0.25,
  atrPctMax: 6.0,
}

export const DEFAULT_BACKTEST_SETTINGS = DEFAULT_JEAFX_SWING

export const evaluateEntry = ({ htfCandles, ltfCandles, settings = {} }) =>
  evaluatePriceActionEntry({
    htfCandles,
    ltfCandles,
    settings: { ...DEFAULT_JEAFX_SWING, ...settings },
  })

export const manageOpen = ({ position, ltfCandles, htfCandles, settings = {} }) =>
  managePriceActionOpen({
    position,
    ltfCandles,
    htfCandles,
    settings: { ...DEFAULT_MANAGEMENT, ...DEFAULT_JEAFX_SWING, ...settings },
  })
