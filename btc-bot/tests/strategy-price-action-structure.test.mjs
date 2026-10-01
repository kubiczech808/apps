import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activeSupplyDemandZones,
  alignOneHourStructureToFourHour,
  alternatingTrendPivots,
  aggregateHourlyTimeframeCandles,
  applyExternalTrendConfirmation,
  buildPriceActionMatrix,
  canReusePriceActionMatrix,
  canReuseExternalTrendReference,
  classifyExternalStructure,
  classifyStructure,
  evaluateTradeProfile,
  fetchFxCandles,
  fetchYahooCandles,
  fetchStooqCandles,
  PRICE_ACTION_ASSETS,
  PRICE_ACTION_MATRIX_SCHEMA,
  PRICE_ACTION_CHART_CANDLE_LIMITS,
  PRICE_ACTION_STRUCTURE_PROFILES,
  PRICE_ACTION_TIMEFRAMES,
  reviewOpenPosition,
} from '../src/strategy-price-action-structure.mjs'
import { EXTERNAL_PIVOT_SCHEMA, classifyExternalPivotPath } from '../src/external-trends.mjs'
import { candle, HOUR, START, zigzag } from './helpers.mjs'

test('price-action structure classifies trend from confirmed swings', () => {
  const up = classifyStructure(zigzag([100, 120, 112, 140, 130, 160], { steps: 8 }), { minCandles: 20 })
  assert.equal(up.trend, 'up')
  assert.equal(up.status, 'met')
  assert.match(up.reason, /HH/)
  assert.match(up.reason, /HL/)
  assert.equal(up.structure.high.label, 'HH')
  assert.equal(up.structure.low.label, 'HL')
  assert.ok(up.structure.high.previous.price < up.structure.high.current.price)
  assert.ok(up.structure.low.previous.price < up.structure.low.current.price)
  assert.ok(up.structure.recentSwings.length > 0)

  const down = classifyStructure(zigzag([160, 130, 140, 112, 120, 100], { steps: 8 }), { minCandles: 20 })
  assert.equal(down.trend, 'down')
  assert.equal(down.status, 'unmet')
  assert.match(down.reason, /LH/)
  assert.match(down.reason, /LL/)
  assert.equal(down.structure.high.label, 'LH')
  assert.equal(down.structure.low.label, 'LL')
  assert.ok(down.structure.high.previous.price > down.structure.high.current.price)
  assert.ok(down.structure.low.previous.price > down.structure.low.current.price)

  const flat = classifyStructure(zigzag([100, 110, 100, 110, 100, 110], { steps: 8 }), { minCandles: 20 })
  assert.equal(flat.trend, 'flat')
  assert.equal(flat.status, 'neutral')
})

test('alternative trend pivots walk backward only through the requested alternating labels', () => {
  const pivots = [
    { label: 'HL', kind: 'low', price: 150, time: 1 },
    { label: 'LH', kind: 'high', price: 140, time: 2 },
    { label: 'LL', kind: 'low', price: 130, time: 3 },
    { label: 'LH', kind: 'high', price: 120, time: 4 },
    { label: 'LL', kind: 'low', price: 100, time: 5 },
  ]

  assert.deepEqual(
    alternatingTrendPivots({ pivots, trend: 'down' }).map((pivot) => pivot.label),
    ['LH', 'LL', 'LH', 'LL']
  )
  assert.deepEqual(
    alternatingTrendPivots({
      pivots: [
        { label: 'HH', kind: 'high', price: 120, time: 1 },
        { label: 'HL', kind: 'low', price: 110, time: 2 },
        { label: 'HH', kind: 'high', price: 140, time: 3 },
        { label: 'LH', kind: 'high', price: 135, time: 4 },
      ],
      trend: 'up',
    }).map((pivot) => pivot.label),
    ['HH', 'HL', 'HH']
  )
  assert.deepEqual(alternatingTrendPivots({ pivots, trend: 'flat' }), [])
})

test('flat structure is formation-only and never publishes a planned entry', () => {
  const profile = evaluateTradeProfile({
    item: {
      trend: 'flat',
      reason: 'LH + HL',
      price: 103,
      structure: {
        high: { current: { price: 120 } },
        low: { current: { price: 100 } },
      },
      zones: {
        demand: { type: 'demand', low: 100, high: 105 },
        supply: { type: 'supply', low: 140, high: 145 },
      },
    },
    settings: { pullbackPct: 50, minRewardRisk: 2, riskPct: 1 },
  })

  assert.equal(profile.mode, 'formation')
  assert.equal(profile.formationState, 'forming')
  assert.equal(profile.side, null)
  assert.equal(profile.entry, null)
  assert.equal(profile.stop, null)
  assert.equal(profile.tp1, null)
  assert.equal(profile.tp2, null)
  assert.equal(profile.rewardRisk, null)
  assert.equal(profile.zone, null)
  assert.deepEqual(profile.zoneCandidates, [])
  assert.equal(profile.gates[0].status, 'neutral')
})

test('EMA regime is retained as a diagnostic and never vetoes external pivot structure', () => {
  const readyLong = {
    status: 'ready',
    mode: 'screening',
    side: 'long',
    gates: [{ id: 'trend', passed: true }],
  }
  const confirmed = applyExternalTrendConfirmation({
    profile: readyLong,
    externalTrend: { trend: 'up', source: 'Twelve Data' },
  })
  assert.equal(confirmed.status, 'ready')
  assert.deepEqual(confirmed.externalTrend, { trend: 'up', source: 'Twelve Data' })
  assert.equal(confirmed.gates.some((gate) => gate.id === 'external-trend'), false)

  for (const externalTrend of [{ trend: 'down' }, { trend: 'flat' }, null]) {
    const retained = applyExternalTrendConfirmation({ profile: readyLong, externalTrend })
    assert.equal(retained.status, 'ready')
    assert.equal(retained.externalTrend, externalTrend)
    assert.equal(retained.gates.some((gate) => gate.id === 'external-trend'), false)
  }
})

test('live PA structure comes only from externally confirmed pivots', () => {
  const result = classifyExternalStructure({
    candles: [
      candle(START + HOUR, 155, 160, 150, 155),
      candle(START + 2 * HOUR, 150, 152, 140, 145),
      candle(START + 3 * HOUR, 154, 155, 135, 154),
      candle(START + 4 * HOUR, 134, 140, 130, 129),
    ],
    externalTrend: { trend: 'up', source: 'Twelve Data', method: 'EMA 20/50' },
    externalPivots: {
      trend: 'down', source: 'Twelve Data', method: 'Potvrzené pivoty', timePeriod: 10,
      pivots: [
        { kind: 'high', price: 160, close: 155, time: START + HOUR },
        { kind: 'low', price: 140, close: 145, time: START + 2 * HOUR },
        { kind: 'high', price: 155, close: 154, time: START + 3 * HOUR },
        { kind: 'low', price: 130, close: 129, time: START + 4 * HOUR },
      ],
    },
  })

  assert.equal(result.trend, 'down')
  assert.equal(result.structure.high.label, 'LH')
  assert.equal(result.structure.low.label, 'LL')
  assert.equal(result.structure.source, 'external-confirmed-pivots')
  assert.equal(result.structure.activeRange.high.time, START + 3 * HOUR)
  assert.equal(result.structure.activeRange.low.time, START + 4 * HOUR)
  assert.equal(result.structure.activeRange.high.price, 155)
  assert.equal(result.structure.activeRange.high.close, 154)
  assert.equal(result.structure.activeRange.low.price, 130)
  assert.equal(result.structure.activeRange.low.close, 129)
  assert.ok(result.structure.activeRange.high.time < result.structure.activeRange.low.time)
  assert.equal(result.structure.chartPivots.length, 2)
  assert.deepEqual(
    result.structure.chartPivots.map((pivot) => [pivot.kind, pivot.label, pivot.source]),
    [
      ['high', 'LH', 'Twelve Data'],
      ['low', 'LL', 'Twelve Data'],
    ]
  )
})

test('a published external BoS range reaches the dashboard with its original HH and new LL', () => {
  const result = classifyExternalStructure({
    candles: [
      candle(START + 2 * HOUR, 156, 160, 155, 156),
      candle(START + 3 * HOUR, 161, 164, 159, 161),
      candle(START + 4 * HOUR, 160, 161, 156, 157),
      candle(START + 5 * HOUR, 157, 158, 153, 154),
      candle(START + 6 * HOUR, 154, 155, 152, 154),
      candle(START + 7 * HOUR, 154, 156, 153, 155),
    ],
    externalPivots: {
      trend: 'down',
      source: 'Twelve Data',
      method: 'Potvrzené pivoty',
      event: {
        type: 'BOS_DOWN',
        time: START + 6 * HOUR,
        close: 154,
        protectedPivot: { kind: 'low', label: 'HL', price: 155, time: START + 2 * HOUR },
      },
      activeRange: {
        high: { kind: 'high', label: 'HH', price: 164, close: 161, time: START + 3 * HOUR },
        low: { kind: 'low', label: 'LL', price: 152, close: 154, time: START + 6 * HOUR },
        source: 'external-break-of-structure',
      },
      chartPivots: [
        { kind: 'low', label: 'HL', price: 155, time: START + 2 * HOUR },
        { kind: 'high', label: 'HH', price: 164, time: START + 3 * HOUR },
        { kind: 'low', label: 'LL', price: 152, time: START + 6 * HOUR },
      ],
      pivots: [
        { kind: 'low', label: 'HL', price: 155, time: START + 2 * HOUR },
        { kind: 'high', label: 'HH', price: 164, time: START + 3 * HOUR },
      ],
    },
  })

  assert.equal(result.trend, 'down')
  assert.equal(result.event, 'BOS_DOWN')
  assert.equal(result.structure.activeRange.source, 'external-break-of-structure')
  assert.equal(result.structure.activeRange.high.label, 'HH')
  assert.equal(result.structure.activeRange.high.price, 164)
  assert.equal(result.structure.activeRange.low.label, 'LL')
  assert.equal(result.structure.activeRange.low.price, 152)
  assert.equal((result.structure.activeRange.high.price + result.structure.activeRange.low.price) / 2, 158)
  assert.deepEqual(result.structure.chartPivots.map((pivot) => pivot.label), ['HL', 'HH', 'LL'])
  assert.deepEqual(result.structure.contextPivots.map((pivot) => pivot.label), ['HL', 'HH'])
})

test('a closed-terminal extension reaches the dashboard chart before the next pivot window closes', () => {
  const pivots = [
    { kind: 'high', price: 120, close: 119, time: START },
    { kind: 'low', price: 100, close: 101, time: START + HOUR },
    { kind: 'high', price: 115, close: 114, time: START + 2 * HOUR },
    { kind: 'low', price: 90, close: 89, time: START + 3 * HOUR },
  ]
  const candles = [
    candle(START, 119, 120, 118, 119),
    candle(START + HOUR, 101, 102, 100, 101),
    candle(START + 2 * HOUR, 114, 115, 112, 114),
    candle(START + 3 * HOUR, 91, 92, 90, 89),
    candle(START + 4 * HOUR, 90, 92, 84, 91),
    candle(START + 5 * HOUR, 89, 90, 82, 85),
  ]
  const externalPivots = {
    ...classifyExternalPivotPath(pivots, { candles }),
    source: 'Twelve Data',
    timeframeId: '1h',
  }

  const result = classifyExternalStructure({ candles, externalPivots })

  assert.equal(externalPivots.activeRange.source, 'external-closed-terminal-extension')
  assert.equal(result.structure.activeRange.source, 'external-closed-terminal-extension')
  assert.deepEqual(
    result.structure.chartPivots.map((pivot) => [pivot.label, pivot.time, pivot.price]),
    [['LH', START + 2 * HOUR, 115], ['LL', START + 5 * HOUR, 82]]
  )
  assert.deepEqual(
    [result.structure.activeRange.high.price, result.structure.activeRange.low.price],
    [115, 82]
  )
})

