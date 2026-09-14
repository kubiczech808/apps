import * as momentum from './strategy-momentum.mjs'
import * as priceAction from './strategy.mjs'
import * as priceActionStructure from './strategy-price-action-structure.mjs'

export const LEGACY_PRICE_ACTION_ID = 'price-action-v0'
export const ACTIVE_STRATEGY_ID = 'momentum-breakout-v1'
export const PRICE_ACTION_STRUCTURE_ID = priceActionStructure.PRICE_ACTION_STRUCTURE_ID

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
  [PRICE_ACTION_STRUCTURE_ID]: {
    id: PRICE_ACTION_STRUCTURE_ID,
    name: 'Price Action Structure',
    module: priceActionStructure,
    timeframes: { htfHours: 4, ltfHours: 1 },
    settings: { ...priceActionStructure.DEFAULT_PRICE_ACTION_STRUCTURE },
  },
}

export const strategyConfig = (id = ACTIVE_STRATEGY_ID) => STRATEGIES[id] ?? STRATEGIES[ACTIVE_STRATEGY_ID]
