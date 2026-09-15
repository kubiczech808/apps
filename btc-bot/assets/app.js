/* BTC leveraged-momentum bot dashboard.
 *
 * A reader with no build step: the page fetches one JSON document from api.php
 * and renders it. Every write goes back through the same endpoint with the
 * shared key, which is kept in this browser's localStorage and nowhere else.
 *
 * The dashboard never decides anything. It shows what the bot published and
 * queues operator commands the next pass carries out — so what you see here and
 * what the exchange holds cannot drift apart through this page.
 */

'use strict'

const KEY_STORAGE = 'btc-bot-key'
const STRATEGY_VIEW_STORAGE = 'btc-bot-strategy-view-v2'
const REFRESH_MS = 30_000
const SATS_PER_BTC = 1e8
const DECISION_SIGNAL_STATES = new Set(['met', 'unmet', 'neutral'])
const SVG_NS = 'http://www.w3.org/2000/svg'
const SVG_TAGS = new Set(['circle', 'line', 'path', 'rect', 'svg', 'text'])

const $ = (id) => document.getElementById(id)

let state = null
let keyIsPublic = false
let refreshTimer = null
let priceActionSelection = null
let priceActionDecisionTimeframe = '4h'
let selectedAssetChart = { symbol: null, timeframeId: '4h' }
let selectedStrategyPanel = 'structure'
let selectedStrategyView = 'price-action'

// ── formatting ────────────────────────────────────────────────────────────

const nf = (digits) => new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const sats = (value) => (Number.isFinite(value) ? `${nf(0).format(Math.round(value))} sats` : '–')
const usd = (value) => (Number.isFinite(value) ? `$${nf(0).format(Math.round(value))}` : '–')
const price = (value) => (Number.isFinite(value) ? nf(0).format(Math.round(value)) : '–')
const pct = (value, digits = 1) => (Number.isFinite(value) ? `${nf(digits).format(value)} %` : '–')
const quotePrice = (value) => {
  if (!Number.isFinite(value)) return '–'
  const abs = Math.abs(value)
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 2 : 3
  return nf(digits).format(value)
}

const quoteCurrency = (symbol) => symbol?.startsWith('USD') ? symbol.slice(3) : 'USD'
const assetPriceLabel = (symbol, value) => Number.isFinite(value) ? `${quotePrice(value)} ${quoteCurrency(symbol)}` : '–'

const signedPct = (value, digits = 2) => {
  if (!Number.isFinite(value)) return { text: '–', className: '' }
  const text = `${value > 0 ? '+' : value < 0 ? '−' : ''}${nf(digits).format(Math.abs(value))} %`
  return { text, className: value > 0 ? 'pos' : value < 0 ? 'neg' : '' }
}

const when = (value) => {
  if (!value) return '–'
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
  if (Number.isNaN(date.getTime())) return '–'
  return date.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const dateOnly = (value) => {
  if (!value) return '–'
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
  if (Number.isNaN(date.getTime())) return '–'
  return date.toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit' })
}

const calendarDate = (value) => {
  if (!value) return '–'
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value))
  if (Number.isNaN(date.getTime())) return '–'
  return date.toLocaleDateString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