test('the active chart wave retains the lowest closed wick from its LH through the current price', () => {
  const result = classifyExternalStructure({
    candles: [
      candle(START, 120, 120, 118, 119),
      candle(START + HOUR, 101, 102, 100, 101),
      candle(START + 2 * HOUR, 114, 115, 112, 114),
      candle(START + 3 * HOUR, 91, 92, 90, 89),
      // A later wick becomes the terminal of this same LH -> LL wave. It is
      // not a newly confirmed source pivot, but it is the real chart low.
      candle(START + 4 * HOUR, 90, 93, 82, 91),
    ],
    externalPivots: {
      trend: 'down',
      source: 'Twelve Data',
      timeframeId: '1h',
      activeRange: {
        high: { kind: 'high', label: 'LH', price: 115, close: 114, time: START + 2 * HOUR },
        low: { kind: 'low', label: 'LL', price: 90, close: 89, time: START + 3 * HOUR },
        source: 'external-confirmed-directional-wave',
      },
      chartPivots: [
        { kind: 'high', label: 'LH', price: 115, time: START + 2 * HOUR },
        { kind: 'low', label: 'LL', price: 90, time: START + 3 * HOUR },
      ],
      pivots: [
        { kind: 'high', label: 'LH', price: 115, close: 114, time: START + 2 * HOUR },
        { kind: 'low', label: 'LL', price: 90, close: 89, time: START + 3 * HOUR },
      ],
    },
  })

  assert.equal(result.structure.activeRange.high.price, 115)
  assert.equal(result.structure.activeRange.low.price, 82)
  assert.equal(result.structure.activeRange.low.time, START + 4 * HOUR)
  assert.deepEqual(
    result.structure.chartPivots.map((pivot) => [pivot.label, pivot.time, pivot.price]),
    [['LH', START + 2 * HOUR, 115], ['LL', START + 4 * HOUR, 82]]
  )
})

test('every production asset and timeframe scans its active wave through the current closed candle', () => {
  for (const [assetIndex, asset] of PRICE_ACTION_ASSETS.entries()) {
    for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
      const period = timeframe.hours * HOUR
      const up = (assetIndex + timeframe.hours) % 2 === 0
      const activeRange = up
        ? {
            high: { kind: 'high', label: 'HH', price: 120, close: 119, time: START + period },
            low: { kind: 'low', label: 'HL', price: 100, close: 101, time: START },
          }
        : {
            high: { kind: 'high', label: 'LH', price: 120, close: 119, time: START },
            low: { kind: 'low', label: 'LL', price: 100, close: 99, time: START + period },
          }
      const candles = up
        ? [
            candle(START, 101, 102, 100, 101),
            candle(START + period, 119, 120, 118, 119),
            candle(START + 2 * period, 121, 130, 120, 125),
          ]
        : [
            candle(START, 119, 120, 118, 119),
            candle(START + period, 101, 102, 100, 99),
            candle(START + 2 * period, 99, 101, 90, 94),
          ]
      const result = classifyExternalStructure({
        candles,
        externalPivots: {
          trend: up ? 'up' : 'down',
          source: 'test',
          timeframeId: timeframe.id,
          activeRange: { ...activeRange, source: 'external-confirmed-directional-wave' },
          chartPivots: up
            ? [activeRange.low, activeRange.high]
            : [activeRange.high, activeRange.low],
          pivots: up
            ? [activeRange.low, activeRange.high]
            : [activeRange.high, activeRange.low],
        },
      })
      const terminal = up ? result.structure.activeRange.high : result.structure.activeRange.low

      assert.equal(terminal.time, START + 2 * period, `${asset.symbol} ${timeframe.id}`)
      assert.equal(terminal.price, up ? 130 : 90, `${asset.symbol} ${timeframe.id}`)
      assert.ok(result.structure.activeRange.high.price > result.structure.activeRange.low.price, `${asset.symbol} ${timeframe.id}`)
    }
  }
})

test('externally confirmed pivot anchors use the actual extrema of the displayed chart wave', () => {
  const result = classifyExternalStructure({
    candles: [
      candle(START, 160, 160.3, 158.5, 159.1),
      candle(START + HOUR, 159.1, 163.9, 158.8, 162.8),
      candle(START + 2 * HOUR, 162.8, 163.7, 158.7, 159.2),
      candle(START + 3 * HOUR, 159.2, 160.1, 152.881, 153.444),
      candle(START + 4 * HOUR, 153.444, 154.2, 152.93, 153.529),
    ],
    externalPivots: {
      trend: 'down',
      source: 'Twelve Data',
      method: 'Potvrzené pivoty',
      event: { type: 'BOS_DOWN', time: START + 2 * HOUR, close: 159.2 },
      activeRange: {
        high: { kind: 'high', label: 'HH', price: 164.0881, close: 163.6005, time: START + HOUR },
        low: { kind: 'low', label: 'LL', price: 152.3795, close: 154.9473, time: START + 4 * HOUR },
        source: 'external-break-of-structure',
      },
      chartPivots: [
        { kind: 'low', label: 'HL', price: 158, time: START },
        { kind: 'high', label: 'HH', price: 164.0881, time: START + HOUR },
        { kind: 'low', label: 'LL', price: 152.3795, time: START + 4 * HOUR },
      ],
      pivots: [
        { kind: 'low', label: 'HL', price: 158, time: START },
        { kind: 'high', label: 'HH', price: 164.0881, time: START + HOUR },
        { kind: 'low', label: 'LL', price: 152.3795, time: START + 4 * HOUR },
      ],
    },
  })

  assert.equal(result.trend, 'down')
  assert.equal(result.event, 'BOS_DOWN')
  assert.equal(result.structure.activeRange.high.price, 163.9)
  assert.equal(result.structure.activeRange.low.price, 152.881)
  assert.equal(result.structure.activeRange.low.time, START + 3 * HOUR)
  assert.equal((result.structure.activeRange.high.price + result.structure.activeRange.low.price) / 2, 158.3905)
  assert.deepEqual(result.structure.chartPivots.map((pivot) => [pivot.label, pivot.time, pivot.price]), [
    ['HL', START, 158.5],
    ['HH', START + HOUR, 163.9],
    ['LL', START + 3 * HOUR, 152.881],
  ])
  assert.deepEqual(result.structure.contextPivots.map((pivot) => [pivot.label, pivot.time, pivot.price]), [
    ['HL', START, 158.5],
    ['HH', START + HOUR, 163.9],
  ])
})

test('an omitted historical source pivot cannot project onto a later unrelated chart wick', () => {
  const fourHours = 4 * HOUR
  const result = classifyExternalStructure({
    candles: [
      candle(START, 100, 101, 99, 100),
      candle(START + fourHours, 120, 150, 119, 121),
      candle(START + 2 * fourHours, 81, 82, 79, 80),
    ],
    externalPivots: {
      trend: 'down',
      source: 'Twelve Data',
      timeframeId: '4h',
      activeRange: {
        high: { kind: 'high', label: 'HH', price: 100, close: 99, time: START },
        low: { kind: 'low', label: 'LL', price: 80, close: 80, time: START + 2 * fourHours },
        source: 'external-break-of-structure',
      },
      // The older HH is deliberately absent, as happens after pivot audit
      // history is trimmed while a BoS range still retains its anchor.
      pivots: [{ kind: 'low', label: 'LL', price: 80, close: 80, time: START + 2 * fourHours }],
      chartPivots: [
        { kind: 'high', label: 'HH', price: 100, time: START },
        { kind: 'low', label: 'LL', price: 80, time: START + 2 * fourHours },
      ],
    },
  })

  assert.equal(result.structure.activeRange.high.price, 101)
  assert.equal(result.structure.activeRange.high.time, START)
  assert.notEqual(result.structure.activeRange.high.price, 150)
  assert.deepEqual(result.structure.chartPivots.map((pivot) => [pivot.label, pivot.time, pivot.price]), [
    ['HH', START, 101],
    ['LL', START + 2 * fourHours, 79],
  ])
})

test('projected external audit pivots remain chronological across adjacent source segments', () => {
  const fourHours = 4 * HOUR
  const result = classifyExternalStructure({
    candles: [
      candle(START, 95, 100, 90, 95),
      // These are deliberately extreme, but belong to neighbouring source
      // segments rather than the matching low/high pivot.
      candle(START + HOUR, 100, 200, 95, 100),
      candle(START + 3 * HOUR, 100, 105, 50, 101),
      candle(START + fourHours, 120, 130, 100, 121),
      candle(START + 2 * fourHours, 81, 82, 40, 80),
    ],
    externalPivots: {
      trend: 'down',
      source: 'Twelve Data',
      timeframeId: '4h',
      activeRange: {
        high: { kind: 'high', label: 'LH', price: 125, close: 121, time: START + fourHours },
        low: { kind: 'low', label: 'LL', price: 80, close: 80, time: START + 2 * fourHours },
        source: 'external-confirmed-directional-wave',
      },
      pivots: [
        { kind: 'low', label: 'LL', price: 90, close: 95, time: START },
        { kind: 'high', label: 'LH', price: 125, close: 121, time: START + fourHours },
        { kind: 'low', label: 'LL', price: 80, close: 80, time: START + 2 * fourHours },
      ],
      chartPivots: [
        { kind: 'low', label: 'LL', price: 90, time: START },
        { kind: 'high', label: 'LH', price: 125, time: START + fourHours },
        { kind: 'low', label: 'LL', price: 80, time: START + 2 * fourHours },
      ],
    },
  })

  const line = result.structure.chartPivots
  assert.deepEqual(line.map((pivot) => pivot.time), [START, START + fourHours, START + 2 * fourHours])
  assert.ok(line.every((pivot, index) => index === 0 || pivot.time > line[index - 1].time))
  assert.deepEqual(line.map((pivot) => pivot.label), ['LL', 'LH', 'LL'])
})

test('external active range does not combine an unpaired newer pivot with an older leg', () => {
  const result = classifyExternalStructure({
    externalPivots: {
      trend: 'down', source: 'Twelve Data',
      pivots: [
        { kind: 'high', price: 170, time: START },
        { kind: 'low', price: 150, time: START + HOUR },
        { kind: 'high', price: 160, time: START + 2 * HOUR },
        { kind: 'low', price: 140, time: START + 3 * HOUR },
        { kind: 'high', price: 155, time: START + 4 * HOUR },
      ],
    },
  })

  assert.equal(result.trend, 'down')
  assert.equal(result.structureConfirmed, true)
  assert.equal(result.structure.activeRange.high.price, 160)
  assert.equal(result.structure.activeRange.low.price, 140)
  assert.ok(result.structure.activeRange.high.time < result.structure.activeRange.low.time)
  assert.deepEqual(result.structure.chartPivots.map((pivot) => pivot.label), ['LH', 'LL'])
})

test('an available Twelve Data key immediately replaces a cached missing-key result', () => {
  const previous = {
    hourBucket: 100,
    pivotSchemaVersion: EXTERNAL_PIVOT_SCHEMA,
    failures: ['Twelve Data: TWELVE_DATA_API_KEY není nastaven'],
  }

  assert.equal(canReuseExternalTrendReference({ previous, hourBucket: 100, apiKey: 'new-key' }), false)
  assert.equal(canReuseExternalTrendReference({ previous, hourBucket: 100, apiKey: '' }), true)
  assert.equal(canReuseExternalTrendReference({ previous, hourBucket: 101, apiKey: 'new-key' }), false)

  const rateLimited = { hourBucket: 100, pivotSchemaVersion: EXTERNAL_PIVOT_SCHEMA, failures: ['Twelve Data: Twelve Data HTTP 429'] }
  assert.equal(canReuseExternalTrendReference({ previous: rateLimited, hourBucket: 100, apiKey: 'new-key' }), true)
  assert.equal(canReuseExternalTrendReference({ previous: rateLimited, hourBucket: 101, apiKey: 'new-key' }), false)
  assert.equal(canReuseExternalTrendReference({ previous: { hourBucket: 100, pivotSchemaVersion: EXTERNAL_PIVOT_SCHEMA - 1, failures: [] }, hourBucket: 100, apiKey: 'new-key' }), false)
})

