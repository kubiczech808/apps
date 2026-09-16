// Price precision shared by market data, price-action profiles and execution.
// One representation prevents a displayed level from differing from the level
// used for R/R, brackets or a backtest fill.

export const PRICE_DECIMALS = 4
export const PRICE_TICK = 10 ** -PRICE_DECIMALS

const scale = 10 ** PRICE_DECIMALS
const floatingAllowance = (value) => Number.EPSILON * Math.max(1, Math.abs(value)) * 16
const numericPrice = (value) => value === null || value === '' ? null : Number(value)

export const roundPrice = (value) =>
  Number.isFinite(numericPrice(value)) ? Math.round(numericPrice(value) * scale) / scale : value

// Stops and targets are rounded away from entry, preserving the configured
// risk and minimum reward/risk after their price becomes executable.
export const floorPrice = (value) =>
  Number.isFinite(numericPrice(value))
    ? Math.floor((numericPrice(value) + floatingAllowance(numericPrice(value))) * scale) / scale
    : value

export const ceilPrice = (value) =>
  Number.isFinite(numericPrice(value))
    ? Math.ceil((numericPrice(value) - floatingAllowance(numericPrice(value))) * scale) / scale
    : value

export const normalizeCandlePrices = (candle) => ({
  ...candle,
  open: roundPrice(candle.open),
  high: roundPrice(candle.high),
  low: roundPrice(candle.low),
  close: roundPrice(candle.close),
})