const ago = (value) => {
  if (!value) return 'nikdy'
  const then = typeof value === 'number' ? value : Date.parse(value)
  if (Number.isNaN(then)) return 'nikdy'
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 90) return `před ${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `před ${minutes} min`
  return `před ${Math.round(minutes / 60)} h`
}

/** P/L always carries its sign, so the colour is never the only signal. */
const signedSats = (value) => {
  if (!Number.isFinite(value)) return { text: '–', className: '' }
  const rounded = Math.round(value)
  const text = `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${nf(0).format(Math.abs(rounded))} sats`
  return { text, className: rounded > 0 ? 'pos' : rounded < 0 ? 'neg' : '' }
}

const el = (tag, attributes = {}, children = []) => {
  const node = SVG_TAGS.has(tag)
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'className') {
      if (node.namespaceURI === SVG_NS) node.setAttribute('class', value)
      else node.className = value
    }
    else if (name === 'text') node.textContent = value
    else if (value !== null && value !== undefined) node.setAttribute(name, value)
  }
  for (const child of [].concat(children)) {
    if (child !== null && child !== undefined) node.append(child)
  }
  return node
}

const decisionFact = (text, status = 'neutral', title = null) => ({
  text,
  status: DECISION_SIGNAL_STATES.has(status) ? status : 'neutral',
  title,
})

const decisionFactElement = (fact) =>
  el('span', {
    className: `fact fact-${fact.status}`,
    text: fact.text,
    title: fact.title,
  })

// ── strategy doctrine ────────────────────────────────────────────────────

const fact = (status, text, title = null) => decisionFact(text, status, title)

const decisionContext = () => state?.lastDecision?.context ?? {}

const STRATEGY_RULEBOOK = [
  {
    title: 'Obchodujeme jen dlouhodobou sílu',
    text: 'Portfolio je long-only a nový vstup povolí jen tehdy, když je BTC nad svým 100denním průměrem.',
    status: () => {
      const context = decisionContext()
      if (!Number.isFinite(context.dailyClose) || !Number.isFinite(context.regimeMa)) return fact('neutral', 'čeká na 100D průměr')
      return fact(context.dailyClose >= context.regimeMa ? 'met' : 'unmet', context.dailyClose >= context.regimeMa ? 'nad 100D MA' : 'pod 100D MA')
    },
  },
  {
    title: 'Vstup spouští nový 20denní breakout',
    text: 'Nestačí být nad kanálem. Denní svíčka musí právě uzavřít nad nejvyšším high předchozích 20 dnů.',
    status: () => {
      const context = decisionContext()
      if (!Number.isFinite(context.dailyClose) || !Number.isFinite(context.channelHigh)) return fact('neutral', 'kanál se načítá')
      const broken = context.dailyClose > context.channelHigh
      return fact(broken ? 'met' : 'unmet', broken ? '20D high proraženo' : 'uvnitř 20D kanálu')
    },
  },
  {
    title: 'Stop určuje volatilita',
    text: 'Po vstupu leží počáteční stop jeden denní ATR od ceny. Neutahuje se dovnitř běžného denního šumu.',
    status: () => {
      const context = decisionContext()
      if (!Number.isFinite(context.dailyAtr) || !Number.isFinite(context.price)) return fact('neutral', 'čeká na ATR')
      return fact('met', `1 ATR = ${pct((context.dailyAtr / context.price) * 100, 2)}`)
    },
  },
  {
    title: 'Velikost pozice vychází ze stopu',
    text: 'Množství kontraktů se dopočítá tak, aby zásah počátečního stopu stál nejvýše 2 % účtu v sats.',
    status: () => {
      const plan = state?.lastDecision?.plan
      if (!plan) return fact('neutral', 'počítá se při signálu')
      return fact('met', `risk ${pct(state?.settings?.risk?.riskPct ?? 2)}`)
    },
  },
  {
    title: 'Páka následuje stop',
    text: 'Páka není cíl. Volí se až po stopu, nejvýše 10x, a likvidace musí být nejméně dvakrát dál než stop.',
    status: () => {
      const plan = state?.lastDecision?.plan
      if (!Number.isFinite(plan?.leverage)) return fact('neutral', 'určí se při signálu')
      const safe = plan.side === 'long' ? plan.liquidation < plan.stop : plan.liquidation > plan.stop
      return fact(safe ? 'met' : 'unmet', `${plan.leverage}x · likv. ${price(plan.liquidation)}`)
    },
  },
  {
    title: 'Profit necháváme růst',
    text: 'Stop se posouvá pouze ve prospěch pozice podle 10denního minima. Vzdálený TP je nouzový bracket, ne běžný výstup.',
    status: () => {
      const running = state?.positions?.running ?? []
      return running.length ? fact('met', '10D trailing aktivní') : fact('neutral', 'bez otevřené pozice')
    },
  },
  {
    title: 'Funding patří do výsledku',
    text: 'Pákový paper účet účtuje skutečné osmihodinové funding sazby. Strategie byla testovaná na 5 410 settlements.',
    status: () => {
      return state?.settings?.risk?.market === 'futures' ? fact('met', 'funding započten') : fact('unmet', 'není futures režim')
    },
  },
  {
    title: 'Riziko řídí účet, ne názor',
    text: 'Každý obchod má předem daný SL, TP, maximální risk a portfolio gate. Otevřená pozice se nesmí nechat bez ochrany.',
    status: () => {
      const gates = state?.lastDecision?.gates ?? []
      if (gates.length) return fact('unmet', 'gate blokuje')
      if (state?.settings?.enabled === false) return fact('unmet', 'pozastaveno')
      return fact('met', 'risk gate OK')
    },
  },
  {
    title: 'Strategie musí být měřená mimo jeden hezký úsek',
    text: 'Cílem je stabilita: více oken, out-of-sample, paper monitoring, drawdown a výkonnost po poplatcích.',
    status: () => {
      const trades = Number(state?.stats?.trades ?? 0)
      if (trades < 30) return fact('neutral', `${trades} obchodů`)
      const pf = Number(state?.stats?.profitFactor)
      return fact(Number.isFinite(pf) && pf >= 1 ? 'met' : 'unmet', Number.isFinite(pf) ? `PF ${nf(2).format(pf)}` : `${trades} obchodů`)
    },
  },
]

const PRICE_ACTION_RULEBOOK = [
  {
    title: 'Struktura vede směr obchodu',
    text: 'Long vzniká jen z HH/HL, short jen z LH/LL; flat struktura zůstává bez setupu.',
    status: () => {
      const count = priceActionSummary().directional.length
      return fact(count ? 'met' : 'neutral', `${count} směrových profilů`)
    },
  },
  {
    title: 'Vstup pouze ve správné supply/demand zóně',
    text: 'Stačí hit ceny do zóny; close uvnitř není podmínka. Zóna se invaliduje jen close průrazem na vlastním timeframe.',
    status: () => {
      const hit = priceActionProfiles().filter((entry) => entry.profile.zoneHit).length
      return fact(hit ? 'met' : 'neutral', `${hit} hitů zóny`)
    },
  },
  {
    title: 'Pullback nejdříve od 50 % hlavní vlny',
    text: 'Setup nehoní cenu u extrému. Čeká na návrat alespoň do poloviny poslední strukturální vlny.',
    status: () => {
      const passed = priceActionProfiles().filter((entry) =>
        entry.profile.gates?.some((gateItem) => gateItem.id === 'pullback' && gateItem.status === 'met')
      ).length
      return fact(passed ? 'met' : 'neutral', `${passed} pullbacků`)
    },
  },
  {
    title: 'Cíle a stop musí dát nejméně 2R',
    text: 'TP1 leží na posledním HH/LL, TP2 na nejbližší nevybrané opačné S/D zóně; risk je 1 % účtu.',
    status: () => {
      const passed = priceActionProfiles().filter((entry) =>
        entry.profile.gates?.some((gateItem) => gateItem.id === 'rr' && gateItem.status === 'met')
      ).length
      return fact(passed ? 'met' : 'neutral', `${passed} profilů >= 2R`)
    },
  },
  {
    title: 'Otevřené obchody se přehodnocují',
    text: 'Změna struktury se sleduje pouze u otevřeného PA obchodu. Zjištění se zapíše do logu a vytvoří nový návrh zóny, SL a TP.',
    status: () => {
      const events = state?.priceActionEvents?.length ?? 0
      return fact(events ? 'met' : 'neutral', events ? `${events} záznamů` : 'bez záznamu')
    },
  },
]

const STRATEGY_CANDIDATES = [
  {
    status: 'aktivní',
    statusKind: 'met',
    name: 'TF-2L Leveraged momentum',
    thesis: 'Selektivní long-only trend following. Čeká na nový 20denní breakout v dlouhodobém uptrendu a velikost pozice odvozuje od 1 ATR stopu.',
    rules: ['daily signál', '20D breakout', '100D trend', '1 ATR stop', '10D trail', '2 % risk', 'dynamická páka ≤10x'],
    backtest: {
      status: 'met',
      label: '5y + skutečný funding',
      result: '+7,1 % p.a. v sats',
      detail: '30 obchodů, PF 2,00, hodinový max DD 15,6 %. Poslední 3 roky +11,5 % p.a.; medián držení 12,7 dne, 90. percentil 40,3 dne.',
    },
    command:
      'node tools/backtest.mjs --strategy momentum --years 5 --source binance --set strategy.stopAtr=1,strategy.allowShorts=false,risk.market=futures,risk.riskPct=2',
  },
  {
    status: 'nová',
    statusKind: 'neutral',
    name: 'PA-1 Price Action Structure',
    thesis: 'Periodický price-action scanner pro BTCUSD a hlavní měnové páry. Čte vyšší swing strukturu, supply/demand zóny a pro každý timeframe skládá čerstvý obchodní profil s 50% pullbackem, SL a TP. Invalidaci vyhodnocuje až u otevřeného obchodu.',
    rules: ['BTCUSD + FX majors', '1H / 4H / 1D', 'HH/HL = up', 'LH/LL = down', 'S/D zóna', '50% pullback', 'R/R ≥ 2:1', 'risk 1 % účtu'],
    backtest: {
      status: 'neutral',
      label: 'čeká na backtest',
      result: 'profile-only',
      detail: 'Tato vrstva zatím sama neposílá ordery. Publikuje pravidlový trade profil, aby šlo následně měřit a ladit vstupy na více aktivech a timeframech.',
    },
    command:
      'node tools/backtest.mjs --strategy price-action-structure --asset EURUSD --timeframe 4h',
  },
]

const STRATEGY_VIEWS = {
  momentum: {
    id: 'momentum',
    label: 'TF-2L Momentum',
    title: 'BTC Leveraged Momentum',
    strategyName: 'TF-2L Leveraged momentum',
  },
  'price-action': {
    id: 'price-action',
    label: 'PA-1 Price Action',
    title: 'PA-1 Price Action Structure',
    strategyName: 'PA-1 Price Action Structure',
  },
}

const currentStrategyView = () => STRATEGY_VIEWS[selectedStrategyView] ?? STRATEGY_VIEWS.momentum

const PRICE_ACTION_TREND_LABELS = {
  up: 'up',
  down: 'down',
  flat: 'flat',
}

const priceActionProfiles = () => {
  const matrix = state?.priceActionMatrix
  const columns = matrix?.timeframes?.length ? matrix.timeframes : [
    { id: '1h', label: '1H' },
    { id: '4h', label: '4H' },
    { id: '1d', label: '1D' },
  ]
  return (matrix?.assets ?? [])
    .flatMap((asset) => columns.map((column) => {
      const item = asset.trends?.[column.id] ?? null
      return {
        asset,
        column,
        item,
        profile: item?.tradeProfile ?? null,
      }
    }))
    .filter((entry) => entry.profile)
}

const profileRank = (entry) => {
  if (entry.profile.status === 'ready') return 0
  if (entry.profile.status === 'watch') return 1
  return 2
}

const sortedPriceActionProfiles = () =>
  [...priceActionProfiles()].sort((a, b) =>
    profileRank(a) - profileRank(b) ||
    a.asset.symbol.localeCompare(b.asset.symbol) ||
    a.column.id.localeCompare(b.column.id)
  )

const priceActionSummary = () => {
  const profiles = priceActionProfiles()
  const ready = profiles.filter((entry) => entry.profile.status === 'ready')
  const watch = profiles.filter((entry) => entry.profile.status === 'watch')
  const directional = profiles.filter((entry) => entry.profile.side)
  return { profiles, ready, watch, directional }
}

const PRICE_ACTION_DECISION_COLUMNS = [
  { id: 'structure', label: 'Struktura' },
  { id: 'demand', label: 'Demand' },
  { id: 'supply', label: 'Supply' },
  { id: 'pullback', label: '50% pullback' },
  { id: 'entry', label: 'Entry' },
  { id: 'stop', label: 'SL' },
  { id: 'tp1', label: 'TP1' },
  { id: 'tp2', label: 'TP2' },
  { id: 'rr', label: 'R/R' },
]

const profileGate = (profile, id) => profile?.gates?.find((item) => item.id === id) ?? null

const zoneList = (item, type, { includeFilled = false } = {}) => {
  const key = type === 'demand' ? 'Demand' : 'Supply'
  const nearby = item?.zones?.[`nearby${key}`]
  const nearbyUnfilled = nearby?.filter((zone) => !zone.filledByOwnTimeframeClose) ?? []
  if (includeFilled && nearby?.length) return nearby
  if (nearbyUnfilled.length) return nearbyUnfilled
  const unfilled = item?.zones?.[`unfilled${key}`]
  if (unfilled?.length) return unfilled
  const fallback = item?.zones?.[type] ?? item?.zones?.[`latestValid${key}`]
  return fallback && (!fallback.filledByOwnTimeframeClose || includeFilled) ? [fallback] : []
}

const sameZone = (left, right) => {
  if (!left || !right || left.type !== right.type) return false
  const scale = Math.max(1, Math.abs(left.low), Math.abs(left.high), Math.abs(right.low), Math.abs(right.high))
  const tolerance = scale * 1e-9
  return Math.abs(left.low - right.low) <= tolerance && Math.abs(left.high - right.high) <= tolerance
}

const zoneCandidateFor = (candidates, zone, type, index = 0) => {
  const typed = candidates.filter((entry) => entry.type === type)
  const exact = typed.find((entry) => sameZone(entry.zone, zone))
  if (exact) return exact
  const overlapping = typed
    .filter((entry) => entry.zone?.low <= zone?.high && entry.zone?.high >= zone?.low)
    .sort((left, right) => {
      const leftDistance = Math.abs((left.zone.low ?? 0) - (zone.low ?? 0)) + Math.abs((left.zone.high ?? 0) - (zone.high ?? 0))
      const rightDistance = Math.abs((right.zone.low ?? 0) - (zone.low ?? 0)) + Math.abs((right.zone.high ?? 0) - (zone.high ?? 0))
      return leftDistance - rightDistance
    })
  return overlapping[0] ?? typed[index] ?? null
}

const zoneDefiningTimes = (zone, timeframeId) =>
  (zone?.definingCandles ?? [])
    .map((candle) => timeframeId === '1d' ? dateOnly(candle.time) : when(candle.time))
    .join('\n') || 'datum není k dispozici'

const zoneCandidateDetails = (candidate) => {
  if (!candidate) return null
  const rr = (value) => Number.isFinite(value) ? `${nf(2).format(value)}:1` : '–'
  const entryRange = candidate.entryRange
    ? `${quotePrice(candidate.entryRange.low)} – ${quotePrice(candidate.entryRange.high)}`
    : '–'
  return el('div', { className: 'zone-candidate-details' }, [
    el('strong', { text: candidate.eligible ? 'Vhodná pro aktuální vstup' : 'Vyřazena z aktuálního vstupu' }),
    el('span', { text: `Vstup při hitu kraje: ${quotePrice(candidate.entryAtZoneHit)}` }),
    el('span', { text: `Přípustný vstup v pullback pásmu: ${entryRange}` }),
    el('span', { text: `Vstup pro min. R/R: ${quotePrice(candidate.entryForMinRR)}` }),
    el('span', { text: `SL ${quotePrice(candidate.stop)} · TP1 ${quotePrice(candidate.tp1)} · TP2 ${quotePrice(candidate.tp2)}` }),
    el('span', { text: `R/R při hitu ${rr(candidate.rrAtZoneHit)} · při vstupu ${rr(candidate.rewardRisk)} · minimum ${rr(candidate.minRewardRisk)}` }),
    candidate.reason ? el('span', { className: 'zone-candidate-reason', text: candidate.reason }) : null,
  ])
}

const zoneRangeTrigger = ({ zone, status = 'neutral', title = null, timeframeId, candidate = null, showCandidateDetails = false }) => {
  const button = el('button', {
    type: 'button',
    className: `fact fact-${status} zone-range-trigger`,
    text: zoneRange(zone),
    title: title ?? 'Kliknutím zobrazit definiční svíčky zóny.',
    'aria-expanded': 'false',
  })
  const popup = el('div', { className: 'zone-date-popover', role: 'tooltip', hidden: true }, [
    el('span', { className: 'zone-date-values', text: zoneDefiningTimes(zone, timeframeId) }),
    showCandidateDetails ? zoneCandidateDetails(candidate) : null,
  ])
  button.onclick = () => {
    const open = popup.hidden
    popup.hidden = !open
    button.setAttribute('aria-expanded', String(open))
  }
  return el('div', { className: 'zone-range-control' }, [button, popup])
}

const zoneListElement = (item, profile, type, timeframeId) => {
  const active = profile?.side === 'long' ? 'demand' : profile?.side === 'short' ? 'supply' : null
  if (active !== type) return [decisionFactElement(decisionFact('–', 'neutral', 'Pro aktuální strukturu není tato strana vstupní zónou.'))]
  const candidates = (profile?.zoneCandidates ?? []).filter((candidate) => candidate.type === type && candidate.eligible)
  if (!candidates.length) return [decisionFactElement(decisionFact('–', 'neutral', 'Žádná zóna současně nesplňuje pullback a minimální R/R.'))]
  return candidates.map((candidate) => {
    const zone = candidate.zone
    const status = candidate.zoneHit ? 'met' : 'neutral'
    return el('div', { className: 'pa-zone-item' }, [
      zoneRangeTrigger({ zone, status, title: candidate.zoneHit ? 'Cena už zónu hitla.' : 'Validní zóna, čeká se na hit ceny.', timeframeId }),
    ])
  })
}

const priceFact = (value, title = null, status = 'neutral') =>
  decisionFact(Number.isFinite(value) ? quotePrice(value) : '–', status, title)

const passedOrWaiting = (gate) => gate?.status === 'met' ? 'met' : 'neutral'

const pullbackRange = (entry) => {
  const profile = entry?.profile
  const from = profile?.pullbackRange?.from ?? profile?.pullbackLevel
  const to = profile?.pullbackRange?.to ?? profile?.invalidationLevel ?? (
    profile?.side === 'long'
      ? entry?.item?.structure?.low?.current?.price
      : profile?.side === 'short'
        ? entry?.item?.structure?.high?.current?.price
        : null
  )
  return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null
}

const priceActionDecisionFact = (entry, column) => {
  const { item, profile } = entry
  if (!item && !profile) return decisionFact('čeká', 'neutral', 'Pro tento asset a timeframe zatím nejsou data.')

  switch (column.id) {
    case 'structure': {
      const trend = PRICE_ACTION_TREND_LABELS[item?.trend] || 'flat'
      const status = item?.trend === 'up' || item?.trend === 'down' ? 'met' : 'neutral'
      return decisionFact(trend, status, [item?.reason, item?.event].filter(Boolean).join(' · ') || null)
    }
    case 'demand':
      return null
    case 'supply':
      return null
    case 'pullback': {
      const gate = profileGate(profile, 'pullback')
      const range = pullbackRange(entry)
      return decisionFact(
        range ? `${quotePrice(range.from)} → ${quotePrice(range.to)}` : '–',
        passedOrWaiting(gate),
        gate?.detail ?? 'Vstup se čeká v pásmu od 50% pullbacku po invalidaci struktury.'
      )
    }
    case 'entry':
      return priceFact(
        profile?.entry,
        profile?.zoneHit ? 'Cena zasáhla pracovní zónu.' : 'Pracovní entry; čeká se na zásah správné zóny.',
        profile?.zoneHit ? 'met' : 'neutral'
      )
    case 'stop':
      return priceFact(profile?.stop, Number.isFinite(profile?.stopBuffer) ? `Za hranicí zóny, buffer ${quotePrice(profile.stopBuffer)}.` : 'Stop podle hranice pracovní zóny.')
    case 'tp1':
      return priceFact(profile?.tp1, profile?.tp1Rule ?? null)
    case 'tp2':
      return priceFact(profile?.tp2, profile?.tp2Rule ?? null)
    case 'rr': {
      const gate = profileGate(profile, 'rr')
      return decisionFact(
        Number.isFinite(profile?.rewardRisk) ? `${nf(2).format(profile.rewardRisk)}:1` : '–',
        passedOrWaiting(gate),
        gate?.detail ?? `Minimum je ${profile?.minRewardRisk ?? 2}:1.`
      )
    }
    default:
      return decisionFact('–', 'neutral')
  }
}

const priceActionDecisionCell = (entry, column) =>
    el('td', { className: `pa-decision-cell pa-decision-cell-${column.id}` },
    column.id === 'demand' || column.id === 'supply'
      ? zoneListElement(entry.item, entry.profile, column.id, entry.column.id)
      : [decisionFactElement(priceActionDecisionFact(entry, column))]
  )

const assetTickerButton = (symbol, timeframeId = priceActionDecisionTimeframe) => {
  const button = el('button', {
    type: 'button',
    className: 'asset-ticker',
    text: symbol,
    title: 'Zobrazit cenový graf assetu',
  })
  button.onclick = () => {
    selectedAssetChart = { symbol, timeframeId }
    renderAssetChart()
    $('asset-chart-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return button
}

const renderPriceActionDecisionTabs = (columns) => {
  const selected = columns.some((column) => column.id === priceActionDecisionTimeframe)
    ? priceActionDecisionTimeframe
    : columns.find((column) => column.id === '4h')?.id ?? columns[0]?.id
  priceActionDecisionTimeframe = selected
  return el('div', { className: 'pa-decision-tabs', role: 'tablist', 'aria-label': 'Timeframe price-action rozhodnutí' }, columns.map((column) => {
    const button = el('button', {
      type: 'button',
      className: 'pa-decision-tab',
      role: 'tab',
      'aria-selected': String(column.id === selected),
      text: column.label,
    })
    button.onclick = () => {
      priceActionDecisionTimeframe = column.id
      selectedAssetChart = { symbol: selectedAssetChart.symbol, timeframeId: column.id }
      renderDecision()
      renderAssetChart()
    }
    return button
  }))
}

const renderPriceActionDecisionTable = (matrix, columns) => {
  const timeframe = columns.find((column) => column.id === priceActionDecisionTimeframe) ?? columns[0]
  const table = el('table', { className: 'pa-decision-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Asset' }),
        ...PRICE_ACTION_DECISION_COLUMNS.map((column) => el('th', { text: column.label })),
      ]),
    ]),
    el('tbody'),
  ])
  const body = table.querySelector('tbody')
  for (const asset of matrix.assets) {
    const item = asset.trends?.[timeframe.id] ?? null
    const entry = { asset, column: timeframe, item, profile: item?.tradeProfile ?? null }
    body.append(el('tr', {}, [
      el('td', {}, [
        assetTickerButton(asset.symbol, timeframe.id),
        el('span', {
          className: 'asset-decision-price',
          text: assetPriceLabel(asset.symbol, item?.price),
        }),
      ]),
      ...PRICE_ACTION_DECISION_COLUMNS.map((column) => priceActionDecisionCell(entry, column)),
    ]))
  }
  return el('div', { className: 'table-scroll pa-decision-scroll' }, [table])
}

const trendFact = (trend, item = {}) => {
  const status = trend === 'up' ? 'met' : trend === 'down' ? 'unmet' : 'neutral'
  const label = PRICE_ACTION_TREND_LABELS[trend] || 'flat'
  const details = [item.reason, item.event, Number.isFinite(item.price) ? `cena ${quotePrice(item.price)}` : null]
    .filter(Boolean)
    .join(' · ')
  return decisionFact(label, status, details || null)
}

const trendFactButton = ({ asset, column, item }) => {
  const fact = trendFact(item.trend, item)
  const button = el('button', {
    type: 'button',
    className: `fact fact-${fact.status} pa-trend-button`,
    title: fact.title,
    text: fact.text,
  })
  const selected = priceActionSelection?.symbol === asset.symbol && priceActionSelection?.timeframeId === column.id
  button.setAttribute('aria-pressed', String(selected))
  button.onclick = () => {
    priceActionSelection = { symbol: asset.symbol, timeframeId: column.id }
    renderStrategyLab()
  }
  return button
}

const pivotText = (pivot) => {
  if (!pivot) return '–'
  const label = pivot.label ? `${pivot.label} ` : ''
  const close = Number.isFinite(pivot.close) ? ` / close ${quotePrice(pivot.close)}` : ''
  return `${label}knot ${quotePrice(pivot.price)}${close} · ${when(pivot.time)}`
}

const legCard = (title, leg, emptyText) =>
  el('div', { className: 'structure-leg' }, [
    el('strong', { text: title }),
    leg
      ? el('div', { className: 'structure-leg-flow' }, [
          el('span', { text: pivotText(leg.previous) }),
          el('span', { className: 'structure-arrow', text: '→' }),
          el('span', { text: pivotText(leg.current) }),
        ])
      : el('p', { text: emptyText }),
    leg
      ? el('span', {
          className: 'structure-meta',
          text: `${leg.label} podle close ${quotePrice(leg.confirmationClose)} vůči knotu ${quotePrice(leg.referencePrice)}${
            Number.isFinite(leg.changePct) ? ` · knot ${signedPct(leg.changePct).text}` : ''
          }`,
        })
      : null,
  ])

const zoneRange = (zone) => (zone ? `${quotePrice(zone.low)} – ${quotePrice(zone.high)}` : '–')

const zoneCard = (title, zones, emptyText, timeframeId, candidates = []) => el('div', { className: 'structure-leg zone-leg' }, [
    el('strong', { text: title }),
    zones?.length
      ? el('div', { className: 'zone-list' }, zones.map((zone, index) => el('div', { className: 'zone-item' }, [
          (() => {
            const candidate = zoneCandidateFor(candidates, zone, title.toLowerCase(), index)
            return el('div', { className: 'structure-leg-flow' }, [
              el('span', { className: 'zone-index', text: `${index + 1}.` }),
              zoneRangeTrigger({
                zone,
                timeframeId,
                candidate,
                status: candidate?.eligible ? (candidate.zoneHit ? 'met' : 'neutral') : 'neutral',
                title: candidate?.eligible ? 'Kliknutím zobrazit vstupní parametry.' : 'Kliknutím zobrazit důvod vyřazení a vstupní parametry.',
                showCandidateDetails: true,
              }),
              Number.isFinite(zone.distancePct)
                ? el('span', { className: 'structure-meta', text: `vzdál. ${signedPct(zone.distancePct).text}` })
                : null,
            ])
          })(),
          el('span', {
            className: 'structure-meta',
            text: [
              zone.filledByOwnTimeframeClose ? 'vyplněná close na vlastním TF' : 'nevyplněná',
              `touches ${zone.touches ?? 1}`,
              zone.swept ? 'sweep' : null,
              zone.imbalance ? 'imbalance' : null,
            ].filter(Boolean).join(' · '),
          }),
        ])))
      : el('p', { text: emptyText }),
  ])

const zonesForDetail = (zones, type) => {
  const list = zoneList({ zones }, type)
  return list
}

const renderZonesDetail = (zones, timeframeId, candidates = []) => {
  if (!zones) return null
  return el('div', { className: 'zone-detail' }, [
    el('strong', { text: 'Supply / demand zóny' }),
    el('div', { className: 'structure-legs' }, [
      zoneCard('Demand', zonesForDetail(zones, 'demand'), 'Žádná platná demand zóna na tomto timeframe.', timeframeId, candidates),
      zoneCard('Supply', zonesForDetail(zones, 'supply'), 'Žádná platná supply zóna na tomto timeframe.', timeframeId, candidates),
    ]),
    el('p', { className: 'zone-rule', text: zones.rule || 'Zóna se invaliduje jen na vlastním timeframe.' }),
  ])
}

const renderAssetZoneDetails = (host, asset, item, timeframeId) => {
  host.replaceChildren()
  if (!item?.zones) return
  const candidates = item.tradeProfile?.zoneCandidates ?? []
  host.append(
    el('div', { className: 'asset-zone-details' }, [
      el('h3', { text: `${asset.symbol} · všechny dostupné zóny pro ${timeframeId.toUpperCase()}` }),
      el('p', { className: 'asset-zone-details-intro', text: 'V přehledu vstupu zůstávají jen zóny v pullback pásmu s dosažitelným minimálním R/R. Zde jsou i zóny, které byly vyřazeny.' }),
      el('div', { className: 'asset-zone-detail-columns' }, [
        zoneCard('Demand', zonesForDetail(item.zones, 'demand'), 'Žádná dostupná demand zóna.', timeframeId, candidates),
        zoneCard('Supply', zonesForDetail(item.zones, 'supply'), 'Žádná dostupná supply zóna.', timeframeId, candidates),
      ]),
    ])
  )
}

const tradeStatusFact = (profile) => {
  const status = profile?.status === 'ready' ? 'met' : profile?.status === 'watch' ? 'neutral' : 'neutral'
  const label = profile?.status === 'ready' ? 'setup ready' : profile?.status === 'watch' ? 'čeká' : 'bez setupu'
  return decisionFact(label, status)
}

const tradeMetric = (label, value, sub = null) =>
  el('div', { className: 'trade-metric' }, [
    el('span', { text: label }),
    el('strong', { text: value }),
    sub ? el('em', { text: sub }) : null,
  ])

const renderTradeProfile = (profile) => {
  if (!profile) return null
  const side = profile.side === 'long' ? 'long' : profile.side === 'short' ? 'short' : '–'
  const rr = Number.isFinite(profile.rewardRisk) ? `${nf(2).format(profile.rewardRisk)}:1` : '–'
  return el('div', { className: 'trade-profile' }, [
    el('div', { className: 'trade-profile-head' }, [
      el('div', {}, [
        el('strong', { text: 'Periodický trade profil' }),
        el('p', { text: `Risk ${pct(profile.riskPct, 1)} účtu · vstup jen od ${profile.pullbackPct ?? 50}% pullbacku a pouze v S/D zóně` }),
      ]),
      decisionFactElement(tradeStatusFact(profile)),
    ]),
    el('div', { className: 'decision-facts trade-gates' }, profile.gates?.map((item) =>
      decisionFactElement(decisionFact(item.label, item.status, item.detail))
    ) ?? []),
    el('div', { className: 'trade-metrics' }, [
      tradeMetric('Směr', side),
      tradeMetric('Entry', quotePrice(profile.entry), profile.zoneHit ? 'cena hitla zónu' : 'čeká na hit zóny'),
      tradeMetric('SL', quotePrice(profile.stop), Number.isFinite(profile.stopBuffer) ? `buffer ${quotePrice(profile.stopBuffer)}` : null),
      tradeMetric('TP1', quotePrice(profile.tp1), profile.tp1Rule),
      tradeMetric('TP2', quotePrice(profile.tp2), profile.tp2Rule),
      tradeMetric('R/R', rr, `minimum ${profile.minRewardRisk ?? 2}:1`),
    ]),
    profile.zone
      ? el('p', { className: 'trade-note', text: `Pracovní zóna: ${profile.zone.type} ${zoneRange(profile.zone)}` })
      : el('p', { className: 'trade-note', text: 'Bez platné pracovní supply/demand zóny.' }),
    profile.refinement
      ? el('p', {
          className: `trade-note trade-note-${profile.refinement.status}`,
          text: `Svíčkové zpřesnění: ${profile.refinement.pattern || 'bez patternu'} · ${profile.refinement.note}`,
        })
      : null,
  ])
}

const renderStructureDetail = ({ matrix, columns }) => {
  const selected =
    matrix.assets
      .flatMap((asset) => columns.map((column) => ({ asset, column, item: asset.trends?.[column.id] })))
      .find((entry) =>
        priceActionSelection
          ? entry.asset.symbol === priceActionSelection.symbol && entry.column.id === priceActionSelection.timeframeId
          : entry.column.id === '4h'
      ) ?? null
  if (!selected?.item) return null

  const { asset, column, item } = selected
  priceActionSelection ??= { symbol: asset.symbol, timeframeId: column.id }
  const structure = item.structure ?? {}
  const recent = structure.recentSwings ?? []
  const trendShift = item.establishedTrend && item.establishedTrend !== item.trend
    ? ` · změna z ${PRICE_ACTION_TREND_LABELS[item.establishedTrend] || item.establishedTrend}`
    : ''

  return el('div', { className: 'structure-detail' }, [
    el('div', { className: 'structure-detail-head' }, [
      el('div', {}, [
        el('strong', { text: `${asset.symbol} · ${column.label}` }),
        el('p', { text: `${PRICE_ACTION_TREND_LABELS[item.trend] || 'flat'}${trendShift} · ${item.reason || 'bez důvodu'}` }),
      ]),
      decisionFactElement(trendFact(item.trend, item)),
    ]),
    el('div', { className: 'structure-legs' }, [
      legCard('Swing highs', structure.high, 'Zatím nejsou dva potvrzené swing highs.'),
      legCard('Swing lows', structure.low, 'Zatím nejsou dva potvrzené swing lows.'),
    ]),
    renderZonesDetail(item.zones, column.id, item.tradeProfile?.zoneCandidates ?? []),
    renderTradeProfile(item.tradeProfile),
    el('div', { className: 'structure-meta-line' }, [
      el('span', { text: `${item.candles ?? 0} svíček` }),
      el('span', { text: `${structure.swingCount ?? 0} potvrzených swingů` }),
      Number.isFinite(structure.from) && Number.isFinite(structure.to)
        ? el('span', { text: `období ${calendarDate(structure.from)} → ${calendarDate(structure.to)}` })
        : null,
      structure.historyDays ? el('span', { text: `horizont ${structure.historyDays} dní` }) : null,
      el('span', { text: `hlavní pivot ±${structure.lookback ?? '–'} svíček` }),
      el('span', { text: `zóny ±${structure.zoneLookback ?? '–'} svíčky` }),
      Number.isFinite(item.price) ? el('span', { text: assetPriceLabel(asset.symbol, item.price) }) : null,
    ]),
    structure.contextHigh && structure.contextLow
      ? el('p', {
          className: 'zone-rule',
          text: `Rozsah období: high ${quotePrice(structure.contextHigh.price)} (${calendarDate(structure.contextHigh.time)}) · low ${quotePrice(structure.contextLow.price)} (${calendarDate(structure.contextLow.time)})`,
        })
      : null,
    recent.length
      ? el('div', { className: 'recent-swings' }, [
          el('strong', { text: 'Poslední potvrzené swingy · hlavní' }),
          el('div', { className: 'recent-swing-list' }, recent.map((swing) =>
            el('span', {
              className: `swing-pill swing-${swing.kind}`,
              text: `${swing.kind === 'high' ? 'H' : 'L'} ${quotePrice(swing.price)} · ${when(swing.time)}`,
            })
          )),
        ])
      : null,
  ])
}

// ── api ───────────────────────────────────────────────────────────────────

const getKey = () => {
  try {
    return localStorage.getItem(KEY_STORAGE) || ''
  } catch {
    return ''
  }
}

const setKey = (value) => {
  try {
    if (value) localStorage.setItem(KEY_STORAGE, value)
    else localStorage.removeItem(KEY_STORAGE)
  } catch {
    /* private browsing: the key simply does not persist */
  }
}

const getStrategyView = () => {
  try {
    return localStorage.getItem(STRATEGY_VIEW_STORAGE) || 'price-action'
  } catch {
    return 'price-action'
  }
}

const setStrategyView = (value) => {
  selectedStrategyView = STRATEGY_VIEWS[value] ? value : 'price-action'
  try {
    localStorage.setItem(STRATEGY_VIEW_STORAGE, selectedStrategyView)
  } catch {
    /* private browsing: selection simply does not persist */
  }
}

const api = async (action, { method = 'GET', body, key = getKey() } = {}) => {
  const response = await fetch(`api.php?action=${action}&t=${Date.now()}`, {
    method,
    headers: {
      Accept: 'application/json',
      'X-Bot-Key': key,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return payload
}

// ── notices ───────────────────────────────────────────────────────────────

const renderNotices = () => {
  const box = $('notices')
  box.replaceChildren()
  if (!state) return

  const notices = []
  const settings = state.settings || {}

  if (state.mode === 'mainnet') {
    notices.push(['bad', 'Ostrý provoz: obchody se otevírají za skutečné sats.'])
  }
  if (keyIsPublic) {
    notices.push([
      '',
      'Přístupový klíč je veřejně v repozitáři, takže ostrý provoz je zamčený. ' +
        'Pro obchodování za skutečné sats nastav secret BTC_BOT_KEY a nasaď znovu.',
    ])
  }
  if (state.modeRefusal) {
    notices.push(['bad', `Bot odmítl ostrý provoz a zůstal na paper: ${state.modeRefusal}`])
  }
  if (settings.enabled === false) {
    notices.push(['', 'Automatické obchodování je pozastavené — nové vstupy se neotevírají.'])
  }
  if (state.status === 'error') {
    const failed = (state.runs || []).find((run) => run.error)
    notices.push(['bad', `Poslední běh skončil chybou: ${failed ? failed.error : 'neznámá chyba'}`])
  }

  const updated = state.updatedAt ? Date.parse(state.updatedAt) : NaN
  if (Number.isFinite(updated) && Date.now() - updated > 20 * 60_000) {
    notices.push(['bad', `Stav je starý ${ago(state.updatedAt)} — runner pravděpodobně neběží.`])
  }

  const stuck = (state.runs || [])
    .flatMap((run) => run.brackets || [])
    .filter((action) => action.action === 'unprotected_and_stuck')
  if (stuck.length) {
    notices.push(['bad', `Pozice bez ochrany, kterou se nepodařilo zavřít: ${stuck.map((a) => a.id).join(', ')}`])
  }

  for (const [kind, message] of notices) {
    box.append(el('div', { className: `notice ${kind}`.trim(), text: message }))
  }
}

// ── tiles ─────────────────────────────────────────────────────────────────

const tile = (label, value, sub, className = '') =>
  el('div', { className: 'tile' }, [
    el('div', { className: 'label', text: label }),
    el('div', { className: `value ${className}`.trim(), text: value }),
    el('div', { className: 'sub', text: sub ?? '' }),
  ])

const firstPositiveEquitySats = () =>
  (state?.equityHistory || []).find((point) => Number.isFinite(point.equitySats) && point.equitySats > 0)
    ?.equitySats ?? null

const capitalBenchmark = ({ account, market, stats }) => {
  const startUsd = Number(state?.settings?.startingCapitalUsd)
  const currentSats = Number(account?.equitySats)
  const currentBtcPrice = Number(market?.price)
  const paperStartSats = Number(state?.paper?.startingBalanceSats)
  const inferredStartSats =
    Number.isFinite(currentSats) && Number.isFinite(stats?.netPnlSats)
      ? currentSats - stats.netPnlSats
      : null
  const startSats =
    firstPositiveEquitySats() ??
    (Number.isFinite(paperStartSats) && paperStartSats > 0 ? paperStartSats : null) ??
    (Number.isFinite(inferredStartSats) && inferredStartSats > 0 ? inferredStartSats : null)
  const startBtcPrice =
    Number.isFinite(startUsd) && startUsd > 0 && Number.isFinite(startSats) && startSats > 0
      ? (startUsd * SATS_PER_BTC) / startSats
      : null
  const equityUsd =
    Number.isFinite(currentSats) && Number.isFinite(currentBtcPrice)
      ? (currentSats / SATS_PER_BTC) * currentBtcPrice
      : null

  return {
    equityUsd,
    usdReturnPct:
      Number.isFinite(equityUsd) && Number.isFinite(startUsd) && startUsd > 0
        ? ((equityUsd / startUsd) - 1) * 100
        : null,
    btcReturnPct:
      Number.isFinite(currentBtcPrice) && Number.isFinite(startBtcPrice) && startBtcPrice > 0
        ? ((currentBtcPrice / startBtcPrice) - 1) * 100
        : null,
    satsReturnPct:
      Number.isFinite(currentSats) && Number.isFinite(startSats) && startSats > 0
        ? ((currentSats / startSats) - 1) * 100
        : null,
  }
}

const renderPortfolioTiles = (box) => {
  const account = state.account || {}
  const stats = state.stats || {}
  const market = state.market || {}
  const running = state.positions?.running || []

  const btcPrice = market.price
  const benchmark = capitalBenchmark({ account, market, stats })
  const equityUsd = benchmark.equityUsd
  const usdReturn = signedPct(benchmark.usdReturnPct)
  const btcReturn = signedPct(benchmark.btcReturnPct)
  const satsReturn = signedPct(benchmark.satsReturnPct)

  const openRisk = running.reduce((sum, position) => {
    if (!Number.isFinite(position.entry) || !Number.isFinite(position.stopLoss)) return sum
    const perUsd = Math.abs(1 / position.stopLoss - 1 / position.entry)
    return sum + (position.quantityUsd || 0) * SATS_PER_BTC * perUsd
  }, 0)

  const openPl = running.reduce((sum, position) => sum + (position.plSats || 0), 0)

  const biasLabel = { up: 'vzestupný', down: 'sestupný', range: 'do strany' }[market.bias] || '–'

  box.append(
    tile('Kapitál', sats(account.equitySats), equityUsd === null ? '–' : `≈ ${usd(equityUsd)}`),
    tile(
      'Výkon od startu',
      Number.isFinite(benchmark.usdReturnPct) ? `USD ${usdReturn.text}` : '–',
      `BTC ${btcReturn.text} · obchody ${satsReturn.text} v sats`,
      usdReturn.className
    ),
    tile(
      'Otevřené riziko',
      running.length ? sats(openRisk) : '0 sats',
      `${running.length} ${running.length === 1 ? 'pozice' : 'pozic'} v trhu`
    ),
    tile('Nerealizované P/L', signedSats(openPl).text, 'otevřené pozice', signedSats(openPl).className),
    tile(
      'Realizované P/L',
      signedSats(stats.netPnlSats).text,
      `${stats.trades || 0} obchodů, úspěšnost ${pct(stats.winRate)}`,
      signedSats(stats.netPnlSats).className
    ),
    tile(
      'BTC',
      price(btcPrice),
      `trend ${biasLabel}${Number.isFinite(market.atrPct) ? `, ATR ${pct(market.atrPct, 2)}` : ''}`
    )
  )
}

const renderPriceActionTiles = (box) => {
  renderPortfolioTiles(box)
}

const renderTiles = () => {
  const box = $('tiles')
  box.replaceChildren()
  if (!state) return
  if (currentStrategyView().id === 'price-action') {
    renderPriceActionTiles(box)
    return
  }
  renderPortfolioTiles(box)
}

// ── charts ────────────────────────────────────────────────────────────────

const ASSET_CHART = {
  width: 1120,
  height: 460,
  padLeft: 12,
  padRight: 156,
  padTop: 18,
  padBottom: 30,
}

const assetChartColumns = () => state?.priceActionMatrix?.timeframes?.length
  ? state.priceActionMatrix.timeframes
  : [{ id: '1h', label: '1H' }, { id: '4h', label: '4H' }, { id: '1d', label: '1D' }]

const assetChartSelection = () => {
  const matrix = state?.priceActionMatrix
  const columns = assetChartColumns()
  const asset = matrix?.assets?.find((candidate) => candidate.symbol === selectedAssetChart.symbol) ?? matrix?.assets?.[0]
  const timeframeId = columns.some((column) => column.id === selectedAssetChart.timeframeId)
    ? selectedAssetChart.timeframeId
    : columns.find((column) => column.id === '4h')?.id ?? columns[0]?.id
  return { asset, timeframeId, column: columns.find((column) => column.id === timeframeId) ?? columns[0] }
}

const chartZones = (item, type) => {
  const key = type === 'demand' ? 'nearbyDemand' : 'nearbySupply'
  const nearby = item?.zones?.[key]
  const fallback = item?.zones?.[type]
  return (nearby?.length ? nearby : fallback ? [fallback] : [])
    .filter((zone) => !zone.filledByOwnTimeframeClose)
    .filter((zone) => zone && Number.isFinite(zone.low) && Number.isFinite(zone.high))
}

const renderAssetChart = () => {
  const card = $('asset-chart-card')
  const svg = $('asset-chart-svg')
  const meta = $('asset-chart-meta')
  const title = $('asset-chart-title')
  const tabs = $('asset-chart-timeframes')
  const zoneDetails = $('asset-zone-details')
  if (!card || !svg || !tabs || !zoneDetails) return
  svg.replaceChildren()
  tabs.replaceChildren()
  zoneDetails.replaceChildren()

  if (currentStrategyView().id !== 'price-action') {
    card.hidden = true
    return
  }

  const matrix = state?.priceActionMatrix
  const { asset, timeframeId, column } = assetChartSelection()
  if (!asset) {
    card.hidden = true
    return
  }
  selectedAssetChart = { symbol: asset.symbol, timeframeId }
  card.hidden = false
  title.textContent = `${asset.symbol} · ${column?.label || timeframeId.toUpperCase()}`
  renderAssetZoneDetails(zoneDetails, asset, asset.trends?.[timeframeId], timeframeId)

  for (const chartColumn of assetChartColumns()) {
    const button = el('button', {
      type: 'button',
      className: 'asset-chart-tab',
      role: 'tab',
      'aria-selected': String(chartColumn.id === timeframeId),
      text: chartColumn.label,
    })
    button.onclick = () => {
      selectedAssetChart = { symbol: asset.symbol, timeframeId: chartColumn.id }
      renderAssetChart()
    }
    tabs.append(button)
  }

  const item = asset.trends?.[timeframeId]
  const candles = (item?.chartCandles ?? []).filter((candle) =>
    [candle?.open, candle?.high, candle?.low, candle?.close].every(Number.isFinite)
  )
  if (!candles.length) {
    meta.textContent = 'Pro tento asset a timeframe zatím nejsou publikované svíčky.'
    svg.append(el('text', { className: 'asset-axis-label', x: 18, y: 32, text: 'čeká na data' }))
    return
  }

  const zones = [
    ...chartZones(item, 'demand').map((zone, index) => ({ ...zone, kind: 'demand', index })),
    ...chartZones(item, 'supply').map((zone, index) => ({ ...zone, kind: 'supply', index })),
  ]
  const rawMin = Math.min(...candles.map((candle) => candle.low), ...zones.map((zone) => zone.low))
  const rawMax = Math.max(...candles.map((candle) => candle.high), ...zones.map((zone) => zone.high))
  const padding = (rawMax - rawMin || Math.max(1, Math.abs(rawMax) * 0.01)) * 0.08
  const minPrice = Math.max(0, rawMin - padding)
  const maxPrice = rawMax + padding
  const plotWidth = ASSET_CHART.width - ASSET_CHART.padLeft - ASSET_CHART.padRight
  const plotHeight = ASSET_CHART.height - ASSET_CHART.padTop - ASSET_CHART.padBottom
  const x = (index) => ASSET_CHART.padLeft + (index / Math.max(1, candles.length - 1)) * plotWidth
  const y = (value) => ASSET_CHART.padTop + ((maxPrice - value) / (maxPrice - minPrice)) * plotHeight
  const candleWidth = Math.max(2, Math.min(12, (plotWidth / candles.length) * 0.62))

  svg.setAttribute('viewBox', `0 0 ${ASSET_CHART.width} ${ASSET_CHART.height}`)
  svg.setAttribute('preserveAspectRatio', 'none')

  for (let step = 0; step <= 4; step += 1) {
    const value = minPrice + ((maxPrice - minPrice) * step) / 4
    const yy = y(value)
    svg.append(
      el('line', { className: 'asset-gridline', x1: ASSET_CHART.padLeft, x2: ASSET_CHART.width - ASSET_CHART.padRight, y1: yy, y2: yy }),
      el('text', { className: 'asset-axis-label', x: ASSET_CHART.width - ASSET_CHART.padRight + 8, y: yy + 4, text: quotePrice(value) })
    )
  }

  for (const zone of zones) {
    const top = y(zone.high)
    const bottom = y(zone.low)
    svg.append(el('rect', {
      className: `asset-zone-${zone.kind}`,
      x: ASSET_CHART.padLeft,
      y: Math.min(top, bottom),
      width: plotWidth,
      height: Math.max(2, Math.abs(bottom - top)),
      rx: 2,
    }))
  }

  for (const [index, candle] of candles.entries()) {
    const xx = x(index)
    const openY = y(candle.open)
    const closeY = y(candle.close)
    const highY = y(candle.high)
    const lowY = y(candle.low)
    const candleClass = candle.close >= candle.open ? 'asset-candle-up' : 'asset-candle-down'
    svg.append(
      el('line', { className: `asset-candle-wick ${candleClass}`, x1: xx, x2: xx, y1: highY, y2: lowY }),
      el('rect', {
        className: candleClass,
        x: xx - candleWidth / 2,
        y: Math.min(openY, closeY),
        width: candleWidth,
        height: Math.max(1.5, Math.abs(closeY - openY)),
      })
    )
  }

  const currentPrice = item?.price ?? candles.at(-1)?.close
  if (Number.isFinite(currentPrice)) {
    const currentY = y(currentPrice)
    svg.append(
      el('line', { className: 'asset-current-line', x1: ASSET_CHART.padLeft, x2: ASSET_CHART.width - ASSET_CHART.padRight, y1: currentY, y2: currentY }),
      el('text', { className: 'asset-current-label', x: ASSET_CHART.width - ASSET_CHART.padRight + 8, y: currentY - 5, text: assetPriceLabel(asset.symbol, currentPrice) })
    )
  }

  // Put zone labels in a separate right-hand lane and enforce a minimum gap so
  // overlapping ranges remain readable even when several zones cluster.
  const labelY = []
  for (const zone of zones.sort((left, right) => y((left.low + left.high) / 2) - y((right.low + right.high) / 2))) {
    const desired = y((zone.low + zone.high) / 2)
    const previous = labelY.at(-1)
    const placed = Math.min(ASSET_CHART.height - ASSET_CHART.padBottom - 4, Math.max(ASSET_CHART.padTop + 12, previous === undefined ? desired : previous + 22))
    labelY.push(placed)
    const prefix = zone.kind === 'demand' ? 'D' : 'S'
    svg.append(el('text', {
      className: `asset-zone-label asset-zone-label-${zone.kind}`,
      x: ASSET_CHART.width - ASSET_CHART.padRight + 8,
      y: placed,
      text: `${prefix}${zone.index + 1} ${quotePrice(zone.low)}–${quotePrice(zone.high)}`,
    }))
  }

  const first = candles[0]
  const last = candles.at(-1)
  meta.textContent = `${PRICE_ACTION_TREND_LABELS[item?.trend] || 'flat'} · ${assetPriceLabel(asset.symbol, currentPrice)} · ${when(first.time)} až ${when(last.time)}`
}

// ── equity chart ──────────────────────────────────────────────────────────

const CHART = { width: 900, height: 190, padLeft: 62, padRight: 12, padTop: 12, padBottom: 24 }

/**
 * What the bot is looking at right now.
 *
 * An untraded portfolio shows five zeroes and four empty tables, which reads as
 * a bot that is not running. Usually it is running and refusing — this strategy
 * takes roughly one trade every two days by design, and with the zone quality
 * filters on, fewer. So the refusal goes on screen beside the empty tables
 * instead of being buried in the run log.
 */
const renderDecision = () => {
  const card = $('decision-card')
  const box = $('decision')
  if (currentStrategyView().id === 'price-action') {
    renderPriceActionDecision(card, box)
    return
  }
  const decision = state?.lastDecision
  if (!decision) {
    card.hidden = true
    return
  }
  card.hidden = false
  box.replaceChildren()

  const opening = decision.action === 'open' && (decision.gates ?? []).length === 0
  const verdict = opening
    ? `Otevírá ${decision.side === 'long' ? 'long' : 'short'}`
    : decision.action === 'open'
      ? 'Signál je, ale portfolio ho nepustilo'
      : 'Čeká — žádný signál'

  box.append(
    el('div', { className: 'decision-line' }, [
      el('span', { className: 'decision-verdict', text: verdict }),
      el('span', { className: 'decision-reason', text: decision.reason ?? '' }),
    ])
  )

  const context = decision.context ?? {}
  const aboveRegime =
    Number.isFinite(context.dailyClose) && Number.isFinite(context.regimeMa)
      ? context.dailyClose >= context.regimeMa
      : null
  const breakout =
    Number.isFinite(context.dailyClose) && Number.isFinite(context.channelHigh)
      ? context.dailyClose > context.channelHigh
      : null
  const plan = decision.plan
  const facts = [
    Number.isFinite(context.price) ? decisionFact(`cena ${price(context.price)}`) : null,
    aboveRegime !== null
      ? decisionFact(
          `100D průměr ${price(context.regimeMa)}`,
          aboveRegime ? 'met' : 'unmet',
          aboveRegime ? 'Cena je na správné straně dlouhodobého trendu.' : 'Pod 100denním průměrem se long nevstupuje.'
        )
      : null,
    breakout !== null
      ? decisionFact(
          `20D high ${price(context.channelHigh)}`,
          breakout ? 'met' : 'unmet',
          breakout ? 'Denní close prorazil vstupní kanál.' : 'Denní close je stále uvnitř vstupního kanálu.'
        )
      : null,
    Number.isFinite(context.dailyAtr) && Number.isFinite(context.price)
      ? decisionFact(
          `denní ATR ${price(context.dailyAtr)} · ${pct((context.dailyAtr / context.price) * 100, 2)}`,
          'neutral',
          'Počáteční stop bude jeden denní ATR od vstupu.'
        )
      : null,
    decision.action === 'open'
      ? decisionFact('čerstvý breakout ano', 'met')
      : decisionFact('čerstvý breakout ne', 'unmet'),
    Number.isFinite(plan?.stop)
      ? decisionFact(`SL ${price(plan.stop)}`, 'met', 'Počáteční stop jeden denní ATR pod vstupem.')
      : null,
    Number.isFinite(plan?.takeProfit)
      ? decisionFact(
          `TP bracket ${price(plan.takeProfit)}`,
          'met',
          'Vzdálený ochranný TP; běžný výstup řídí 10denní trailing stop.'
        )
      : null,
    Number.isFinite(plan?.leverage)
      ? decisionFact(
          `${plan.leverage}x páka`,
          'met',
          `Likvidace ${price(plan.liquidation)} leží za stopem ${price(plan.stop)}.`
        )
      : null,
    (decision.gates ?? []).length ? decisionFact('portfolio gate ne', 'unmet', 'Strategie viděla signál, ale účetní/pravidlový gate ho nepustil.') : null,
  ].filter(Boolean)

  if (facts.length) {
    box.append(
      el('div', { className: 'decision-facts' }, facts.map(decisionFactElement))
    )
  }

  if ((decision.gates ?? []).length) {
    box.append(
      el('ul', { className: 'gates' }, decision.gates.map((gate) => el('li', { text: gate })))
    )
  }
  if (decision.planRejection) {
    box.append(el('ul', { className: 'gates' }, [el('li', { text: decision.planRejection })]))
  }
}

const renderPriceActionDecision = (card, box) => {
  const matrix = state?.priceActionMatrix
  card.hidden = false
  box.replaceChildren()
  if (!matrix?.assets?.length) {
    box.append(
      el('div', { className: 'decision-line' }, [
        el('span', { className: 'decision-verdict', text: 'Čeká na první price-action scan' }),
        el('span', { className: 'decision-reason', text: state?.priceActionMatrixError || '' }),
      ])
    )
    return
  }

  const summary = priceActionSummary()
  const lead = summary.ready[0] ?? summary.watch[0] ?? sortedPriceActionProfiles()[0]
  const profile = lead?.profile
  const verdict = summary.ready.length
    ? `${summary.ready.length} ready setup${summary.ready.length === 1 ? '' : 'ů'}`
    : 'Čeká na validní vstup'
  const reason = lead
    ? `${lead.asset.symbol} ${lead.column.label} · ${profile.side || 'flat'} · ${lead.item?.reason || 'bez důvodu'}`
    : 'bez price-action profilu'

  const columns = matrix.timeframes?.length ? matrix.timeframes : [
    { id: '1h', label: '1H' },
    { id: '4h', label: '4H' },
    { id: '1d', label: '1D' },
  ]

  box.append(
    el('div', { className: 'decision-line' }, [
      el('span', { className: 'decision-verdict', text: verdict }),
      el('span', { className: 'decision-reason', text: reason }),
    ]),
    el('div', { className: 'pa-decision-meta' }, [
      el('span', { text: `scan ${ago(matrix.generatedAt)}` }),
      el('span', { text: `${summary.profiles.length} profilů · ${summary.ready.length} ready · ${summary.watch.length} čeká` }),
    ]),
    renderPriceActionDecisionTabs(columns),
    renderPriceActionDecisionTable(matrix, columns),
  )
}

const renderChart = () => {
  const svg = $('equity-svg')
  const tooltip = $('equity-tooltip')
  svg.replaceChildren()
  tooltip.hidden = true
  if (currentStrategyView().id === 'price-action') {
    svg.append(
      el('text', {
        x: 12,
        y: 40,
        className: 'tick',
        text: 'PA-1 je zatím profile-only strategie bez vlastního kapitálu a equity křivky; po zapnutí exekuce se bude měřit odděleně.',
      })
    )
    return
  }

  const points = (state?.equityHistory || []).filter((point) => Number.isFinite(point.equitySats))
  if (points.length < 2) {
    svg.append(
      el('text', {
        x: 12,
        y: 40,
        className: 'tick',
        text: `Zatím ${points.length === 1 ? 'jeden bod' : 'žádný bod'} — kapitál se vzorkuje po 15 minutách, graf naskočí do půl hodiny.`,
      })
    )
    return
  }

  const { width, height, padLeft, padRight, padTop, padBottom } = CHART
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('preserveAspectRatio', 'none')

  const values = points.map((point) => point.equitySats)
  const times = points.map((point) => point.at)
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const span = maxValue - minValue || Math.max(1, maxValue * 0.01)
  const low = minValue - span * 0.12
  const high = maxValue + span * 0.12

  const x = (index) => padLeft + (index / (points.length - 1)) * (width - padLeft - padRight)
  const y = (value) => padTop + (1 - (value - low) / (high - low)) * (height - padTop - padBottom)

  // Gridlines and y ticks, recessive by design.
  for (let step = 0; step <= 3; step += 1) {
    const value = low + ((high - low) * step) / 3
    const yy = y(value)
    svg.append(el('line', { class: 'gridline', x1: padLeft, x2: width - padRight, y1: yy, y2: yy }))
    svg.append(el('text', { class: 'tick', x: padLeft - 8, y: yy + 4, 'text-anchor': 'end', text: nf(0).format(Math.round(value)) }))
  }

  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(point.equitySats)}`).join('')
  svg.append(el('path', { class: 'area', d: `${line}L${x(points.length - 1)},${y(low)}L${x(0)},${y(low)}Z` }))
  svg.append(el('path', { class: 'series', d: line }))
  svg.append(el('line', { class: 'baseline', x1: padLeft, x2: width - padRight, y1: y(low), y2: y(low) }))

  svg.append(el('text', { class: 'tick', x: padLeft, y: height - 6, text: when(times[0]) }))
  svg.append(
    el('text', { class: 'tick', x: width - padRight, y: height - 6, 'text-anchor': 'end', text: when(times.at(-1)) })
  )

  const crosshair = el('line', { class: 'crosshair', y1: padTop, y2: height - padBottom, x1: 0, x2: 0 })
  const cursor = el('circle', { class: 'cursor', r: 4, cx: 0, cy: 0 })
  crosshair.style.display = 'none'
  cursor.style.display = 'none'
  svg.append(crosshair, cursor)

  const container = $('equity-chart')
  const onMove = (event) => {
    const box = svg.getBoundingClientRect()
    const relative = ((event.clientX - box.left) / box.width) * width
    const ratio = (relative - padLeft) / (width - padLeft - padRight)
    const index = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))))
    const point = points[index]

    crosshair.style.display = ''
    cursor.style.display = ''
    crosshair.setAttribute('x1', x(index))
    crosshair.setAttribute('x2', x(index))
    cursor.setAttribute('cx', x(index))
    cursor.setAttribute('cy', y(point.equitySats))

    tooltip.hidden = false
    tooltip.replaceChildren(
      el('div', { text: when(point.at) }),
      el('div', {}, [el('b', { text: sats(point.equitySats) })])
    )
    tooltip.style.left = `${(x(index) / width) * box.width}px`
    tooltip.style.top = `${(y(point.equitySats) / height) * box.height - 10}px`
  }
  const onLeave = () => {
    crosshair.style.display = 'none'
    cursor.style.display = 'none'
    tooltip.hidden = true
  }
  container.onmousemove = onMove
  container.onmouseleave = onLeave
}