test('a fresh matrix does not mask an FX key that has just become available', () => {
  const matrix = {
    schemaVersion: PRICE_ACTION_MATRIX_SCHEMA,
    generatedAt: new Date(START).toISOString(),
    externalTrends: {
      hourBucket: Math.floor(START / HOUR),
      failures: ['Twelve Data: TWELVE_DATA_API_KEY není nastaven'],
    },
    assets: PRICE_ACTION_ASSETS.map((asset) => ({
      ...asset,
      trends: Object.fromEntries(PRICE_ACTION_TIMEFRAMES.map((timeframe) => [timeframe.id, {
        structure: {}, chartCandles: [], tradeProfile: { zoneCandidates: [] },
      }])),
    })),
  }

  assert.equal(canReusePriceActionMatrix({
    matrix,
    now: START + 60_000,
    refreshMinutes: 15,
    externalTrendEnabled: true,
    twelveDataApiKey: 'new-key',
  }), false)
})

test('a close below a mature flat range publishes a non-executable down bias and an alternating chart line', () => {
  const range = zigzag([100, 120, 110, 118, 111, 117], { steps: 8 })
  const broken = [
    ...range,
    candle(range.at(-1).time + HOUR, 117, 118, 100, 105),
  ]
  const result = classifyStructure(broken, {
    lookback: 2,
    minCandles: 20,
    includeZones: false,
    includeChartCandles: false,
  })

  assert.equal(result.trend, 'down')
  assert.equal(result.event, 'RANGE_BREAK_DOWN')
  assert.equal(result.structureConfirmed, false)
  assert.match(result.reason, /čeká se na LH \+ LL/)
  const pivots = result.structure.chartPivots
  assert.equal(pivots.at(-1).kind, 'low')
  assert.equal(pivots.at(-1).label, 'LL')
  assert.equal(pivots.at(-1).price, 100)
  assert.ok(pivots.every((pivot, index) => index === 0
    || (pivot.time > pivots[index - 1].time && pivot.kind !== pivots[index - 1].kind)))
  assert.ok(!pivots.some((pivot) => pivot.candleIndex === result.structure.low.current.candleIndex))

  const profile = evaluateTradeProfile({
    item: result,
    settings: { pullbackPct: 50, minRewardRisk: 2, riskPct: 1 },
  })
  assert.equal(profile.mode, 'formation')
  assert.equal(profile.formationState, 'awaiting-confirmation')
  assert.equal(profile.side, null)
})

test('Stooq CSV parser accepts daily and intraday historical rows through the fetch wrapper', async () => {
  const csv = [
    'Date,Time,Open,High,Low,Close,Volume',
    '2026-09-10,10:00:00,1.10,1.12,1.09,1.11,0',
    '2026-09-10,11:00:00,1.11,1.13,1.10,1.12,0',
  ].join('\n')
  const fetchImpl = async () => ({
    ok: true,
    text: async () => csv,
  })

  const candles = await fetchStooqCandles({ symbol: 'eurusd', fetchImpl, now: START })
  assert.equal(candles.length, 2)
  assert.equal(candles[0].open, 1.1)
  assert.equal(candles[1].close, 1.12)
})

test('Yahoo candle wrapper drops zero-valued FX gap rows', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      chart: {
        result: [{
          timestamp: [START / 1000, (START + HOUR) / 1000],
          indicators: { quote: [{
            open: [0, 1.10],
            high: [0, 1.12],
            low: [0, 1.09],
            close: [0, 1.11],
            volume: [0, 0],
          }] },
        }],
      },
    }),
  })

  const candles = await fetchYahooCandles({ symbol: 'EURUSD=X', fetchImpl })
  assert.equal(candles.length, 1)
  assert.equal(candles[0].close, 1.11)
})

test('Forex 1D and 4H candles are derived from the same hourly stream', () => {
  const hourly = Array.from({ length: 72 }, (_, index) =>
    candle(START + index * HOUR, 1 + index, 1.75 + index, 0.5 + index, 1.25 + index)
  )

  const oneHour = aggregateHourlyTimeframeCandles({ candles: hourly, timeframeId: '1h' })
  const fourHour = aggregateHourlyTimeframeCandles({ candles: hourly, timeframeId: '4h' })
  const oneDay = aggregateHourlyTimeframeCandles({ candles: hourly, timeframeId: '1d' })

  assert.equal(oneHour.candles.length, 72)
  assert.equal(fourHour.candles.length, 18)
  assert.equal(oneDay.candles.length, 3)
  assert.equal(oneDay.candles[0].time, START)
  assert.deepEqual(oneDay.candles[0], {
    time: START,
    open: 1,
    high: 24.75,
    low: 0.5,
    close: 24.25,
    volume: 24,
  })
  assert.deepEqual(oneDay.chartCandles, oneDay.candles)
})

test('a short Stooq intraday response falls through to Yahoo for the full zone horizon', async () => {
  const now = Date.UTC(2026, 8, 20)
  const fetchImpl = async (url) => {
    if (String(url).includes('stooq.com')) {
      return {
        ok: true,
        text: async () => [
          'Date,Time,Open,High,Low,Close,Volume',
          '2026-09-19,10:00:00,0.7100,0.7110,0.7090,0.7105,0',
          '2026-09-19,11:00:00,0.7105,0.7115,0.7095,0.7110,0',
        ].join('\n'),
      }
    }
    return {
      ok: true,
      json: async () => ({
        chart: {
          result: [{
            timestamp: [Math.round((now - 121 * 24 * HOUR) / 1000), Math.round(now / 1000)],
            indicators: {
              quote: [{
                open: [0.7, 0.71], high: [0.71, 0.72], low: [0.69, 0.7], close: [0.705, 0.715], volume: [0, 0],
              }],
            },
          }],
        },
      }),
    }
  }

  const result = await fetchFxCandles({
    asset: PRICE_ACTION_ASSETS.find((asset) => asset.symbol === 'AUDUSD'),
    timeframeId: '1h',
    requiredHistoryDays: 120,
    fetchImpl,
    now,
    logger: { warn() {} },
  })

  assert.equal(result.source, 'yahoo')
  assert.equal(result.candles.length, 2)
  assert.match(result.failures[0], /stooq returned only 0 calendar days; need 120/)
})

test('long FX hourly history uses Yahoo two-year data before the timing-out Stooq request', async () => {
  const now = Date.UTC(2026, 8, 25)
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    return {
      ok: true,
      json: async () => ({
        chart: {
          result: [{
            timestamp: [
              Math.round((now - 757 * 24 * HOUR) / 1000),
              Math.round(now / 1000),
            ],
            indicators: {
              quote: [{
                open: [0.7, 0.71], high: [0.71, 0.72], low: [0.69, 0.7], close: [0.705, 0.715], volume: [0, 0],
              }],
            },
          }],
        },
      }),
    }
  }

  const result = await fetchFxCandles({
    asset: PRICE_ACTION_ASSETS.find((asset) => asset.symbol === 'AUDUSD'),
    timeframeId: '1h',
    requiredHistoryDays: 730,
    hourlyLookbackDays: 760,
    fetchImpl,
    now,
    logger: { warn() {} },
  })

  assert.equal(result.source, 'yahoo')
  assert.equal(urls.length, 1)
  assert.match(urls[0], /range=2y/)
})

test('a successful Twelve Data batch keeps every FX chart populated when public mirrors are throttled', async () => {
  const now = START + 5_200 * HOUR
  const twelveValues = Array.from({ length: 5_000 }, (_, index) => {
    const price = 1 + index * 0.00001
    return {
      datetime: new Date(now - (4_999 - index) * HOUR).toISOString().replace('T', ' ').replace('.000Z', ''),
      open: String(price),
      high: String(price + 0.0002),
      low: String(price - 0.0002),
      close: String(price + 0.0001),
    }
  }).reverse()
  const fetchImpl = async (url) => {
    if (String(url).includes('api.twelvedata.com')) {
      return {
        ok: true,
        json: async () => Object.fromEntries(
          PRICE_ACTION_ASSETS
            .filter((asset) => asset.group === 'fx')
            .map((asset) => [asset.twelveSymbol, { values: twelveValues }])
        ),
      }
    }
    // Yahoo and Stooq failures reproduce the production incident. Binance is
    // unrelated here; BTC's supplied hourly data keeps that row independent.
    return { ok: false, status: 429 }
  }
  const btcHourly = Array.from({ length: 300 }, (_, index) =>
    candle(now - (299 - index) * HOUR, 80_000, 80_100, 79_900, 80_050)
  )

  const matrix = await buildPriceActionMatrix({
    btcHourly,
    fetchImpl,
    now,
    settings: { refreshMinutes: 0 },
    twelveDataApiKey: 'test-key',
    externalTrendEnabled: true,
    logger: { warn() {} },
  })

  assert.equal('hourly' in matrix.externalTrends, false, 'the large fallback payload must not be published twice')
  for (const asset of matrix.assets.filter((item) => item.group === 'fx')) {
    assert.match(asset.source, /Twelve Data/, `${asset.symbol} must use the successful external OHLC fallback`)
    for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
      assert.ok(asset.trends[timeframe.id].chartCandles.length > 0, `${asset.symbol} ${timeframe.id} chart must not be empty`)
    }
  }
})

test('wick-only extensions are not structural pivots until their candle closes beyond the prior wick', () => {
  const wickOnlyHighBreak = [
    candle(START, 95, 100, 92, 96),
    candle(START + 1 * HOUR, 96, 110, 94, 108),
    candle(START + 2 * HOUR, 108, 105, 96, 100),
    candle(START + 3 * HOUR, 100, 102, 90, 94),
    candle(START + 4 * HOUR, 94, 108, 95, 106),
    candle(START + 5 * HOUR, 106, 112, 101, 109),
    candle(START + 6 * HOUR, 109, 107, 98, 101),
    candle(START + 7 * HOUR, 101, 103, 93, 96),
    candle(START + 8 * HOUR, 96, 104, 95, 102),
  ]
  const highSweep = classifyStructure(wickOnlyHighBreak, { lookback: 1, minCandles: 8 })
  assert.ok(!highSweep.structure.recentSwings.some((swing) => swing.kind === 'high' && swing.price === 112))
  assert.ok(!highSweep.structure.chartPivots.some((swing) => swing.kind === 'high' && swing.price === 112))
  assert.equal(highSweep.trend, 'flat')

  const closeConfirmedHighBreak = wickOnlyHighBreak.map((item, index) =>
    index === 5 ? { ...item, close: 111 } : item
  )
  const highBreak = classifyStructure(closeConfirmedHighBreak, { lookback: 1, minCandles: 8 })
  assert.equal(highBreak.structure.high.current.price, 112)
  assert.equal(highBreak.structure.high.label, 'HH')

  const wickOnlyLowBreak = wickOnlyHighBreak.map((item, index) =>
    index === 7 ? { ...item, low: 88, close: 91 } : item
  )
  const lowSweep = classifyStructure(wickOnlyLowBreak, { lookback: 1, minCandles: 8 })
  assert.ok(!lowSweep.structure.recentSwings.some((swing) => swing.kind === 'low' && swing.price === 88))
  assert.ok(!lowSweep.structure.chartPivots.some((swing) => swing.kind === 'low' && swing.price === 88))

  const closeConfirmedLowBreak = wickOnlyHighBreak.map((item, index) =>
    index === 7 ? { ...item, low: 88, close: 89 } : item
  )
  const lowBreak = classifyStructure(closeConfirmedLowBreak, { lookback: 1, minCandles: 8 })
  assert.ok(lowBreak.structure.recentSwings.some((swing) => swing.kind === 'low' && swing.price === 88))
})

