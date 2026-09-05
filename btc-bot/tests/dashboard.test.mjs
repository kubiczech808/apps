import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const read = (relative) => readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8')

const css = read('assets/app.css')
const html = read('index.html')
const js = read('assets/app.js')

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