// ── tables ────────────────────────────────────────────────────────────────

const sideCell = (side) =>
  el('td', {}, [
    el('span', {
      className: side === 'long' ? 'side-long' : side === 'short' ? 'side-short' : '',
      text: side === 'long' ? 'LONG' : side === 'short' ? 'SHORT' : '–',
    }),
  ])

const emptyRow = (columns, message) =>
  el('tr', {}, [el('td', { colspan: String(columns), className: 'empty', text: message })])

const setPanelTitle = (id, text) => {
  const node = $(id)
  if (node) node.textContent = text
}

const setTableHead = (panelId, labels) => {
  const row = $(panelId)?.querySelector('thead tr')
  if (!row) return
  row.replaceChildren(...labels.map((label) => el('th', { text: label })))
}

const missingProfileGates = (profile) =>
  (profile?.gates ?? [])
    .filter((item) => item.status === 'unmet')
    .map((item) => item.label)
    .join(', ') || 'čeká'

const profileAssetCell = (entry) =>
  el('td', {}, [
    assetTickerButton(entry.asset.symbol, entry.column.id),
    el('span', { className: 'asset-name', text: ` ${entry.column.label}` }),
  ])

const renderOpen = () => {
  const body = $('tbody-open')
  if (currentStrategyView().id === 'price-action') {
    renderPriceActionOpen(body)
    return
  }
  setPanelTitle('panel-open-title', 'Otevřené pozice')
  setTableHead('panel-open', ['Otevřeno', 'Směr', 'Velikost', 'Vstup', 'Stop loss', 'Take profit', 'Páka', 'Likvidace', 'Marže', 'P/L'])
  $('flatten').hidden = false
  const rows = state?.positions?.running || []
  body.replaceChildren()
  if (!rows.length) {
    body.append(emptyRow(10, 'Žádná otevřená pozice.'))
    return
  }
  for (const position of rows) {
    const pl = signedSats(position.plSats)
    body.append(
      el('tr', {}, [
        el('td', { text: when(position.openedAt) }),
        sideCell(position.side),
        el('td', { text: position.quantityUsd ? `${nf(0).format(position.quantityUsd)} USD` : '–' }),
        el('td', { text: price(position.entry) }),
        el('td', { text: price(position.stopLoss) }),
        el('td', { text: price(position.takeProfit) }),
        el('td', { text: position.leverage ? `${position.leverage}×` : '–' }),
        el('td', { text: price(position.liquidation) }),
        el('td', { text: sats(position.marginSats) }),
        el('td', { className: pl.className, text: pl.text }),
      ])
    )
  }
}