test('a recent close through a major counter-swing changes the established trend', () => {
  const established = zigzag([100, 120, 112, 140, 130, 160], { steps: 8 })
  const before = classifyStructure(established, { lookback: 2, minCandles: 20 })
  assert.equal(before.trend, 'up')

  const wickSweep = [
    ...established,
    candle(established.at(-1).time + HOUR, 155, 156, before.structure.low.current.price - 2, before.structure.low.current.price + 1),
  ]
  const afterWick = classifyStructure(wickSweep, { lookback: 2, minCandles: 20 })
  assert.equal(afterWick.trend, 'up')
  assert.notEqual(afterWick.event, 'CHoCH_DOWN')

  const broken = [
    ...wickSweep,
    candle(wickSweep.at(-1).time + HOUR, 131, 133, 120, before.structure.low.current.price - 1),
  ]
  const after = classifyStructure(broken, { lookback: 2, minCandles: 20 })
  assert.equal(after.establishedTrend, 'up')
  assert.equal(after.trend, 'down')
  assert.equal(after.structureConfirmed, false)
  assert.equal(after.event, 'CHoCH_DOWN')
  assert.equal(after.eventDetail.referencePrice, before.structure.low.current.price)
  assert.match(after.reason, /bias je down/)
  const profile = evaluateTradeProfile({
    item: after,
    settings: { pullbackPct: 50, minRewardRisk: 2, riskPct: 1 },
  })
  assert.equal(profile.mode, 'formation')
  assert.equal(profile.formationState, 'awaiting-confirmation')
  assert.equal(profile.side, null)
  assert.equal(profile.pendingSide, 'short')
  assert.equal(profile.directionalSide, 'short')
  assert.equal(profile.gates.find((gate) => gate.id === 'structure-confirmed').status, 'unmet')
})

test('mixed confirmed pivots are flat until a complete directional sequence forms', () => {
  const upWithPullback = classifyStructure(
    zigzag([100, 120, 110, 140, 125, 135, 130, 134], { steps: 8 }),
    { lookback: 2, minCandles: 20 }
  )
  assert.equal(upWithPullback.structure.high.label, 'LH')
  assert.equal(upWithPullback.structure.low.label, 'HL')
  assert.equal(upWithPullback.trend, 'flat')

  const downWithBounce = classifyStructure(
    zigzag([160, 130, 150, 110, 140, 120, 135, 122], { steps: 8 }),
    { lookback: 2, minCandles: 20 }
  )
  assert.equal(downWithBounce.structure.high.label, 'LH')
  assert.equal(downWithBounce.structure.low.label, 'HL')
  assert.equal(downWithBounce.trend, 'flat')
  assert.equal(downWithBounce.establishedTrend, 'down')
  assert.ok(downWithBounce.structure.recentSwings.every((swing) => swing.label))
})

test('an unconfirmed bounce from a new lower low keeps the established downtrend', () => {
  const established = zigzag([160, 130, 150, 110, 140, 100], { steps: 8 })
  const oneBounce = [
    ...established,
    candle(established.at(-1).time + HOUR, 100, 109, 99, 108),
  ]
  const result = classifyStructure(oneBounce, { lookback: 2, minCandles: 20 })
  assert.equal(result.trend, 'down')
  assert.equal(result.establishedTrend, 'down')
  assert.equal(result.structure.protectedHigh.label, 'LH')
})

test('a closed break publishes the live terminal low before the pivot is confirmed', () => {
  const established = zigzag([160, 130, 150, 110, 140, 120], { steps: 8 })
  const before = classifyStructure(established, { lookback: 2, minCandles: 20 })
  assert.ok(before.structure.low.current.price < 120)

  const broken = [
    ...established,
    candle(established.at(-1).time + HOUR, 120, 122, 104, 106),
  ]
  const result = classifyStructure(broken, { lookback: 2, minCandles: 20 })

  assert.equal(result.structure.developingSwing.kind, 'low')
  assert.equal(result.structure.developingSwing.label, 'LL')
  assert.equal(result.structure.developingSwing.price, 104)
  assert.equal(result.structure.developingSwing.confirmed, false)
  assert.equal(result.structure.developingSwing.replacesCandleIndex, result.structure.low.current.candleIndex)
})

test('wide timeframe keeps its structural spine while exposing a responsive edge', () => {
  const rangeAfterExpansion = classifyStructure(
    zigzag([60, 67, 62, 65, 62.5, 81.5, 76, 82, 76.5, 79.5, 77], { steps: 24 }),
    { lookback: 42, minCandles: 20, includeZones: false, includeChartCandles: false }
  )

  assert.equal(rangeAfterExpansion.structure.lookback, 42)
  assert.equal(rangeAfterExpansion.structure.activeLookback, 11)
  assert.equal(rangeAfterExpansion.structure.swingCount, rangeAfterExpansion.structure.contextSwingCount)
  assert.ok(rangeAfterExpansion.structure.edgeSwingCount > rangeAfterExpansion.structure.swingCount)
  assert.equal(rangeAfterExpansion.structure.high, null)
  assert.equal(rangeAfterExpansion.structure.low.label, 'HL')
  assert.equal(rangeAfterExpansion.trend, 'flat')
  assert.ok(rangeAfterExpansion.structure.recentSwings.every((swing, index, all) =>
    index === 0 || swing.kind !== all[index - 1].kind
  ))
})

test('major LH and LL override short internal USDJPY-like reactions', () => {
  // The 159.8 -> 158 reaction is intentionally shorter than the 42-candle
  // structural radius. It must not turn the later 160.4 into an HH: the
  // relevant comparison is the preceding major 164 high, then the break to
  // the new 152.9 low confirms the down structure.
  const points = [161.3, 164, 155.2, 159.8, 158, 160.4, 152.9, 156.5]
  const legSteps = [50, 50, 8, 8, 50, 50, 50]
  const candles = []
  let time = START
  for (let leg = 0; leg < legSteps.length; leg += 1) {
    const step = (points[leg + 1] - points[leg]) / legSteps[leg]
    for (let index = 0; index < legSteps[leg]; index += 1) {
      const open = points[leg] + step * index
      const close = points[leg] + step * (index + 1)
      const wick = Math.abs(step) * 0.25
      candles.push(candle(time, open, Math.max(open, close) + wick, Math.min(open, close) - wick, close))
      time += HOUR
    }
  }

  const result = classifyStructure(candles, {
    lookback: 42,
    minCandles: 100,
    includeZones: false,
    includeChartCandles: false,
  })

  assert.equal(result.trend, 'down')
  assert.equal(result.structureConfirmed, true)
  assert.equal(result.structure.high.label, 'LH')
  assert.equal(result.structure.low.label, 'LL')
  assert.ok(result.structure.high.current.price > 160 && result.structure.high.current.price < 161)
  assert.ok(result.structure.low.current.price > 152 && result.structure.low.current.price < 153)
  assert.equal(result.structure.recentSwings.length, 4)
  assert.equal(result.structure.activeRange.high.label, 'LH')
  assert.equal(result.structure.activeRange.low.label, 'LL')
  assert.ok(result.structure.activeRange.high.price > 160 && result.structure.activeRange.high.price < 161)
  assert.ok(result.structure.activeRange.low.price > 152 && result.structure.activeRange.low.price < 153)
  assert.equal(result.structure.developingCounterSwing.label, 'LH')
  assert.ok(result.structure.developingCounterSwing.price > 156 && result.structure.developingCounterSwing.price < 157)
})

test('1H rebound inherits its active 4H down wave until it closes above the parent LH', () => {
  const fourHour = classifyStructure(
    zigzag([164, 155.2, 160.4, 152.9, 157.7], { steps: 12 }),
    { lookback: 2, minCandles: 20, includeZones: false, includeChartCandles: false }
  )
  fourHour.trend = 'down'
  fourHour.structureConfirmed = true
  fourHour.structure.activeRange = {
    high: { kind: 'high', label: 'LH', price: 160.4, close: 160, time: START, candleIndex: 0 },
    low: { kind: 'low', label: 'LL', price: 152.9, close: 153.2, time: START + 10 * HOUR, candleIndex: 10 },
    source: 'active-edge',
  }
  const hourly = classifyStructure(
    zigzag([152.9, 155.4, 154.8, 157.7], { steps: 10 }),
    { lookback: 2, minCandles: 20, includeZones: false }
  )
  assert.notEqual(hourly.trend, 'down')

  const trends = { '1h': hourly, '4h': fourHour }
  alignOneHourStructureToFourHour(trends)

  assert.equal(hourly.trend, 'down')
  assert.equal(hourly.structureConfirmed, true)
  assert.equal(hourly.structure.activeRange.source, '4h-active-spine')
  assert.equal(hourly.structure.high.current.label, 'LH')
  assert.equal(hourly.structure.high.current.price, 160.4)
  assert.equal(hourly.structure.low.current.label, 'LL')
  assert.equal(hourly.structure.low.current.price, 152.9)
  assert.equal(hourly.structure.developingCounterSwing.label, 'LH')
  assert.ok(hourly.structure.developingCounterSwing.price > 157 && hourly.structure.developingCounterSwing.price < 160.4)
})

test('a fresh 4H down break keeps the 1H chart directional but non-executable', () => {
  const hourly = classifyStructure(zigzag([152.9, 157.7], { steps: 16 }), {
    lookback: 2, minCandles: 20, includeZones: false,
  })
  const fourHour = {
    trend: 'down',
    structureConfirmed: false,
    structure: {
      activeRange: {
        high: { kind: 'high', label: 'LH', price: 160.4, time: START, candleIndex: 0 },
        low: { kind: 'low', label: 'LL', price: 152.9, time: START + 8 * HOUR, candleIndex: 8 },
      },
    },
  }
  alignOneHourStructureToFourHour({ '1h': hourly, '4h': fourHour })
  assert.equal(hourly.trend, 'down')
  assert.equal(hourly.structureConfirmed, false)
  assert.equal(hourly.structure.confirmed, false)
})

test('a delayed 4H spine uses its current LH to LL wave for pullback levels', () => {
  const points = [145, 150, 147, 155, 150, 164, 155.2, 159.8, 158, 160.4, 152.9, 156.5]
  const legSteps = [100, 100, 100, 100, 100, 50, 8, 8, 50, 50, 50]
  const candles = []
  let time = START
  for (let leg = 0; leg < legSteps.length; leg += 1) {
    const step = (points[leg + 1] - points[leg]) / legSteps[leg]
    for (let index = 0; index < legSteps[leg]; index += 1) {
      const open = points[leg] + step * index
      const close = points[leg] + step * (index + 1)
      candles.push(candle(time, open, Math.max(open, close) + Math.abs(step) * 0.25, Math.min(open, close) - Math.abs(step) * 0.25, close))
      time += HOUR
    }
  }

  const result = classifyStructure(candles, {
    lookback: 96,
    minCandles: 100,
    includeZones: false,
    includeChartCandles: false,
  })
  assert.equal(result.trend, 'down')
  assert.equal(result.structure.activeRange.source, 'active-edge')
  assert.equal(result.structure.activeRange.high.label, 'LH')
  assert.equal(result.structure.activeRange.low.label, 'LL')
  assert.ok(result.structure.activeRange.high.price > 160 && result.structure.activeRange.high.price < 161)
  assert.ok(result.structure.activeRange.low.price > 152 && result.structure.activeRange.low.price < 153)

  // The chart is an audit surface: the active edge used for pullback and
  // risk calculations must be the visible terminal leg, not a disconnected
  // older spine that ends before the current wave.
  const chartPivots = result.structure.chartPivots
  assert.ok(chartPivots.some((pivot) => pivot.candleIndex === result.structure.activeRange.high.candleIndex && pivot.label === 'LH'))
  assert.ok(chartPivots.some((pivot) => pivot.candleIndex === result.structure.activeRange.low.candleIndex && pivot.label === 'LL'))
  assert.ok(chartPivots.some((pivot) => pivot.candleIndex === result.structure.developingCounterSwing.candleIndex && pivot.label === 'LH'))
  assert.ok(chartPivots.every((pivot, index) => index === 0 || (
    pivot.time > chartPivots[index - 1].time && pivot.kind !== chartPivots[index - 1].kind
  )))
})

