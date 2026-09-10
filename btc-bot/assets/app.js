/* BTC price-action bot dashboard.
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
const REFRESH_MS = 30_000
const SATS_PER_BTC = 1e8
const DECISION_SIGNAL_STATES = new Set(['met', 'unmet', 'neutral'])

const $ = (id) => document.getElementById(id)

let state = null
let keyIsPublic = false
let refreshTimer = null

// ── formatting ────────────────────────────────────────────────────────────

const nf = (digits) => new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const sats = (value) => (Number.isFinite(value) ? `${nf(0).format(Math.round(value))} sats` : '–')
const usd = (value) => (Number.isFinite(value) ? `$${nf(0).format(Math.round(value))}` : '–')
const price = (value) => (Number.isFinite(value) ? nf(0).format(Math.round(value)) : '–')
const pct = (value, digits = 1) => (Number.isFinite(value) ? `${nf(digits).format(value)} %` : '–')

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
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'className') node.className = value
    else if (name === 'text') node.textContent = value
    else if (value !== null && value !== undefined) node.setAttribute(name, value)
  }
  for (const child of [].concat(children)) {
    if (child !== null && child !== undefined) node.append(child)
  }
  return node
}

const strategySetting = (key, fallback) => {
  const value = Number(state?.settings?.strategy?.[key])
  return Number.isFinite(value) ? value : fallback
}

const strategyFlag = (key, fallback) => {
  const value = state?.settings?.strategy?.[key]
  return value === undefined ? fallback : Boolean(value)
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

const decisionIsBlockedBy = (decision, pattern) => pattern.test(String(decision?.reason ?? ''))

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

const renderTiles = () => {
  const box = $('tiles')
  box.replaceChildren()
  if (!state) return

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
  const bias = { up: 'vzestupný', down: 'sestupný', range: 'do strany' }[context.htfBias] ?? null
  const side = context.htfBias === 'up' ? 'long' : context.htfBias === 'down' ? 'short' : null
  const trendChangedAgainst =
    (context.htfBias === 'up' && context.htfEvent === 'CHoCH_DOWN') ||
    (context.htfBias === 'down' && context.htfEvent === 'CHoCH_UP')
  const atrMin = strategySetting('atrPctMin', 0.15)
  const atrMax = strategySetting('atrPctMax', 4.0)
  const atrOk = Number.isFinite(context.atrPct) && context.atrPct >= atrMin && context.atrPct <= atrMax
  const zoneMaxDistanceAtr = strategySetting('zoneMaxDistanceAtr', 1.0)
  const zoneDistanceAtr =
    context.zone && Number.isFinite(context.price) && Number.isFinite(context.ltfAtr) && context.ltfAtr > 0 && side
      ? Math.max(0, side === 'long' ? context.price - context.zone.high : context.zone.low - context.price) / context.ltfAtr
      : null
  const requireSweep = strategyFlag('requireSweep', true)
  const requireImbalance = strategyFlag('requireImbalance', false)
  const requireTrigger = strategyFlag('requireTrigger', true)
  const minRR = strategySetting('minRR', 2.0)
  const planRr = Number(decision.plan?.rr)
  const rrBlocked = decisionIsBlockedBy(decision, /reward\/risk/i)
  const facts = [
    bias
      ? decisionFact(
          `4h trend ${bias}`,
          ['up', 'down'].includes(context.htfBias) && !trendChangedAgainst ? 'met' : 'unmet',
          trendChangedAgainst ? 'Trend právě udělal CHoCH proti směru, takže vstup stojí.' : 'Vyšší timeframe musí mít směr.'
        )
      : null,
    Number.isFinite(context.price) ? decisionFact(`cena ${price(context.price)}`) : null,
    Number.isFinite(context.atrPct)
      ? decisionFact(
          `ATR ${pct(context.atrPct, 2)} · ${nf(2).format(atrMin)}–${nf(2).format(atrMax)} %`,
          atrOk ? 'met' : 'unmet',
          'Vstup se bere jen, když volatilita není moc tichá ani moc divoká.'
        )
      : null,
    context.zone
      ? decisionFact(`zóna ${price(context.zone.low)}–${price(context.zone.high)}`, 'met', 'Platná zóna ve směru vyššího trendu.')
      : decisionIsBlockedBy(decision, /no (demand|supply) zone/i)
        ? decisionFact('zóna chybí', 'unmet', 'Bez zóny ve směru trendu bot nevstupuje.')
        : null,
    zoneDistanceAtr !== null
      ? decisionFact(
          `vzdálenost ${nf(2).format(zoneDistanceAtr)} ATR · max ${nf(2).format(zoneMaxDistanceAtr)}`,
          zoneDistanceAtr <= zoneMaxDistanceAtr ? 'met' : 'unmet',
          'Cena musí být u zóny, ne daleko od ní.'
        )
      : null,
    context.zone && context.zone.swept !== undefined
      ? decisionFact(
          `sweep ${context.zone.swept ? 'ano' : 'ne'}`,
          requireSweep ? (context.zone.swept ? 'met' : 'unmet') : 'neutral',
          requireSweep ? 'Sweep je zapnutý filtr kvality zóny.' : 'Sweep je v nastavení vypnutý, takže jen informativně.'
        )
      : null,
    context.zone && context.zone.imbalance !== undefined
      ? decisionFact(
          `imbalance ${context.zone.imbalance ? 'ano' : 'ne'}`,
          requireImbalance ? (context.zone.imbalance ? 'met' : 'unmet') : 'neutral',
          requireImbalance ? 'Imbalance je zapnutý filtr kvality zóny.' : 'Imbalance je v nastavení vypnutý, takže jen informativně.'
        )
      : null,
    context.confirmation
      ? decisionFact(
          `spouštěč ${context.confirmation}`,
          requireTrigger ? 'met' : 'neutral',
          requireTrigger ? 'Uzavřená 1h svíčka potvrdila reakci na zóně.' : 'Trigger je v nastavení vypnutý, takže jen informativně.'
        )
      : context.zone && (Array.isArray(context.patterns) || decisionIsBlockedBy(decision, /no (bullish|bearish) trigger/i))
        ? decisionFact('spouštěč chybí', requireTrigger ? 'unmet' : 'neutral', 'Bez potvrzovací svíčky bot nevstupuje.')
        : null,
    Number.isFinite(planRr)
      ? decisionFact(`R/R ${nf(2).format(planRr)} · min ${nf(2).format(minRR)}`, planRr >= minRR ? 'met' : 'unmet')
      : rrBlocked
        ? decisionFact(`R/R pod ${nf(2).format(minRR)}`, 'unmet', 'Potenciální obchod nedává minimální odměnu vůči riziku.')
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

const renderChart = () => {
  const svg = $('equity-svg')
  const tooltip = $('equity-tooltip')
  svg.replaceChildren()
  tooltip.hidden = true

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
      className: side === 'long' ? 'side-long' : 'side-short',
      text: side === 'long' ? 'LONG' : 'SHORT',
    }),
  ])

const emptyRow = (columns, message) =>
  el('tr', {}, [el('td', { colspan: String(columns), className: 'empty', text: message })])

const renderOpen = () => {
  const body = $('tbody-open')
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

const renderOrders = () => {
  const body = $('tbody-orders')
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

const EXIT_REASONS = {
  stop_loss: 'stop loss',
  take_profit: 'take profit',
  manual: 'ručně / strategií',
}

const renderClosed = () => {
  const body = $('tbody-closed')
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
  $('set-min-rr').value = settings.strategy?.minRR ?? 2
  $('set-cooldown').value = settings.cooldownMinutesAfterLoss ?? 240
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

  const payload = {
    enabled: $('set-enabled').value === 'true',
    mode,
    maxOpenPositions: Number($('set-max-open').value),
    maxTradesPerDay: Number($('set-max-day').value),
    cooldownMinutesAfterLoss: Number($('set-cooldown').value),
    risk: { riskPct: Number($('set-risk').value), maxLeverage: Number($('set-max-leverage').value) },
    strategy: { minRR: Number($('set-min-rr').value) },
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
  const badge = $('mode-badge')
  const mode = state?.mode || state?.settings?.mode || '–'
  badge.textContent = { testnet: 'TESTNET', testnet4: 'TESTNET', mainnet: 'OSTRÝ PROVOZ', paper: 'PAPER' }[mode] || mode
  badge.className = `badge mode-${mode === 'testnet4' ? 'testnet' : mode}`

  $('portfolio-name').textContent = state?.settings?.portfolioName || 'BTC Price Action Swing'

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
  renderChart()
  renderOpen()
  renderOrders()
  renderClosed()
  renderRuns()
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

  $('refresh').addEventListener('click', () => load().catch((error) => setStatus(error.message, 'neg')))
  $('flatten').addEventListener('click', () => queueCommand('flatten'))
  $('save-settings').addEventListener('click', saveSettings)
  $('forget-key').addEventListener('click', () => {
    setKey('')
    showGate('Klíč zapomenut.')
  })

  start()
})