const renderPriceActionOpen = (body) => {
  setPanelTitle('panel-open-title', 'Otevřené price-action obchody')
  setTableHead('panel-open', ['Otevřeno', 'Asset', 'TF', 'Směr', 'Entry', 'SL', 'TP', 'P/L', 'Stav struktury'])
  $('flatten').hidden = false
  const rows = (state?.positions?.running || []).filter((position) => position.strategyId === 'price-action-structure-v1')
  body.replaceChildren()
  if (!rows.length) {
    body.append(emptyRow(9, 'Žádný otevřený price-action trade.'))
    return
  }
  for (const position of rows) {
    const event = (state?.priceActionEvents || []).find((candidate) => candidate.positionId === position.id)
    const pl = signedSats(position.plSats)
    body.append(
      el('tr', {}, [
        el('td', { text: when(position.openedAt ?? position.createdAt) }),
        el('td', { text: position.assetSymbol || position.asset || '–' }),
        el('td', { text: position.timeframeId || position.timeframe ? (position.timeframeId || position.timeframe).toUpperCase() : '–' }),
        sideCell(position.side),
        el('td', { text: quotePrice(position.entry) }),
        el('td', { text: quotePrice(position.stopLoss) }),
        el('td', { text: quotePrice(position.takeProfit) }),
        el('td', { className: pl.className, text: pl.text }),
        el('td', { className: event ? 'neg' : 'pos', text: event ? 'invalidace zapsána' : 'struktura drží' }),
      ])
    )
  }
}