test('structure horizons and pivot widths scale with timeframe', () => {
  assert.deepEqual(PRICE_ACTION_STRUCTURE_PROFILES, {
    '1h': { historyDays: 30, zoneHistoryDays: 120, pivotLookback: 18, minCandles: 300, zoneMaxAgeCandles: 2880 },
    '4h': { historyDays: 180, zoneHistoryDays: 365, pivotLookback: 96, minCandles: 250, zoneMaxAgeCandles: 2190 },
    '1d': { historyDays: 400, zoneHistoryDays: 730, pivotLookback: 30, minCandles: 160, zoneMaxAgeCandles: 730 },
  })
  assert.ok(PRICE_ACTION_STRUCTURE_PROFILES['1d'].historyDays > 365)
  assert.ok(PRICE_ACTION_STRUCTURE_PROFILES['4h'].historyDays >= 180)
  assert.ok(PRICE_ACTION_STRUCTURE_PROFILES['1h'].historyDays <= 30)
  assert.ok(PRICE_ACTION_STRUCTURE_PROFILES['1h'].zoneHistoryDays > PRICE_ACTION_STRUCTURE_PROFILES['1h'].historyDays)
})

test('older untouched FVGs remain available as exit targets without widening the structure horizon', () => {
  const allCandles = [
    // A bullish displacement creates a demand FVG at 101-105.
    candle(START, 100, 101, 98, 99),
    candle(START + HOUR, 99, 111, 99, 110),
    candle(START + 2 * HOUR, 109, 113, 105, 112),
  ]
  for (let index = 3; index < 900; index += 1) {
    allCandles.push(candle(START + index * HOUR, 120, 121, 119, 120))
  }
  const analysisCandles = allCandles.slice(-300)
  const result = classifyStructure(analysisCandles, {
    lookback: 18,
    minCandles: 100,
    zoneCandles: allCandles,
    zoneMaxAgeCandles: 1200,
  })

  assert.equal(result.candles, 300, 'the active trend still uses its short horizon')
  assert.equal(result.structure.zoneCandles, 900)
  assert.ok(result.zones.unfilledDemand.some((zone) => zone.low === 101 && zone.high === 105))
})

test('a partial same-timeframe touch consumes an FVG and separates old touches from the active setup', () => {
  const untouched = [
    // Demand base + bullish displacement + bullish FVG confirmation at 101-105.
    candle(START, 100, 101, 98, 99),
    candle(START + 1 * HOUR, 99, 111, 99, 110),
    candle(START + 2 * HOUR, 109, 113, 105, 112),
    // This candle remains above the FVG, so the zone is initially available.
    candle(START + 3 * HOUR, 112, 114, 106, 110),
  ]
  const available = activeSupplyDemandZones(untouched, { lookback: 1, maxAgeCandles: 100 })
  assert.equal(available.demand.low, 101)
  assert.equal(available.demand.high, 105)
  assert.equal(available.demand.touches, 0)
  assert.deepEqual(available.demand.definingCandles.map((item) => item.time), [START, START + HOUR, START + 2 * HOUR])

  const partialTouch = [
    ...untouched,
    // The wick enters 104.5-105 but closes back above the FVG. The zone is
    // not close-filled, yet it must never arm a later order.
    candle(START + 4 * HOUR, 110, 111, 104.5, 106),
  ]
  const consumed = activeSupplyDemandZones(partialTouch, { lookback: 1, maxAgeCandles: 100 })
  const consumedDemand = consumed.allDemand.find((zone) => zone.low === 101 && zone.high === 105)
  assert.equal(consumed.demand, null, 'a first partial own-timeframe touch must remove the zone from new entries')
  assert.equal(consumed.nearbyDemand.some((zone) => zone.low === 101 && zone.high === 105), false)
  assert.equal(consumedDemand.filledByOwnTimeframeClose, false)
  assert.equal(consumedDemand.invalidatedByOwnTimeframeClose, false)
  assert.equal(consumedDemand.firstTouchAt, START + 4 * HOUR)
  assert.match(consumed.rule, /První dotek/)

  const historical = activeSupplyDemandZones(partialTouch, {
    lookback: 1,
    maxAgeCandles: 100,
    setupAnchor: { time: START + 5 * HOUR, label: 'LL' },
  })
  const historicalDemand = historical.allDemand.find((zone) => zone.low === 101 && zone.high === 105)
  assert.equal(historicalDemand.consumedBeforeCurrentSetup, true)
  assert.equal(historical.currentSetupDemand.length, 0, 'a touch before the latest pivot must not reach the chart or table')
  assert.ok(historical.historicalConsumedDemand.some((zone) => zone.low === 101 && zone.high === 105), 'a prior-wave touch remains available as non-tradable audit context')

  const current = activeSupplyDemandZones(partialTouch, {
    lookback: 1,
    maxAgeCandles: 100,
    setupAnchor: { time: START + 3 * HOUR, label: 'LL' },
  })
  const currentDemand = current.currentSetupDemand.find((zone) => zone.low === 101 && zone.high === 105)
  assert.equal(currentDemand.touchedDuringCurrentSetup, true)
  assert.equal(currentDemand.setupAnchorLabel, 'LL')
  assert.equal(currentDemand.firstTouchAt, START + 4 * HOUR)
  assert.equal(currentDemand.definingCandles[0].open, undefined, 'audit zones keep their origin without duplicating candle OHLC')

  const hardInvalidation = activeSupplyDemandZones([
    ...partialTouch,
    // Closing through the far demand edge prevents any later entry, but the
    // current setup still needs the zone published as a red audit marker.
    candle(START + 5 * HOUR, 106, 107, 99, 100),
  ], {
    lookback: 1,
    maxAgeCandles: 100,
    setupAnchor: { time: START + 3 * HOUR, label: 'LL' },
  })
  const invalidatedDemand = hardInvalidation.currentSetupInvalidatedDemand.find((zone) => zone.low === 101 && zone.high === 105)
  assert.equal(hardInvalidation.demand, null, 'a hard-invalidated zone must never return to the entry pool')
  assert.ok(invalidatedDemand, 'the current setup must retain a hard-invalidated zone for audit')
  assert.equal(invalidatedDemand.invalidatedByOwnTimeframeClose, true)
  assert.equal(invalidatedDemand.invalidatedAt, START + 5 * HOUR)
})

test('a partial same-timeframe touch consumes a supply FVG without a close through it', () => {
  const supplyFvg = [
    // The outer wicks leave a bearish FVG at 104-108.
    candle(START, 110, 112, 108, 111),
    candle(START + HOUR, 111, 111, 101, 102),
    candle(START + 2 * HOUR, 100, 104, 99, 100),
    // Price remains below the zone until the next candle's wick enters it.
    candle(START + 3 * HOUR, 101, 103, 99, 100),
    candle(START + 4 * HOUR, 100, 104.5, 98, 101),
  ]
  const zones = activeSupplyDemandZones(supplyFvg, { lookback: 1, maxAgeCandles: 100 })
  const supply = zones.allSupply.find((zone) => zone.low === 104 && zone.high === 108)

  assert.ok(supply, 'the bearish FVG must be retained in the audit catalogue')
  assert.equal(supply.firstTouchAt, START + 4 * HOUR)
  assert.equal(supply.filledByOwnTimeframeClose, false, 'a wick-only touch is not a close fill')
  assert.equal(supply.invalidatedByOwnTimeframeClose, false, 'a wick-only touch is not a hard far-edge break')
  assert.equal(zones.supply, null, 'the first wick touch consumes the supply zone for a new short entry')
  assert.equal(zones.nearbySupply.some((zone) => zone.low === 104 && zone.high === 108), false)
})

test('an untouched raw FVG is published to the active daily supply catalog', () => {
  const day = 24 * HOUR
  const candles = [
    // The outer wicks leave a bearish 0.5934-0.5949 FVG. Its bodies do not
    // meet the old displacement/base filter, which must not affect the zone.
    candle(START, 0.6000, 0.6010, 0.5949, 0.5952),
    candle(START + day, 0.5952, 0.5954, 0.5936, 0.5938),
    candle(START + 2 * day, 0.5932, 0.5934, 0.5909, 0.5913),
    candle(START + 3 * day, 0.5913, 0.5928, 0.5898, 0.5906),
  ]

  const zones = activeSupplyDemandZones(candles, {
    maxAgeCandles: 100,
    setupAnchor: { time: START + 2 * day, label: 'HH' },
  })
  const supply = zones.unfilledSupply.find((zone) => zone.low === 0.5934 && zone.high === 0.5949)

  assert.ok(supply, 'the raw FVG must reach the available supply list')
  assert.equal(supply.firstTouchAt, null)
  assert.equal(supply.filledByOwnTimeframeClose, false)
  assert.equal(supply.invalidatedByOwnTimeframeClose, false)
  assert.ok(zones.nearbySupply.some((zone) => zone.low === 0.5934 && zone.high === 0.5949))
  assert.match(zones.rule, /tří bezprostředně po sobě jdoucích svíček/)
})

test('daily FX aggregation preserves a closed Friday session and publishes its weekend FVG', () => {
  const day = 24 * HOUR
  const thursday = Date.UTC(2026, 0, 1)
  const hourlySession = (start, parts, open, high, low, close) => Array.from({ length: parts }, (_, index) =>
    candle(start + index * HOUR, open, high, low, close)
  )
  const hourly = [
    ...hourlySession(thursday, 24, 0.6000, 0.6010, 0.5949, 0.5952),
    // Friday closes after 22 hourly bars. This is a closed FX session, not a
    // current partial daily candle.
    ...hourlySession(thursday + day, 22, 0.5952, 0.5954, 0.5936, 0.5938),
    // Sunday pre-open is intentionally too short to become a daily candle.
    ...hourlySession(thursday + 3 * day, 1, 0.5920, 0.5922, 0.5916, 0.5920),
    ...hourlySession(thursday + 4 * day, 24, 0.5932, 0.5934, 0.5909, 0.5913),
    // A current two-hour bucket remains unavailable to the strategy.
    ...hourlySession(thursday + 5 * day, 2, 0.5913, 0.5920, 0.5900, 0.5915),
  ]

  const regular = aggregateHourlyTimeframeCandles({ candles: hourly, timeframeId: '1d' }).candles
  assert.deepEqual(regular.map((item) => item.time), [thursday, thursday + 4 * day])

  const fx = aggregateHourlyTimeframeCandles({
    candles: hourly,
    timeframeId: '1d',
    allowFxShortSessions: true,
  }).candles
  assert.deepEqual(fx.map((item) => item.time), [thursday, thursday + day, thursday + 4 * day])
  const fxChart = aggregateHourlyTimeframeCandles({
    candles: hourly,
    timeframeId: '1d',
    allowFxShortSessions: true,
  }).chartCandles
  assert.deepEqual(fxChart.map((item) => item.time), [thursday, thursday + day, thursday + 4 * day, thursday + 5 * day])
  const zones = activeSupplyDemandZones(fx, {
    maxAgeCandles: 100,
    allowWeekendSessionGap: true,
    setupAnchor: { time: thursday, label: 'HH' },
  })
  assert.ok(zones.unfilledSupply.some((zone) => zone.low === 0.5934 && zone.high === 0.5949))
  assert.ok(zones.nearbySupply.some((zone) => zone.fvg?.definingCandles?.length === 3))
})

