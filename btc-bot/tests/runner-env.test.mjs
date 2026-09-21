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