const renderOrders = () => {
  const body = $('tbody-orders')
  if (currentStrategyView().id === 'price-action') {
    renderPriceActionOrders(body)
    return
  }
  setPanelTitle('panel-orders-title', 'Objednávky')
  setTableHead('panel-orders', ['Zadáno', 'Typ', 'Směr', 'Velikost', 'Cena', 'Stop loss', 'Take profit', 'Marže', ''])
  const rows = state?.positions?.orders || []
  body.replaceChildren()
  if (!rows.length) {
    body.append(emptyRow(9, 'Žádné čekající objednávky.'))
    return
  }
  for (const order of rows) {
    const cancel = el('button', { type: 'button', text: 'Zrušit' })
    cancel.onclick = () => queueCommand('cancel', order.id)
    body.append(
      el('tr', {}, [
        el('td', { text: when(order.createdAt) }),
        el('td', { text: order.type === 'limit' ? 'limit' : 'market' }),
        sideCell(order.side),
        el('td', { text: order.quantityUsd ? `${nf(0).format(order.quantityUsd)} USD` : '–' }),
        el('td', { text: price(order.entry) }),
        el('td', { text: price(order.stopLoss) }),
        el('td', { text: price(order.takeProfit) }),
        el('td', { text: sats(order.marginSats) }),
        el('td', {}, [cancel]),
      ])
    )
  }
}