test('trade profile requires S/D zone hit, 50 percent pullback and at least 2R', () => {
  const item = {
    trend: 'up',
    reason: 'HH + HL',
    event: null,
    price: 103,
    lastCandle: candle(START, 106, 107, 102, 103),
    candleSignal: { bullish: 'bullish_rejection', bearish: null, patterns: ['bullish_rejection'] },
    structure: {
      high: { current: { price: 120 } },
      low: { current: { price: 100 } },
    },
    zones: {
      demand: { type: 'demand', low: 100, high: 105 },
      supply: null,
      latestValidDemand: { type: 'demand', low: 100, high: 105 },
      latestValidSupply: null,
      unfilledDemand: [{ type: 'demand', low: 100, high: 105 }],
      unfilledSupply: [{ type: 'supply', low: 140, high: 145 }],
    },
  }

  const profile = evaluateTradeProfile({
    item,
    lowerItem: { trend: 'up', event: null, structure: { low: { current: { price: 101 } } } },
    lowerTimeframeId: '1h',
    settings: { pullbackPct: 50, minRewardRisk: 2, riskPct: 1, stopBufferPct: 0.02 },
  })

  assert.equal(profile.status, 'ready')
  assert.equal(profile.side, 'long')
  assert.equal(profile.riskPct, 1)
  assert.equal(profile.zoneHit, true)
  assert.ok(profile.rewardRisk >= 2)
  assert.equal(profile.entry, 105, 'planned entry must be the zone edge, not the current close')
  assert.equal(profile.entryAtZoneHit, 105)
  assert.equal(profile.entrySource, 'zone-edge')
  assert.deepEqual(profile.pullbackRange, { from: 110, to: 100 })
  const demandCandidate = profile.zoneCandidates.find((candidate) => candidate.type === 'demand')
  assert.equal(demandCandidate.eligible, true)
  assert.deepEqual(demandCandidate.entryRange, { low: 100, high: 105 })
  assert.equal(demandCandidate.entryForMinRR, 105)
  assert.equal(profile.tp1, 120)
  assert.equal(profile.tp2, 140)
  assert.equal('invalidation' in profile, false)
  assert.equal(profile.refinement.status, 'met')

  const withoutHit = evaluateTradeProfile({
    item: {
      ...item,
      lastCandle: candle(START + HOUR, 115, 116, 114, 115),
      price: 115,
    },
    settings: { pullbackPct: 50, minRewardRisk: 2, riskPct: 1, stopBufferPct: 0.02 },
  })
  assert.equal(withoutHit.status, 'watch')
  assert.equal(withoutHit.gates.find((entry) => entry.id === 'zone').status, 'unmet')

  const exitedZone = evaluateTradeProfile({
    item: { ...item, price: 115 },
    settings: { pullbackPct: 50, minRewardRisk: 2, riskPct: 1, stopBufferPct: 0.02 },
  })
  assert.equal(exitedZone.zoneTouched, true)
  assert.equal(exitedZone.zoneHit, false)
  assert.equal(exitedZone.status, 'watch')
  assert.equal(exitedZone.gates.find((entry) => entry.id === 'zone').status, 'unmet')
})

test('a historical wick through 50 percent does not keep the pullback gate green after price recovers', () => {
  const profile = evaluateTradeProfile({
    item: {
      trend: 'up',
      price: 115,
      lastCandle: candle(START, 109, 116, 99, 115),
      candleSignal: { bullish: 'bullish_rejection', bearish: null, patterns: ['bullish_rejection'] },
      structure: {
        high: { current: { price: 120 } },
        low: { current: { price: 100 } },
      },
      zones: {
        demand: { type: 'demand', low: 100, high: 105 },
        unfilledDemand: [{ type: 'demand', low: 100, high: 105 }],
        unfilledSupply: [{ type: 'supply', low: 140, high: 145 }],
      },
    },
    settings: { pullbackPct: 50, minRewardRisk: 2, stopBufferPct: 0.02 },
  })

  assert.equal(profile.pullbackRange.from, 110)
  assert.equal(profile.gates.find((gate) => gate.id === 'pullback').status, 'unmet')
  assert.equal(profile.status, 'watch')
})

test('TP2 uses the nearest opposing zone beyond TP1, not merely beyond entry', () => {
  const longProfile = evaluateTradeProfile({
    item: {
      trend: 'up',
      price: 103,
      lastCandle: candle(START, 106, 107, 102, 103),
      structure: { high: { current: { price: 120 } }, low: { current: { price: 100 } } },
      zones: {
        demand: { type: 'demand', low: 100, high: 105 },
        unfilledDemand: [{ type: 'demand', low: 100, high: 105 }],
        unfilledSupply: [
          { type: 'supply', low: 112, high: 114 },
          { type: 'supply', low: 140, high: 142 },
        ],
      },
    },
    settings: { pullbackPct: 50, minRewardRisk: 2, stopBufferPct: 0.02 },
  })
  assert.equal(longProfile.tp1, 120)
  assert.equal(longProfile.tp2, 140)
  assert.ok(longProfile.tp2 > longProfile.tp1)

  const shortProfile = evaluateTradeProfile({
    item: {
      trend: 'down',
      price: 117,
      lastCandle: candle(START, 114, 118, 113, 117),
      structure: { high: { current: { price: 120 } }, low: { current: { price: 100 } } },
      zones: {
        supply: { type: 'supply', low: 115, high: 120 },
        unfilledSupply: [{ type: 'supply', low: 115, high: 120 }],
        unfilledDemand: [
          { type: 'demand', low: 108, high: 110, firstTouchAt: START + HOUR },
          { type: 'demand', low: 80, high: 85 },
        ],
      },
    },
    settings: { pullbackPct: 50, minRewardRisk: 2, stopBufferPct: 0.02 },
  })
  assert.equal(shortProfile.tp1, 100)
  assert.equal(shortProfile.tp2, 85)
  assert.ok(shortProfile.tp2 < shortProfile.tp1)
})

test('a setup can use TP1 alone when no opposing FVG lies beyond the structural target', () => {
  const profile = evaluateTradeProfile({
    item: {
      trend: 'down',
      price: 117,
      lastCandle: candle(START, 114, 118, 113, 117),
      structure: { high: { current: { price: 120 } }, low: { current: { price: 100 } } },
      zones: {
        supply: { type: 'supply', low: 115, high: 120 },
        unfilledSupply: [{ type: 'supply', low: 115, high: 120 }],
        // This demand FVG is before TP1, so it cannot be TP2 for the short.
        unfilledDemand: [{ type: 'demand', low: 108, high: 110 }],
      },
    },
    settings: { pullbackPct: 50, minRewardRisk: 2, stopBufferPct: 0.02 },
  })

  assert.equal(profile.tp1, 100)
  assert.equal(profile.tp2, null)
  assert.equal(profile.weightedTarget, 100, 'R/R falls back to the executable first target')
  assert.ok(profile.rewardRisk >= 2)
  assert.equal(profile.entry, 115)
  assert.equal(profile.status, 'ready')
})

test('an inherited completed 4H leg can arm a 1H pullback setup', () => {
  const profile = evaluateTradeProfile({
    item: {
      trend: 'down',
      structureConfirmed: false,
      price: 117,
      lastCandle: candle(START, 114, 118, 113, 117),
      structure: {
        activeRange: {
          source: '4h-active-spine',
          high: { label: 'LH', price: 120 },
          low: { label: 'LL', price: 100 },
        },
      },
      zones: {
        supply: { type: 'supply', low: 115, high: 120 },
        unfilledSupply: [{ type: 'supply', low: 115, high: 120 }],
        unfilledDemand: [{ type: 'demand', low: 80, high: 85 }],
      },
    },
    settings: { pullbackPct: 50, minRewardRisk: 2, stopBufferPct: 0.02 },
  })

  assert.equal(profile.mode, 'screening')
  assert.equal(profile.side, 'short')
  assert.equal(profile.status, 'ready')
})

test('a fresh CHoCH publishes a non-executable supply or demand plan for audit', () => {
  const profile = evaluateTradeProfile({
    item: {
      trend: 'down',
      structureConfirmed: false,
      reason: 'CHoCH_DOWN; čeká se na LH + LL',
      price: 117,
      lastCandle: candle(START, 114, 118, 113, 117),
      structure: {
        activeRange: {
          high: { price: 120 },
          low: { price: 100 },
        },
      },
      zones: {
        supply: { type: 'supply', low: 115, high: 120 },
        unfilledSupply: [{ type: 'supply', low: 115, high: 120 }],
        unfilledDemand: [{ type: 'demand', low: 80, high: 85 }],
      },
    },
    settings: { pullbackPct: 50, minRewardRisk: 2, stopBufferPct: 0.02 },
  })

  assert.equal(profile.mode, 'formation')
  assert.equal(profile.side, null, 'formation must not authorize the executor')
  assert.equal(profile.pendingSide, 'short')
  assert.deepEqual(profile.pullbackRange, { from: 110, to: 120 })
  assert.ok(profile.zoneCandidates.some((candidate) => candidate.type === 'supply' && candidate.eligible))
  assert.equal(profile.entry, 115)
  assert.ok(profile.stop > 120)
  assert.equal(profile.tp1, 100)
  assert.equal(profile.tp2, 85)
  assert.ok(profile.rewardRisk >= 2)
  assert.equal(profile.status, 'neutral')
  assert.equal(profile.gates.find((gate) => gate.id === 'structure-confirmed').status, 'unmet')
})

test('stop sits beyond both the entry zone and the external structural pivot', () => {
  const longProfile = evaluateTradeProfile({
    item: {
      trend: 'up',
      price: 103,
      lastCandle: candle(START, 106, 107, 102, 103),
      structure: { high: { current: { price: 120 } }, low: { current: { price: 98 } } },
      zones: {
        demand: { type: 'demand', low: 100, high: 105 },
        unfilledDemand: [{ type: 'demand', low: 100, high: 105 }],
        unfilledSupply: [{ type: 'supply', low: 140, high: 142 }],
      },
    },
    settings: { pullbackPct: 50, minRewardRisk: 2, stopBufferPct: 0.02 },
  })
  assert.equal(longProfile.stopAnchor, 98)
  assert.ok(longProfile.stop < 98)

  const shortProfile = evaluateTradeProfile({
    item: {
      trend: 'down',
      price: 117,
      lastCandle: candle(START, 114, 118, 113, 117),
      structure: { high: { current: { price: 125 } }, low: { current: { price: 100 } } },
      zones: {
        supply: { type: 'supply', low: 115, high: 120 },
        unfilledSupply: [{ type: 'supply', low: 115, high: 120 }],
        unfilledDemand: [{ type: 'demand', low: 80, high: 85 }],
      },
    },
    settings: { pullbackPct: 50, minRewardRisk: 2, stopBufferPct: 0.02 },
  })
  assert.equal(shortProfile.stopAnchor, 125)
  assert.ok(shortProfile.stop > 125)
})

test('price-action profiles retain source precision throughout the R/R calculation', () => {
  const profile = evaluateTradeProfile({
    item: {
      trend: 'up',
      price: 1.119876,
      lastCandle: candle(START, 1.121234, 1.122345, 1.109876, 1.119876),
      structure: {
        high: { current: { price: 1.150089 } },
        low: { current: { price: 1.100011 } },
      },
      zones: {
        demand: { type: 'demand', low: 1.105123, high: 1.110987 },
        nearbyDemand: [{ type: 'demand', low: 1.105123, high: 1.110987 }],
        unfilledDemand: [{ type: 'demand', low: 1.105123, high: 1.110987 }],
        unfilledSupply: [{ type: 'supply', low: 1.160123, high: 1.165432 }],
      },
    },
    settings: { pullbackPct: 50, minRewardRisk: 2, stopBufferPct: 0.02 },
  })

  const candidate = profile.zoneCandidates.find((entry) => entry.type === 'demand')
  assert.equal(candidate.zone.low, 1.105123)
  assert.equal(candidate.zone.high, 1.110987)
  assert.equal(candidate.tp1, 1.150089)
  assert.equal(candidate.tp2, 1.160123)
  assert.equal(candidate.weightedTarget, 1.155106)
  assert.ok(candidate.rewardRisk >= 2, 'the source-precision levels must satisfy the minimum R/R')
})

