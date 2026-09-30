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
