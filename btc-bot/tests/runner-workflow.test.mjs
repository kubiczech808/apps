import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(new URL('../../.github/workflows/btcbot-rpi-deploy.yml', import.meta.url), 'utf8')

test('the Raspberry Pi deployment verifies the effective price-action refresh', () => {
  assert.match(workflow, /priceActionRefresh: state\.priceActionEntryCheck\?\.refreshMinutes/)
  assert.doesNotMatch(workflow, /priceActionRefresh: state\.settings\?\.priceActionStructure\?\.refreshMinutes/)
})

test('the Raspberry Pi timer runs the canonical deployed runtime, not a nested checkout', async () => {
  const service = await readFile(new URL('../systemd/btc-bot-system.service', import.meta.url), 'utf8')
  assert.match(workflow, /systemd\/btc-bot-system\.service \/etc\/systemd\/system\/btc-bot\.service/)
  assert.match(workflow, /sudo systemctl enable --now btc-bot\.timer/)
  assert.doesNotMatch(workflow, /user_systemctl/)
  assert.match(service, /WorkingDirectory=\/home\/openclaw2\/.local\/lib\/btc-bot/)
  assert.doesNotMatch(service, /btc-bot\/btc-bot/)
})

test('the Raspberry Pi resolves the same dashboard key as the web deploy', () => {
  assert.match(workflow, /name: Resolve the dashboard key for the primary runner/)
  assert.match(workflow, /BTC_BOT_KEY: \$\{\{ secrets\.BTC_BOT_KEY \}\}/)
  assert.match(workflow, /BTCDCA_FTP_PASSWORD: \$\{\{ secrets\.BTCDCA_FTP_PASSWORD \}\}/)
  assert.match(workflow, /BOT_API_KEY="\$BOT_API_KEY" python3/)
  assert.match(workflow, /updated\.append\(f"BOT_API_KEY=\{key\}"\)/)
  assert.doesNotMatch(workflow, /BOT_API_KEY=ahoj1234567890/)
})

test('a rejected Pi publication exposes only safe operational diagnostics', () => {
  assert.match(workflow, /name: Diagnose rejected dashboard publication/)
  assert.match(workflow, /if: failure\(\)/)
  assert.match(workflow, /State was not published\|api\\\.php \(publish\|lease\) HTTP/)
  assert.match(workflow, /keyFingerprint/)
  assert.doesNotMatch(workflow, /console\.log\(\{[\s\S]*apiKey/)
})