test('optional candle confirmation can filter a zone hit without changing the default', () => {
  const item = {
    trend: 'up',
    lastCandle: candle(START, 106, 107, 102, 103),
    candleSignal: null,
    structure: {
      high: { current: { price: 120 } },
      low: { current: { price: 100 } },
    },
    zones: {
      demand: { type: 'demand', low: 100, high: 105 },
      supply: { type: 'supply', low: 140, high: 145 },
      nearbyDemand: [{ type: 'demand', low: 100, high: 105 }],
      unfilledDemand: [{ type: 'demand', low: 100, high: 105 }],
      unfilledSupply: [{ type: 'supply', low: 140, high: 145 }],
    },
  }

  const defaultProfile = evaluateTradeProfile({ item, settings: { pullbackPct: 50, minRewardRisk: 2 } })
  const confirmedProfile = evaluateTradeProfile({
    item,
    settings: { pullbackPct: 50, minRewardRisk: 2, requireCandleSignal: true },
  })

  assert.equal(defaultProfile.status, 'ready')
  assert.equal(confirmedProfile.status, 'watch')
  assert.equal(confirmedProfile.gates.find((entry) => entry.id === 'candle').status, 'unmet')
  assert.equal(confirmedProfile.zone, null)
  assert.equal(confirmedProfile.zoneCandidates[0].invalidatedByPrematureTouch, true)
})

test('a partial own-timeframe FVG touch consumes a zone before a complete setup', () => {
  const item = {
    trend: 'up',
    // The wick only enters the upper 0.5 of the 100-105 demand FVG. It does
    // not traverse the full gap, which is the exact case that must still
    // invalidate the unused entry idea.
    lastCandle: candle(START + HOUR, 106, 107, 104.5, 106),
    candleSignal: null,
    structure: {
      high: { current: { price: 120 } },
      low: { current: { price: 100 } },
    },
    zones: {
      nearbyDemand: [{ type: 'demand', low: 100, high: 105 }],
      unfilledDemand: [{ type: 'demand', low: 100, high: 105 }],
      unfilledSupply: [{ type: 'supply', low: 140, high: 145 }],
    },
  }

  const profile = evaluateTradeProfile({
    item,
    settings: { pullbackPct: 50, minRewardRisk: 2, requireCandleSignal: true },
  })
  const candidate = profile.zoneCandidates.find((entry) => entry.type === 'demand')

  assert.equal(candidate.zoneTouched, true)
  assert.equal(candidate.zoneHit, false)
  assert.equal(candidate.baseEligible, true)
  assert.equal(candidate.invalidatedByPrematureTouch, true)
  assert.equal(candidate.eligible, false)
  assert.match(candidate.reason, /dotčena před kompletním vstupním setupem/)
  assert.equal(profile.zone, null)
  assert.equal(profile.entry, null)
  assert.equal(profile.gates.find((entry) => entry.id === 'unfilled-zone').status, 'unmet')
})

test('an earlier own-timeframe touch keeps a zone consumed after price leaves it', () => {
  const item = {
    trend: 'up',
    lastCandle: candle(START + HOUR, 110, 111, 109, 110),
    candleSignal: { bullish: 'bullish_rejection', bearish: null, patterns: ['bullish_rejection'] },
    structure: {
      high: { current: { price: 120 } },
      low: { current: { price: 100 } },
    },
    zones: {
      nearbyDemand: [{ type: 'demand', low: 100, high: 105, lastTouchAt: START }],
      unfilledDemand: [{ type: 'demand', low: 100, high: 105, lastTouchAt: START }],
      unfilledSupply: [{ type: 'supply', low: 140, high: 145 }],
    },
  }

  const profile = evaluateTradeProfile({ item, settings: { pullbackPct: 50, minRewardRisk: 2 } })
  const candidate = profile.zoneCandidates.find((entry) => entry.type === 'demand')

  assert.equal(candidate.zoneHit, false)
  assert.equal(candidate.invalidatedByPrematureTouch, true)
  assert.equal(profile.zone, null)
  assert.equal(profile.entry, null)
})

test('optional higher-timeframe alignment filters an opposing trend without changing the default', () => {
  const item = {
    trend: 'up',
    lastCandle: candle(START, 106, 107, 102, 103),
    structure: {
      high: { current: { price: 120 } },
      low: { current: { price: 100 } },
    },
    zones: {
      nearbyDemand: [{ type: 'demand', low: 100, high: 105 }],
      nearbySupply: [{ type: 'supply', low: 140, high: 145 }],
      unfilledDemand: [{ type: 'demand', low: 100, high: 105 }],
      unfilledSupply: [{ type: 'supply', low: 140, high: 145 }],
    },
  }
  const higherItem = { trend: 'down' }

  const defaultProfile = evaluateTradeProfile({
    item,
    higherItem,
    higherTimeframeId: '4h',
    settings: { pullbackPct: 50, minRewardRisk: 2 },
  })
  const alignedProfile = evaluateTradeProfile({
    item,
    higherItem,
    higherTimeframeId: '4h',
    settings: { pullbackPct: 50, minRewardRisk: 2, requireHigherTimeframeAlignment: true },
  })

  assert.equal(defaultProfile.gates.find((entry) => entry.id === 'higher-trend').status, 'neutral')
  assert.equal(alignedProfile.status, 'watch')
  assert.equal(alignedProfile.gates.find((entry) => entry.id === 'higher-trend').status, 'unmet')
})

test('a deeper entry inside the zone can rescue reward/risk', () => {
  const item = {
    trend: 'up',
    price: 115,
    lastCandle: candle(START, 116, 117, 114, 115),
    structure: {
      high: { current: { price: 120 } },
      low: { current: { price: 100 } },
    },
    zones: {
      nearbyDemand: [{ type: 'demand', low: 100, high: 105 }],
      nearbySupply: [{ type: 'supply', low: 140, high: 145 }],
      unfilledDemand: [{ type: 'demand', low: 100, high: 105 }],
      unfilledSupply: [{ type: 'supply', low: 140, high: 145 }],
    },
  }
  const profile = evaluateTradeProfile({ item, settings: { pullbackPct: 50, minRewardRisk: 6, stopBufferPct: 0.02 } })
  const candidate = profile.zoneCandidates.find((entry) => entry.type === 'demand')
  assert.equal(candidate.eligible, true)
  assert.ok(candidate.entryForMinRR < candidate.entryAtZoneHit)
  assert.ok(candidate.rewardRisk >= 6)
  assert.equal(profile.entry, candidate.entryForMinRR, 'profile entry must use the R/R-adjusted level')
  assert.equal(profile.entrySource, 'min-rr')
})

test('a lower-timeframe demand zone refines the entry inside the parent zone', () => {
  const item = {
    trend: 'up',
    price: 118,
    lastCandle: candle(START, 119, 120, 117, 118),
    structure: {
      high: { current: { price: 140 } },
      low: { current: { price: 100 } },
    },
    zones: {
      nearbyDemand: [{ type: 'demand', low: 100, high: 110, lastIndex: 10 }],
      unfilledDemand: [{ type: 'demand', low: 100, high: 110, lastIndex: 10 }],
      unfilledSupply: [{ type: 'supply', low: 160, high: 165 }],
    },
  }
  const profile = evaluateTradeProfile({
    item,
    lowerItem: {
      trend: 'down',
      zones: {
        nearbyDemand: [{ type: 'demand', low: 103, high: 106, lastIndex: 20 }],
        unfilledDemand: [{ type: 'demand', low: 103, high: 106, lastIndex: 20 }],
      },
    },
    lowerTimeframeId: '1h',
    settings: { pullbackPct: 50, minRewardRisk: 2, stopBufferPct: 0.02 },
  })
  const candidate = profile.zoneCandidates.find((entry) => entry.type === 'demand')
  assert.equal(candidate.entryAtZoneHit, 110)
  assert.equal(candidate.refinedEntry, 106)
  assert.equal(candidate.lowerTimeframeId, '1h')
  assert.equal(candidate.entrySource, 'lower-timeframe-zone')
  assert.equal(profile.entry, 106)
  assert.equal(profile.entryRefinement.entry, 106)
})

test('zone hit entry is constrained to the pullback overlap', () => {
  const item = {
    trend: 'up',
    price: 130,
    lastCandle: candle(START, 131, 132, 129, 130),
    structure: {
      high: { current: { price: 140 } },
      low: { current: { price: 100 } },
    },
    zones: {
      nearbyDemand: [{ type: 'demand', low: 105, high: 125 }],
      unfilledDemand: [{ type: 'demand', low: 105, high: 125 }],
      unfilledSupply: [{ type: 'supply', low: 160, high: 165 }],
    },
  }
  // The wider structural stop leaves this synthetic case at roughly 1.5R;
  // this test isolates pullback clipping rather than the strategy's 2R gate.
  const profile = evaluateTradeProfile({ item, settings: { pullbackPct: 50, minRewardRisk: 1.4 } })
  const candidate = profile.zoneCandidates.find((entry) => entry.type === 'demand')
  assert.deepEqual(candidate.entryRange, { low: 105, high: 120 })
  assert.equal(candidate.entryAtZoneHit, 120)
  assert.equal(profile.entry, 120)
})

test('entry is not published when the selected zone is outside the pullback range', () => {
  const item = {
    trend: 'up',
    price: 78145,
    lastCandle: candle(START, 78100, 78150, 78000, 78145),
    structure: {
      high: { current: { price: 79924 } },
      low: { current: { price: 75906 } },
    },
    zones: {
      nearbyDemand: [{ type: 'demand', low: 78000, high: 78542 }],
      unfilledDemand: [{ type: 'demand', low: 78000, high: 78542 }],
      unfilledSupply: [{ type: 'supply', low: 81000, high: 81500 }],
    },
  }
  const profile = evaluateTradeProfile({ item, settings: { pullbackPct: 50, minRewardRisk: 2 } })
  const candidate = profile.zoneCandidates.find((entry) => entry.type === 'demand')
  const rangeLow = Math.min(profile.pullbackRange.from, profile.pullbackRange.to)
  const rangeHigh = Math.max(profile.pullbackRange.from, profile.pullbackRange.to)

  assert.deepEqual(profile.pullbackRange, { from: 77915, to: 75906 })
  assert.equal(candidate.pullbackEligible, false)
  assert.equal(candidate.entryAtZoneHit, 78542, 'zone edge remains available for diagnostics')
  assert.equal(profile.entry, null)
  assert.ok(profile.entry === null || (profile.entry >= rangeLow && profile.entry <= rangeHigh))
})

test('a profile below minimum R/R is never a valid setup or planned entry', () => {
  const item = {
    trend: 'up',
    price: 104,
    lastCandle: candle(START, 105, 106, 103, 104),
    structure: {
      high: { current: { price: 110 } },
      low: { current: { price: 100 } },
    },
    zones: {
      nearbyDemand: [{ type: 'demand', low: 100, high: 105 }],
      unfilledDemand: [{ type: 'demand', low: 100, high: 105 }],
      unfilledSupply: [{ type: 'supply', low: 105.5, high: 106 }],
    },
  }
  const profile = evaluateTradeProfile({ item, settings: { pullbackPct: 50, minRewardRisk: 2, stopBufferPct: 10 } })
  const candidate = profile.zoneCandidates.find((entry) => entry.type === 'demand')

  assert.ok(candidate.rrAtZoneHit < 2)
  assert.equal(candidate.rrEligible, false)
  assert.equal(candidate.eligible, false)
  assert.equal(candidate.entryForMinRR, null)
  assert.equal(profile.activeCandidate, null)
  assert.equal(profile.status, 'watch')
  assert.equal(profile.gates.find((entry) => entry.id === 'rr').status, 'unmet')
  assert.equal(profile.entry, null)
  assert.equal(profile.rewardRisk, null)
  assert.equal(profile.potentialEntry, candidate.entryAtZoneHit, 'a rejected R/R still keeps its diagnostic entry')
  assert.ok(Number.isFinite(candidate.rrAtPullback), 'the rejected candidate retains its calculated R/R')
  assert.equal(profile.potentialRewardRisk, candidate.rrAtPullback, 'a rejected R/R remains inspectable without arming an order')
})

