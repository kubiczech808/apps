import assert from 'node:assert/strict'
import test from 'node:test'

import { parseRunnerEnv, readRunnerEnvironment } from '../src/runner-env.mjs'

test('runner environment reads the protected config file and process variables win', () => {
  const fileEnv = parseRunnerEnv('# comment\nTWELVE_DATA_API_KEY=from-file\nBOT_API_URL=https://example.test/api\n')
  assert.deepEqual(fileEnv, {
    TWELVE_DATA_API_KEY: 'from-file',
    BOT_API_URL: 'https://example.test/api',
  })

  const env = readRunnerEnvironment({
    env: { BOT_API_URL: 'https://override.test/api', TWELVE_DATA_API_KEY: '' },
    configPath: '/runner.env',
    readFileSync: () => 'TWELVE_DATA_API_KEY=from-file\nBOT_API_URL=https://example.test/api\n',
  })
  assert.equal(env.TWELVE_DATA_API_KEY, 'from-file')
  assert.equal(env.BOT_API_URL, 'https://override.test/api')
})

test('detached backtests receive a bounded runtime and are covered by the progress watchdog', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const runner = readFileSync(fileURLToPath(new URL('../tools/run-bot.mjs', import.meta.url)), 'utf8')
  assert.match(runner, /spawn\('timeout'/)
  assert.match(runner, /--kill-after=30s/)
  assert.match(runner, /BOT_BACKTEST_TIMEOUT_SECONDS/)
})
