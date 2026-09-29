#!/usr/bin/env node
// One bot pass. This is what the Pi timer and the Actions fallback both run.
//
// It exits 0 even when the pass reported an error, because a non-zero exit from
// a systemd timer unit turns into an alert and a restart loop, while the error
// is already recorded in the run log the dashboard shows. Only a failure to
// record anything at all is worth failing the process over.

import { createStateStore } from '../src/store.mjs'
import { runPass } from '../src/bot.mjs'
import { readRunnerEnvironment } from '../src/runner-env.mjs'
import { spawn } from 'node:child_process'

const env = readRunnerEnvironment()

const store = createStateStore({
  baseUrl: env.BOT_API_URL || '',
  key: env.BOT_API_KEY || '',
  localPath: env.BOT_STATE_FILE || '',
})

try {
  const { state, run, saved } = await runPass({ store, env })
  const parts = [
    `runner=${run.runner}`,
    `mode=${run.mode ?? 'n/a'}`,
    `action=${run.action}`,
    `duration=${run.durationMs}ms`,
    `published=${saved?.hosting ? 'yes' : 'no'}`,
  ]
  console.log(parts.join(' '))
  if (run.reason) console.log(`  ${run.reason}`)
  if (run.error) console.error(`  error: ${run.error}`)

  const runBacktests = run.commands?.some((entry) =>
    entry.command === 'run-backtests' && entry.outcome === 'backtest_started'
  )
  if (runBacktests) {
    // Backtests scan years of candles and must not occupy the minute-level
    // heartbeat service. The worker publishes its own running/complete/failed
    // status, so it can safely outlive this short pass.
    // `timeout` outlives this minute-level pass together with the detached
    // worker. Its hard kill is paired with the API heartbeat watchdog: a
    // computational loop cannot leave the dashboard permanently disabled.
    const timeoutSeconds = Math.max(60, Number(env.BOT_BACKTEST_TIMEOUT_SECONDS) || 90 * 60)
    const child = spawn('timeout', [
      '--foreground',
      '--signal=TERM',
      '--kill-after=30s',
      `${timeoutSeconds}s`,
      process.execPath,
      'tools/backtest-price-action-structure.mjs',
      '--publish',
    ], {
      cwd: process.cwd(),
      env: {
        ...env,
        BOT_BACKTEST_SETTINGS: JSON.stringify(state.settings ?? {}),
      },
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    console.log(`backtest-worker=started pid=${child.pid ?? 'n/a'}`)
  }
} catch (error) {
  console.error(`Bot pass could not be recorded at all: ${error.stack ?? error.message}`)
  process.exitCode = 1
}
