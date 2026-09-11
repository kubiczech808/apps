import * as momentum from './strategy-momentum.mjs'
import * as priceAction from './strategy.mjs'

export const LEGACY_PRICE_ACTION_ID = 'price-action-v0'
export const ACTIVE_STRATEGY_ID = 'momentum-breakout-v1'

export const STRATEGIES = {
  [LEGACY_PRICE_ACTION_ID]: {
    id: LEGACY_PRICE_ACTION_ID,
    name: 'BTC Price Action Swing',
    module: priceAction,
    timeframes: { htfHours: 4, ltfHours: 1 },
    settings: { ...priceAction.DEFAULT_STRATEGY, ...priceAction.DEFAULT_MANAGEMENT },
  },
  [ACTIVE_STRATEGY_ID]: {
    id: ACTIVE_STRATEGY_ID,
    name: 'BTC Leveraged Momentum',
    module: momentum,
    timeframes: { htfHours: 24, ltfHours: 1 },
    settings: {
      ...momentum.DEFAULT_MOMENTUM,
      stopAtr: 1,
      allowShorts: false,
    },
  },
}

export const strategyConfig = (id = ACTIVE_STRATEGY_ID) => STRATEGIES[id] ?? STRATEGIES[ACTIVE_STRATEGY_ID]
