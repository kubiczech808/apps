import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')

const css = read('assets/app.css')
const html = read('index.html')
const js = read('assets/app.js')
const api = read('api.php')

test('the hidden attribute outranks every layout rule in the stylesheet', () => {
  // The bug this exists for: `.gate { display: grid }` is an author rule, and
  // author rules beat the browser's `[hidden] { display: none }` whatever the
  // specificity. The login overlay therefore never went away — the key was
  // accepted, the state loaded, and the screen did not change, which reads as a
  // dead button.
  const override = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css)
  assert.ok(override, 'app.css must contain [hidden] { display: none !important }')
})

test('every element the script hides exists in the page', () => {
  // A typo in an id makes `$( ... ).hidden = true` throw on null, which stops
  // the rest of the handler silently — the same symptom from a different cause.
  const ids = new Set()
  for (const match of js.matchAll(/\$\('([a-z0-9-]+)'\)\.hidden/g)) ids.add(match[1])
  assert.ok(ids.size > 0, 'expected the script to toggle something')

  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `#${id} is toggled by app.js but is not in index.html`)
  }
})

test('every tab has the panel it switches to', () => {
  const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((match) => match[1])
  assert.ok(tabs.length >= 4, `expected the dashboard's tabs, found ${tabs.length}`)
  for (const tab of tabs) {
    assert.ok(html.includes(`id="panel-${tab}"`), `tab "${tab}" has no #panel-${tab}`)
  }
})

test('the login form submits rather than reloading the page', () => {
  // A submit handler that forgets preventDefault navigates away and loses the
  // key, which also looks like "nothing happened".
  assert.match(js, /gate-form'\)\.addEventListener\('submit'/)
  assert.match(js, /event\.preventDefault\(\)/)
})

test('the key is read from the field the form actually contains', () => {
  assert.match(js, /\$\('gate-key'\)\.value/)
  assert.ok(html.includes('id="gate-key"'))
})

test('decision facts carry signal-state classes', () => {
  for (const className of ['fact-met', 'fact-unmet', 'fact-neutral']) {
    assert.ok(css.includes(`.${className}`), `app.css must style .${className}`)
  }
  assert.match(js, /DECISION_SIGNAL_STATES/)
  assert.match(js, /className:\s*`fact fact-\$\{fact\.status\}`/)
  assert.match(js, /100D průměr/)
  assert.match(js, /20D high/)
  assert.match(js, /denní ATR/)
  assert.match(js, /plan\?\.leverage/)
})

test('capital tile separates USD benchmark from sats trading result', () => {
  assert.match(js, /const signedPct/)
  assert.match(js, /const capitalBenchmark/)
  assert.match(js, /startingCapitalUsd/)
  assert.match(js, /firstPositiveEquitySats/)
  assert.match(js, /tile\(\s*'Výkon od startu'/, 'dashboard must render a start benchmark tile')
  assert.match(js, /BTC.*obchody.*v sats/s)
})

test('strategy tab shows the selected leveraged momentum strategy', () => {
  assert.ok(html.includes('data-tab="strategy"'), 'dashboard must expose the strategy tab')
  assert.ok(html.includes('id="panel-strategy"'), 'strategy tab must have a panel')
  assert.ok(html.includes('id="strategy-rules"'), 'strategy panel must contain the rule list')
  assert.ok(html.includes('id="strategy-candidates"'), 'strategy panel must contain candidates')
  assert.match(js, /STRATEGY_RULEBOOK/)
  assert.match(js, /STRATEGY_CANDIDATES/)
  assert.match(js, /renderStrategyLab/)
  assert.match(js, /Obchodujeme jen dlouhodobou sílu/)
  assert.match(js, /TF-2L Leveraged momentum/)
  assert.match(js, /5y \+ skutečný funding/)
  assert.match(js, /risk\.market=futures,risk\.riskPct=2/)
  assert.doesNotMatch(js, /JF-1 HTF swing S\/D/)
  assert.doesNotMatch(js, /TF-X Stop-only convex breakout/)
})

test('settings edit the selected strategy stop rather than a stale R\/R gate', () => {
  assert.ok(html.includes('id="set-stop-atr"'))
  assert.ok(!html.includes('id="set-min-rr"'))
  assert.match(js, /const payload = \{\s*\.\.\.settings,/)
  assert.match(js, /risk:\s*\{\s*\.\.\.\(settings\.risk \|\| \{\}\),/)
  assert.match(js, /strategy:\s*\{\s*\.\.\.\(settings\.strategy \|\| \{\}\),\s*stopAtr:/)
})

test('the first migrated publish persists the strategy-versioned settings', () => {
  assert.match(api, /!isset\(\$existingSettings\['strategyId'\]\)/)
  assert.match(api, /isset\(\$publishedSettings\['strategyId'\]\)/)
  assert.match(api, /writeJsonFile\(SETTINGS_FILE, \$publishedSettings\)/)
})