test('overlapping same-side entry candidates keep only the newest FVG', () => {
  const item = {
    trend: 'up',
    price: 104,
    lastCandle: candle(START, 105, 106, 103, 104),
    structure: {
      high: { current: { price: 120 } },
      low: { current: { price: 100 } },
    },
    zones: {
      nearbyDemand: [
        { type: 'demand', low: 100, high: 105, firstIndex: 3, lastIndex: 5 },
        { type: 'demand', low: 103, high: 106, firstIndex: 7, lastIndex: 9 },
      ],
      unfilledDemand: [
        { type: 'demand', low: 100, high: 105, firstIndex: 3, lastIndex: 5 },
        { type: 'demand', low: 103, high: 106, firstIndex: 7, lastIndex: 9 },
      ],
      unfilledSupply: [{ type: 'supply', low: 140, high: 145 }],
    },
  }
  const profile = evaluateTradeProfile({ item, settings: { pullbackPct: 50, minRewardRisk: 2 } })
  const demandCandidates = profile.zoneCandidates.filter((candidate) => candidate.type === 'demand')

  assert.deepEqual(demandCandidates.map((candidate) => candidate.zone.lastIndex), [9])
})

test('open-position review detects lower-timeframe invalidation and recalculates the plan', () => {
  const item = {
    trend: 'up',
    reason: 'HH + HL',
    price: 103,
    lastCandle: candle(START, 106, 107, 102, 103),
    candleSignal: null,
    structure: {
      high: { current: { price: 120 } },
      low: { current: { price: 100 } },
    },
    zones: {
      demand: { type: 'demand', low: 100, high: 105 },
      unfilledSupply: [{ type: 'supply', low: 140, high: 145 }],
    },
  }
  const review = reviewOpenPosition({
    position: { id: 'PA-1', side: 'long', timeframeId: '4h' },
    item,
    lowerItem: {
      trend: 'down',
      event: 'CHoCH_DOWN',
      structure: { low: { current: { price: 101.5 } } },
    },
    lowerTimeframeId: '1h',
    settings: { pullbackPct: 50, minRewardRisk: 2, riskPct: 1, stopBufferPct: 0.02 },
  })
  assert.equal(review.invalidated, true)
  assert.equal(review.lowerTimeframeInvalidated, true)
  assert.equal(review.invalidatingTimeframeId, '1h')
  assert.equal(review.closeTrigger, 101.5)
  assert.equal(review.currentProfile.side, 'long')
  assert.equal(review.revisedProfile.side, 'short')
})

test('price-action matrix covers BTCUSD and major FX pairs on 1H, 4H and 1D', async () => {
  const btcHourly = Array.from({ length: 240 }, (_, index) =>
    candle(START + index * HOUR, 100 + index * 0.2, 101 + index * 0.2, 99 + index * 0.2, 100.5 + index * 0.2)
  )
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      chart: {
        result: [
          {
            timestamp: Array.from({ length: 240 }, (_, index) => Math.round((START + index * HOUR) / 1000)),
            indicators: {
              quote: [
                {
                  open: Array.from({ length: 240 }, (_, index) => 1 + index * 0.001),
                  high: Array.from({ length: 240 }, (_, index) => 1.01 + index * 0.001),
                  low: Array.from({ length: 240 }, (_, index) => 0.99 + index * 0.001),
                  close: Array.from({ length: 240 }, (_, index) => 1.005 + index * 0.001),
                  volume: Array.from({ length: 240 }, () => 0),
                },
              ],
            },
          },
        ],
      },
    }),
    text: async () => 'Exceeded',
  })

  const matrix = await buildPriceActionMatrix({
    btcHourly,
    fetchImpl,
    now: START + 240 * HOUR,
    settings: { refreshMinutes: 0, minCandles: 20 },
    logger: { warn() {} },
  })

  assert.equal(matrix.assets.length, PRICE_ACTION_ASSETS.length)
  assert.ok(matrix.assets.some((asset) => asset.symbol === 'BTCUSD'))
  assert.ok(matrix.assets.some((asset) => asset.symbol === 'EURUSD'))
  for (const asset of matrix.assets) {
    assert.deepEqual(Object.keys(asset.trends), ['1h', '4h', '1d'])
    for (const timeframe of PRICE_ACTION_TIMEFRAMES) {
      const item = asset.trends[timeframe.id]
      for (const [type, key] of [['demand', 'unfilledDemand'], ['supply', 'unfilledSupply']]) {
        const zones = item.zones?.[key]
        assert.ok(Array.isArray(zones), `${asset.symbol} ${timeframe.id}: ${key} must be published`)
        for (const zone of zones) {
          assert.equal(zone.type, type, `${asset.symbol} ${timeframe.id}: zone side must stay intact`)
          assert.ok(zone.high > zone.low, `${asset.symbol} ${timeframe.id}: FVG bounds must retain their raw order`)
          assert.equal(zone.fvg?.definingCandles?.length, 3, `${asset.symbol} ${timeframe.id}: every zone must come from exactly three candles`)
        }
      }
      const range = item.structure.activeRange
      if (!range) continue
      assert.ok(range.high.price > range.low.price, `${asset.symbol} ${timeframe.id}: active range must have positive height`)
      if (item.trend === 'up') {
        assert.equal(range.high.label, 'HH', `${asset.symbol} ${timeframe.id}: up range ends at HH`)
        assert.equal(range.low.label, range.source === 'external-break-of-structure' ? 'LL' : 'HL', `${asset.symbol} ${timeframe.id}: up range has a valid origin`)
        assert.ok(range.low.time < range.high.time, `${asset.symbol} ${timeframe.id}: up range is chronological`)
      }
      if (item.trend === 'down') {
        assert.equal(range.high.label, range.source === 'external-break-of-structure' ? 'HH' : 'LH', `${asset.symbol} ${timeframe.id}: down range has a valid origin`)
        assert.equal(range.low.label, 'LL', `${asset.symbol} ${timeframe.id}: down range ends at LL`)
        assert.ok(range.high.time < range.low.time, `${asset.symbol} ${timeframe.id}: down range is chronological`)
      }
    }
  }
  // No local swing classifier may fill in an unavailable external reference.
  assert.equal(matrix.assets[0].trends['1h'].trend, 'flat')
  assert.equal(matrix.assets[0].trends['1h'].structure.lookback, null)
  assert.equal(matrix.assets[0].trends['1h'].structure.source, 'external-confirmed-pivots')
  assert.equal(matrix.assets[0].trends['1h'].structure.historyDays, 30)
  assert.equal(matrix.assets[0].trends['1h'].structure.zoneHistoryDays, 120)
  assert.equal(matrix.assets[0].trends['4h'].trend, 'flat')
  assert.equal(matrix.assets[0].trends['4h'].structure.lookback, null)
  assert.equal(matrix.assets[0].trends['4h'].structure.historyDays, 180)
  assert.equal(matrix.assets[0].trends['4h'].structure.zoneHistoryDays, 365)
  assert.equal(matrix.assets[0].trends['4h'].structure.zoneMaxAgeCandles, 2190)
  assert.ok(matrix.assets[0].trends['4h'].zones)
  assert.ok(matrix.assets[0].trends['4h'].tradeProfile)
  assert.ok(Array.isArray(matrix.assets[0].trends['4h'].structure.chartPivots))
  assert.ok(matrix.assets[0].trends['4h'].chartCandles.length <= PRICE_ACTION_CHART_CANDLE_LIMITS['4h'])
})

test('fresh price-action matrix is reused instead of refetching every bot pass', async () => {
  const previous = {
    schemaVersion: PRICE_ACTION_MATRIX_SCHEMA,
    generatedAt: new Date(START).toISOString(),
    assets: PRICE_ACTION_ASSETS.map((asset) => ({
      symbol: asset.symbol,
      trends: {
        '1h': { structure: { chartPivots: [] }, chartCandles: [], tradeProfile: { zoneCandidates: [] } },
        '4h': { structure: { chartPivots: [] }, chartCandles: [], tradeProfile: { zoneCandidates: [] } },
        '1d': { structure: { chartPivots: [] }, chartCandles: [], tradeProfile: { zoneCandidates: [] } },
      },
    })),
  }
  const matrix = await buildPriceActionMatrix({
    previous,
    now: START + 10 * 60_000,
    settings: { refreshMinutes: 60 },
    fetchImpl: async () => {
      throw new Error('should not fetch')
    },
  })
  assert.equal(matrix, previous)
})

test('stored hourly price-action refresh is capped so entry profiles are checked every 15 minutes', async () => {
  const previous = {
    schemaVersion: PRICE_ACTION_MATRIX_SCHEMA,
    generatedAt: new Date(START).toISOString(),
    assets: PRICE_ACTION_ASSETS.map((asset) => ({
      symbol: asset.symbol,
      trends: {
        '1h': { structure: { chartPivots: [] }, chartCandles: [], tradeProfile: { zoneCandidates: [] } },
        '4h': { structure: { chartPivots: [] }, chartCandles: [], tradeProfile: { zoneCandidates: [] } },
        '1d': { structure: { chartPivots: [] }, chartCandles: [], tradeProfile: { zoneCandidates: [] } },
      },
    })),
  }
  const btcHourly = Array.from({ length: 240 }, (_, index) =>
    candle(START + index * HOUR, 100 + index * 0.2, 101 + index * 0.2, 99 + index * 0.2, 100.5 + index * 0.2)
  )
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      chart: {
        result: [
          {
            timestamp: Array.from({ length: 240 }, (_, index) => Math.round((START + index * HOUR) / 1000)),
            indicators: {
              quote: [
                {
                  open: Array.from({ length: 240 }, (_, index) => 1 + index * 0.001),
                  high: Array.from({ length: 240 }, (_, index) => 1.01 + index * 0.001),
                  low: Array.from({ length: 240 }, (_, index) => 0.99 + index * 0.001),
                  close: Array.from({ length: 240 }, (_, index) => 1.005 + index * 0.001),
                  volume: Array.from({ length: 240 }, () => 0),
                },
              ],
            },
          },
        ],
      },
    }),
    text: async () => 'Exceeded',
  })

  const matrix = await buildPriceActionMatrix({
    btcHourly,
    previous,
    now: START + 20 * 60_000,
    settings: { refreshMinutes: 60, minCandles: 20 },
    fetchImpl,
    logger: { warn() {} },
  })
  assert.notEqual(matrix, previous)
  assert.equal(matrix.refreshMinutes, 15)
})

test('a fresh but schema-old matrix is rebuilt so the UI can show pivot details', async () => {
  const previous = { generatedAt: new Date(START).toISOString(), assets: [{ symbol: 'BTCUSD', trends: { '4h': { trend: 'up' } } }] }
  const btcHourly = Array.from({ length: 240 }, (_, index) =>
    candle(START + index * HOUR, 100 + index * 0.2, 101 + index * 0.2, 99 + index * 0.2, 100.5 + index * 0.2)
  )
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      chart: {
        result: [
          {
            timestamp: Array.from({ length: 240 }, (_, index) => Math.round((START + index * HOUR) / 1000)),
            indicators: {
              quote: [
                {
                  open: Array.from({ length: 240 }, (_, index) => 1 + index * 0.001),
                  high: Array.from({ length: 240 }, (_, index) => 1.01 + index * 0.001),
                  low: Array.from({ length: 240 }, (_, index) => 0.99 + index * 0.001),
                  close: Array.from({ length: 240 }, (_, index) => 1.005 + index * 0.001),
                  volume: Array.from({ length: 240 }, () => 0),
                },
              ],
            },
          },
        ],
      },
    }),
    text: async () => 'Exceeded',
  })

  const matrix = await buildPriceActionMatrix({
    btcHourly,
    previous,
    fetchImpl,
    now: START + 10 * 60_000,
    settings: { refreshMinutes: 60, minCandles: 20 },
    logger: { warn() {} },
  })
  assert.notEqual(matrix, previous)
  assert.ok(matrix.assets[0].trends['4h'].structure)
})