const renderPriceActionOrders = (body) => {
  setPanelTitle('panel-orders-title', 'Čekající price-action objednávky')
  setTableHead('panel-orders', ['Zadáno', 'Asset', 'TF', 'Typ', 'Směr', 'Velikost', 'Cena', 'Stop loss', 'Take profit', 'Marže', ''])
  const rows = state?.positions?.orders || []
  body.replaceChildren()
  if (!rows.length) {
    body.append(emptyRow(11, 'Žádné čekající objednávky.'))
    return
  }
  for (const order of rows) {
    const cancel = el('button', { type: 'button', text: 'Zrušit' })
    cancel.onclick = () => queueCommand('cancel', order.id)
    body.append(
      el('tr', {}, [
        el('td', { text: when(order.createdAt ?? order.placedAt) }),
        el('td', { text: order.assetSymbol || order.asset || '–' }),
        el('td', { text: order.timeframeId || order.timeframe ? (order.timeframeId || order.timeframe).toUpperCase() : '–' }),
        el('td', { text: order.type === 'limit' ? 'limit' : 'market' }),
        sideCell(order.side),
        el('td', { text: order.quantityUsd ? `${nf(0).format(order.quantityUsd)} USD` : '–' }),
        el('td', { text: quotePrice(order.quotePrice ?? order.entry) }),
        el('td', { text: quotePrice(order.stopLoss) }),
        el('td', { text: quotePrice(order.takeProfit) }),
        el('td', { text: sats(order.marginSats) }),
        el('td', {}, [cancel]),
      ])
    )
  }
}

const EXIT_REASONS = {
  stop_loss: 'stop loss',
  take_profit: 'take profit',
  manual: 'ručně / strategií',
}

const renderClosed = () => {
  const body = $('tbody-closed')
  if (currentStrategyView().id === 'price-action') {
    renderPriceActionClosed(body)
    return
  }
  setPanelTitle('panel-closed-title', 'Zavřené pozice')
  setTableHead('panel-closed', ['Zavřeno', 'Směr', 'Velikost', 'Vstup', 'Výstup', 'Důvod', 'Poplatky', 'P/L'])
  const rows = [...(state?.positions?.closed || [])].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
  body.replaceChildren()
  if (!rows.length) {
    body.append(emptyRow(8, 'Zatím žádný uzavřený obchod.'))
    return
  }
  for (const trade of rows) {
    const pl = signedSats(trade.plSats)
    const fees = (trade.openingFeeSats || 0) + (trade.closingFeeSats || 0) + (trade.carryFeesSats || 0)
    body.append(
      el('tr', {}, [
        el('td', { text: when(trade.closedAt) }),
        sideCell(trade.side),
        el('td', { text: trade.quantityUsd ? `${nf(0).format(trade.quantityUsd)} USD` : '–' }),
        el('td', { text: price(trade.entry) }),
        el('td', { text: price(trade.exitPrice) }),
        el('td', { text: EXIT_REASONS[trade.exitReason] || '–' }),
        el('td', { text: fees ? sats(fees) : '–' }),
        el('td', { className: pl.className, text: pl.text }),
      ])
    )
  }
}

