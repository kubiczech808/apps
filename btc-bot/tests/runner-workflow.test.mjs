import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workflow = await readFile(new URL('../../.github/workflows/btcbot-rpi-deploy.yml', import.meta.url), 'utf8')

test('the Raspberry Pi deployment verifies the effective price-action refresh', () => {
  assert.match(workflow, /priceActionRefresh: state\.priceActionEntryCheck\?\.refreshMinutes/)
  assert.doesNotMatch(workflow, /priceActionRefresh: state\.settings\?\.priceActionStructure\?\.refreshMinutes/)
})