const renderPriceActionClosed = (body) => {
  setPanelTitle('panel-closed-title', 'Zavřené price-action obchody')
  setTableHead('panel-closed', ['Zavřeno', 'Asset', 'Směr', 'Entry', 'Výstup', 'Důvod', 'P/L'])
  const rows = (state?.positions?.closed || []).filter((trade) => trade.strategyId === 'price-action-structure-v1')
  body.replaceChildren()
  if (!rows.length) {
    body.append(emptyRow(7, 'Zatím žádný uzavřený price-action obchod.'))
    return
  }
  for (const trade of rows.slice(0, 100)) {
    const pl = signedSats(trade.plSats)
    body.append(
      el('tr', {}, [
        el('td', { text: when(trade.closedAt) }),
        el('td', { text: trade.assetSymbol || trade.asset || '–' }),
        sideCell(trade.side),
        el('td', { text: quotePrice(trade.entry) }),
        el('td', { text: quotePrice(trade.exitPrice) }),
        el('td', { className: 'reason', text: EXIT_REASONS[trade.exitReason] || '–' }),
        el('td', { className: pl.className, text: pl.text }),
      ])
    )
  }
}

const ACTIONS = {
  opened: 'otevřel pozici',
  managed: 'upravil pozici',
  none: 'nic',
  skipped: 'přeskočil',
  error: 'chyba',
  would_open: 'otevřel by (dry run)',
}

const renderRuns = () => {
  const body = $('tbody-runs')
  if (currentStrategyView().id === 'price-action') {
    renderPriceActionRuns(body)
    return
  }
  setPanelTitle('panel-runs-title', 'Běhy')
  setTableHead('panel-runs', ['Čas', 'Runner', 'Režim', 'Akce', 'Trvání', 'Důvod'])
  const rows = state?.runs || []
  body.replaceChildren()
  if (!rows.length) {
    body.append(emptyRow(6, 'Zatím žádný běh.'))
    return
  }
  for (const run of rows.slice(0, 60)) {
    body.append(
      el('tr', {}, [
        el('td', { text: when(run.at) }),
        el('td', { text: run.runner || '–' }),
        el('td', { text: run.mode || '–' }),
        el('td', { className: run.action === 'error' ? 'neg' : '', text: ACTIONS[run.action] || run.action }),
        el('td', { text: Number.isFinite(run.durationMs) ? `${run.durationMs} ms` : '–' }),
        el('td', { className: 'reason', text: run.error || run.reason || '' }),
      ])
    )
  }
}

const renderPriceActionRuns = (body) => {
  setPanelTitle('panel-runs-title', 'Běhy price-action scanneru')
  setTableHead('panel-runs', ['Čas', 'Asset', 'Zdroj', 'Status', 'Timeframes', 'Poznámka'])
  const matrix = state?.priceActionMatrix
  const rows = matrix?.assets ?? []
  body.replaceChildren()
  if (!rows.length) {
    body.append(emptyRow(6, state?.priceActionMatrixError || 'Price-action scanner zatím nemá publikovanou matici.'))
    return
  }
  for (const asset of rows) {
    const trends = Object.values(asset.trends ?? {})
    const ready = trends.filter((item) => item.tradeProfile?.status === 'ready').length
    body.append(
      el('tr', {}, [
        el('td', { text: when(matrix.generatedAt) }),
        el('td', { text: asset.symbol }),
        el('td', { text: asset.source || '–' }),
        el('td', { text: ready ? `${ready} ready` : 'čeká' }),
        el('td', { text: Object.keys(asset.trends ?? {}).map((item) => item.toUpperCase()).join(' / ') || '–' }),
        el('td', { className: 'reason', text: (asset.failures ?? []).join('; ') || `refresh ${matrix.refreshMinutes ?? '–'} min` }),
      ])
    )
  }
}

const backtestStatus = (result) => {
  if (!result) return decisionFact('čeká', 'neutral', 'Výsledek doplníme po doladění a spuštění backtestu.')
  const cagr = Number(result.cagrPct ?? result.annualReturnPct)
  const drawdown = Number(result.maxDrawdownPct)
  const trades = Number(result.trades)
  const label = Number.isFinite(cagr)
    ? `${pct(cagr, 1)} p.a.`
    : result.label || result.status || 'hotovo'
  const status =
    result.statusKind ??
    result.status ??
    (Number.isFinite(cagr) && cagr >= 20 && (!Number.isFinite(drawdown) || drawdown <= 20) ? 'met' : 'neutral')
  const title = [
    Number.isFinite(trades) ? `${trades} obchodů` : null,
    Number.isFinite(drawdown) ? `DD ${pct(drawdown, 1)}` : null,
    Number.isFinite(result.profitFactor) ? `PF ${nf(2).format(result.profitFactor)}` : null,
    result.detail,
  ].filter(Boolean).join(' · ')
  return decisionFact(label, status, title || null)
}

const priceActionBacktestResult = (asset, timeframeId) =>
  state?.backtests?.priceAction?.[asset.symbol]?.[timeframeId] ??
  state?.backtests?.['price-action']?.[asset.symbol]?.[timeframeId] ??
  null

const renderPriceActionBacktests = (host) => {
  const matrix = state?.priceActionMatrix
  const assets = matrix?.assets?.length ? matrix.assets : []
  const columns = matrix?.timeframes?.length ? matrix.timeframes : [
    { id: '1h', label: '1H' },
    { id: '4h', label: '4H' },
    { id: '1d', label: '1D' },
  ]
  if (!assets.length) {
    host.append(el('p', { className: 'empty', text: 'Backtestovací matice čeká na první price-action scan s assety.' }))
    return
  }

  const table = el('table', { className: 'pa-matrix-table backtest-matrix-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Asset' }),
        ...columns.map((column) => el('th', { text: column.label })),
        el('th', { text: 'Poznámka' }),
      ]),
    ]),
    el('tbody'),
  ])
  const body = table.querySelector('tbody')
  for (const asset of assets) {
    body.append(
      el('tr', {}, [
        el('td', {}, [
          assetTickerButton(asset.symbol, priceActionDecisionTimeframe),
        ]),
        ...columns.map((column) =>
          el('td', {}, [decisionFactElement(backtestStatus(priceActionBacktestResult(asset, column.id)))])
        ),
        el('td', { className: 'reason', text: 'připraveno pro výsledky po doladění strategie' }),
      ])
    )
  }

  host.append(
    el('p', {
      className: 'zone-rule',
      text: 'Výsledky budou po backtestu ukládané po assetu a timeframe; tabulka už drží stejné členění jako struktura trhu.',
    }),
    el('div', { className: 'table-scroll' }, [table])
  )
}

const renderMomentumBacktests = (host) => {
  const strategy = STRATEGY_CANDIDATES.find((item) => item.name === STRATEGY_VIEWS.momentum.strategyName)
  const table = el('table', { className: 'backtest-matrix-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Strategie' }),
        el('th', { text: 'Timeframe' }),
        el('th', { text: 'Výsledek' }),
        el('th', { text: 'Detail' }),
      ]),
    ]),
    el('tbody', {}, [
      el('tr', {}, [
        el('td', { text: strategy?.name ?? 'TF-2L Leveraged momentum' }),
        el('td', { text: '1D signál / 1H exekuce' }),
        el('td', {}, [decisionFactElement(decisionFact(strategy?.backtest?.result ?? 'čeká', strategy?.backtest?.status ?? 'neutral'))]),
        el('td', { className: 'reason', text: strategy?.backtest?.detail ?? 'Backtest zatím není publikovaný.' }),
      ]),
    ]),
  ])
  host.append(el('div', { className: 'table-scroll' }, [table]))
}

const renderBacktests = () => {
  const host = $('strategy-backtests')
  const title = $('panel-backtests-title')
  if (!host) return
  const view = currentStrategyView()
  host.replaceChildren()
  if (title) title.textContent = view.id === 'price-action' ? 'Backtesty: Price Action' : 'Backtesty: Momentum'
  if (view.id === 'price-action') renderPriceActionBacktests(host)
  else renderMomentumBacktests(host)
}

const renderFilledZonesLog = (host) => {
  host.replaceChildren()
  if (currentStrategyView().id !== 'price-action') {
    host.append(el('p', { className: 'empty', text: 'Log vyplněných zón patří ke strategii PA-1 Price Action Structure.' }))
    return
  }

  const matrix = state?.priceActionMatrix
  const columns = matrix?.timeframes?.length ? matrix.timeframes : [
    { id: '1h', label: '1H' },
    { id: '4h', label: '4H' },
    { id: '1d', label: '1D' },
  ]
  const rows = []
  for (const asset of matrix?.assets ?? []) {
    for (const column of columns) {
      const item = asset.trends?.[column.id]
      for (const type of ['demand', 'supply']) {
        for (const zone of zoneList(item, type, { includeFilled: true }).filter((candidate) => candidate.filledByOwnTimeframeClose)) {
          rows.push({ asset, column, type, zone })
        }
      }
    }
  }

  if (!rows.length) {
    host.append(el('p', { className: 'empty', text: 'Zatím nebyla vyplněna žádná zóna na vlastním timeframe.' }))
    return
  }

  const table = el('table', { className: 'filled-zones-table' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Asset' }),
      el('th', { text: 'Timeframe' }),
      el('th', { text: 'Typ' }),
      el('th', { text: 'Range' }),
      el('th', { text: 'Vyplněno' }),
    ])]),
    el('tbody'),
  ])
  const body = table.querySelector('tbody')
  for (const { asset, column, type, zone } of rows.sort((left, right) => (right.zone.filledAt ?? 0) - (left.zone.filledAt ?? 0))) {
    body.append(el('tr', {}, [
      el('td', {}, [assetTickerButton(asset.symbol, column.id)]),
      el('td', { text: column.label }),
      el('td', { text: type === 'demand' ? 'Demand' : 'Supply' }),
      el('td', {}, [zoneRangeTrigger({ zone, timeframeId: column.id, title: 'Kliknutím zobrazit definiční svíčky zóny.' })]),
      el('td', { text: column.id === '1d' ? dateOnly(zone.filledAt) : when(zone.filledAt) }),
    ]))
  }
  host.append(el('div', { className: 'table-scroll' }, [table]))
}

const renderPriceActionEvents = (host) => {
  host.replaceChildren()
  if (currentStrategyView().id !== 'price-action') {
    host.append(el('p', { className: 'empty', text: 'Log změn struktury patří ke strategii PA-1 Price Action Structure.' }))
    return
  }
  const rows = state?.priceActionEvents ?? []
  if (!rows.length) {
    host.append(el('p', { className: 'empty', text: 'Zatím nebyla zaznamenána invalidace otevřeného price-action trade.' }))
    return
  }

  const table = el('table', { className: 'filled-zones-table trade-events-table' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: 'Čas' }),
      el('th', { text: 'Asset' }),
      el('th', { text: 'Pozice' }),
      el('th', { text: 'Změna na TF' }),
      el('th', { text: 'Důvod' }),
      el('th', { text: 'Nový návrh SL/TP' }),
    ])]),
    el('tbody'),
  ])
  const body = table.querySelector('tbody')
  for (const event of rows.slice(0, 100)) {
    const revised = event.revisedProfile || {}
    const revisedPlan = [
      revised.side ? revised.side.toUpperCase() : null,
      Number.isFinite(revised.stop) ? `SL ${quotePrice(revised.stop)}` : null,
      Number.isFinite(revised.tp1) ? `TP1 ${quotePrice(revised.tp1)}` : null,
      Number.isFinite(revised.tp2) ? `TP2 ${quotePrice(revised.tp2)}` : null,
    ].filter(Boolean).join(' · ') || 'bez validního návrhu'
    body.append(el('tr', {}, [
      el('td', { text: when(event.at) }),
      el('td', { text: event.asset || 'BTCUSD' }),
      sideCell(event.side),
      el('td', { text: event.invalidatingTimeframeId?.toUpperCase?.() || event.timeframeId?.toUpperCase?.() || '–' }),
      el('td', { className: 'reason', text: event.reason || '–' }),
      el('td', { text: revisedPlan }),
    ]))
  }
  host.append(el('div', { className: 'table-scroll' }, [table]))
}

const renderStrategyLab = () => {
  const rules = $('strategy-rules')
  const candidates = $('strategy-candidates')
  const priceAction = $('strategy-price-action')
  const filledZones = $('strategy-filled-zones')
  const tradeEvents = $('strategy-trade-events')
  const view = currentStrategyView()
  rules.replaceChildren()
  candidates.replaceChildren()
  priceAction.replaceChildren()
  filledZones.replaceChildren()
  tradeEvents.replaceChildren()
  $('strategy-panel-structure').hidden = selectedStrategyPanel !== 'structure'
  $('strategy-panel-filled-zones').hidden = selectedStrategyPanel !== 'filled-zones'
  $('strategy-panel-trade-events').hidden = selectedStrategyPanel !== 'trade-events'
  for (const button of document.querySelectorAll('.strategy-subtabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.strategyPanel === selectedStrategyPanel))
  }

  const rulebook = view.id === 'price-action' ? PRICE_ACTION_RULEBOOK : STRATEGY_RULEBOOK
  for (const rule of rulebook) {
    const status = rule.status()
    rules.append(
      el('div', { className: 'rule-row' }, [
        el('div', { className: 'rule-head' }, [
          el('strong', { text: rule.title }),
          decisionFactElement(status),
        ]),
        el('p', { text: rule.text }),
      ])
    )
  }

  const candidatesForView = STRATEGY_CANDIDATES.filter((strategy) => strategy.name === view.strategyName)
  if (candidatesForView.length === 0) {
    candidates.append(
      el('p', {
        className: 'empty',
        text: 'Žádný kandidát nyní nesplňuje minimální požadavky na výnos, drawdown, četnost a stabilitu.',
      })
    )
  }

  for (const strategy of candidatesForView) {
    candidates.append(
      el('div', { className: 'strategy-card' }, [
        el('div', { className: 'strategy-card-head' }, [
          el('strong', { text: strategy.name }),
          decisionFactElement(decisionFact(strategy.status, strategy.statusKind)),
        ]),
        el('p', { text: strategy.thesis }),
        el('div', { className: 'strategy-tags' }, strategy.rules.map((rule) => decisionFactElement(decisionFact(rule)))),
        strategy.backtest
          ? el('div', { className: 'strategy-backtest' }, [
              el('div', { className: 'strategy-backtest-head' }, [
                decisionFactElement(decisionFact(strategy.backtest.label, strategy.backtest.status)),
                el('strong', { text: strategy.backtest.result }),
              ]),
              el('p', { text: strategy.backtest.detail }),
            ])
          : null,
        el('code', { text: strategy.command }),
      ])
    )
  }

  const matrix = state?.priceActionMatrix
  if (!matrix?.assets?.length) {
    priceAction.append(
      el('p', {
        className: 'empty',
        text: state?.priceActionMatrixError
          ? `Price action scanner zatím nemá data: ${state.priceActionMatrixError}`
          : 'Price action scanner zatím čeká na první běh s daty.',
      })
    )
    renderFilledZonesLog(filledZones)
    renderPriceActionEvents(tradeEvents)
    return
  }

  const columns = matrix.timeframes?.length ? matrix.timeframes : [
    { id: '1h', label: '1H' },
    { id: '4h', label: '4H' },
    { id: '1d', label: '1D' },
  ]
  const table = el('table', { className: 'pa-matrix-table' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Asset' }),
        ...columns.map((column) => el('th', { text: column.label })),
        el('th', { text: 'Zdroj' }),
        el('th', { text: 'Aktualizace' }),
      ]),
    ]),
    el('tbody'),
  ])
  const body = table.querySelector('tbody')
  for (const asset of matrix.assets) {
    body.append(
      el('tr', {}, [
        el('td', {}, [
          assetTickerButton(asset.symbol, priceActionDecisionTimeframe),
        ]),
        ...columns.map((column) => {
          const item = asset.trends?.[column.id] ?? { trend: 'flat', reason: 'bez dat' }
          return el('td', {}, [trendFactButton({ asset, column, item })])
        }),
        el('td', { text: asset.source || '–' }),
        el('td', { text: when(matrix.generatedAt) }),
      ])
    )
  }

  priceAction.append(
    el('div', { className: 'table-scroll' }, [table]),
    renderStructureDetail({ matrix, columns }),
    state?.priceActionMatrixError
      ? el('p', { className: 'scanner-warning', text: `Poslední chyba scanneru: ${state.priceActionMatrixError}` })
      : null
  )
  renderFilledZonesLog(filledZones)
  renderPriceActionEvents(tradeEvents)
}

const renderSettings = () => {
  const settings = state?.settings || {}
  const mainnet = $('set-mode').querySelector('option[value="mainnet"]')
  if (mainnet) {
    mainnet.disabled = keyIsPublic
    mainnet.textContent = keyIsPublic
      ? 'LN Markets ostrý provoz — zamčeno (veřejný klíč)'
      : 'LN Markets ostrý provoz'
  }
  $('set-enabled').value = settings.enabled === false ? 'false' : 'true'
  $('set-mode').value = settings.mode === 'testnet' ? 'testnet4' : settings.mode || 'testnet4'
  $('set-risk').value = settings.risk?.riskPct ?? 1
  $('set-max-open').value = settings.maxOpenPositions ?? 1
  $('set-max-day').value = settings.maxTradesPerDay ?? 3
  $('set-stop-atr').value = settings.strategy?.stopAtr ?? 1
  $('set-cooldown').value = settings.cooldownMinutesAfterLoss ?? 0
  $('set-max-leverage').value = settings.risk?.maxLeverage ?? 10
}

// ── actions ───────────────────────────────────────────────────────────────

const queueCommand = async (command, id = null) => {
  if (command === 'flatten' && !confirm('Opravdu zavřít všechny otevřené pozice?')) return
  try {
    await api('command', { method: 'POST', body: { command, id } })
    setStatus('Příkaz zařazen — provede se při dalším běhu bota.', 'pos')
  } catch (error) {
    setStatus(`Příkaz se nepodařilo zařadit: ${error.message}`, 'neg')
  }
}

const setStatus = (message, className = '') => {
  const box = $('settings-status')
  box.className = className
  box.textContent = message
  setTimeout(() => {
    if (box.textContent === message) box.textContent = ''
  }, 6000)
}

const saveSettings = async () => {
  const mode = $('set-mode').value
  if (mode === 'mainnet' && !confirm('Přepnout na OSTRÝ provoz? Bot začne obchodovat za skutečné sats.')) return

  const settings = state?.settings || {}
  const payload = {
    ...settings,
    enabled: $('set-enabled').value === 'true',
    mode,
    maxOpenPositions: Number($('set-max-open').value),
    maxTradesPerDay: Number($('set-max-day').value),
    cooldownMinutesAfterLoss: Number($('set-cooldown').value),
    risk: {
      ...(settings.risk || {}),
      riskPct: Number($('set-risk').value),
      maxLeverage: Number($('set-max-leverage').value),
    },
    strategy: { ...(settings.strategy || {}), stopAtr: Number($('set-stop-atr').value) },
  }

  try {
    await api('settings', { method: 'POST', body: payload })
    setStatus('Uloženo. Platí od dalšího běhu.', 'pos')
    await load()
  } catch (error) {
    setStatus(`Uložení selhalo: ${error.message}`, 'neg')
  }
}

// ── shell ─────────────────────────────────────────────────────────────────

const renderHeader = () => {
  const view = currentStrategyView()
  const switcher = $('strategy-view')
  if (switcher && switcher.options.length === 0) {
    switcher.replaceChildren(...Object.values(STRATEGY_VIEWS).map((item) =>
      el('option', { value: item.id, text: item.label })
    ))
  }
  if (switcher) switcher.value = view.id

  const badge = $('mode-badge')
  const mode = state?.mode || state?.settings?.mode || '–'
  badge.textContent = { testnet: 'TESTNET', testnet4: 'TESTNET', mainnet: 'OSTRÝ PROVOZ', paper: 'PAPER' }[mode] || mode
  badge.className = `badge mode-${mode === 'testnet4' ? 'testnet' : mode}`

  $('portfolio-name').textContent = view.id === 'momentum'
    ? state?.settings?.portfolioName || view.title
    : view.title
  $('equity-title').textContent = view.id === 'momentum' ? 'Vývoj kapitálu (sats)' : 'Kapitál strategie'

  const dot = $('status-dot')
  const updated = state?.updatedAt ? Date.parse(state.updatedAt) : NaN
  const stale = Number.isFinite(updated) && Date.now() - updated > 20 * 60_000
  dot.className = `dot ${stale ? 'stale' : state?.status || ''}`
  dot.title = stale ? 'stav je zastaralý' : state?.status || 'neznámý stav'

  $('last-run').textContent = `poslední běh ${ago(state?.updatedAt)}`
}

const renderAll = () => {
  renderHeader()
  renderNotices()
  renderTiles()
  renderDecision()
  renderAssetChart()
  renderChart()
  renderOpen()
  renderOrders()
  renderClosed()
  renderRuns()
  renderStrategyLab()
  renderBacktests()
  renderSettings()
}

const load = async () => {
  const payload = await api('state')
  keyIsPublic = Boolean(payload.keyIsPublic)
  state = payload.state || null
  if (!state) {
    $('notices').replaceChildren(
      el('div', {
        className: 'notice',
        text: 'Bot zatím nic nezveřejnil. Po prvním běhu se tu objeví stav portfolia.',
      })
    )
    renderHeader()
    return
  }
  renderAll()
}

const showGate = (message = '') => {
  $('gate').hidden = false
  $('app').hidden = true
  $('gate-error').textContent = message
  clearInterval(refreshTimer)
}

const showApp = () => {
  $('gate').hidden = true
  $('app').hidden = false
  clearInterval(refreshTimer)
  refreshTimer = setInterval(() => {
    load().catch((error) => {
      if (error.status === 401) showGate('Klíč přestal platit.')
    })
  }, REFRESH_MS)
}

const start = async () => {
  if (!getKey()) {
    showGate()
    return
  }
  try {
    await load()
    showApp()
  } catch (error) {
    if (error.status === 401) {
      setKey('')
      showGate('Neplatný klíč.')
    } else {
      showApp()
      $('notices').replaceChildren(el('div', { className: 'notice bad', text: `Nepodařilo se načíst stav: ${error.message}` }))
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setStrategyView(getStrategyView())

  $('gate-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const candidate = $('gate-key').value.trim()
    try {
      await api('state', { key: candidate })
      setKey(candidate)
      await load()
      showApp()
    } catch (error) {
      $('gate-error').textContent = error.status === 401 ? 'Neplatný klíč.' : error.message
    }
  })

  for (const button of document.querySelectorAll('.tabs button')) {
    button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tabs button')) {
        const selected = other === button
        other.setAttribute('aria-selected', String(selected))
        $(`panel-${other.dataset.tab}`).hidden = !selected
      }
    })
  }

  for (const button of document.querySelectorAll('.strategy-subtabs button')) {
    button.addEventListener('click', () => {
      selectedStrategyPanel = button.dataset.strategyPanel || 'structure'
      renderStrategyLab()
    })
  }

  $('refresh').addEventListener('click', () => load().catch((error) => setStatus(error.message, 'neg')))
  $('strategy-view').addEventListener('change', (event) => {
    setStrategyView(event.target.value)
    renderAll()
  })
  $('flatten').addEventListener('click', () => queueCommand('flatten'))
  $('save-settings').addEventListener('click', saveSettings)
  $('forget-key').addEventListener('click', () => {
    setKey('')
    showGate('Klíč zapomenut.')
  })

  start()
})
