#!/usr/bin/env node
// One bot pass. This is what the Pi timer and the Actions fallback both run.
//
// It exits 0 even when the pass reported an error, because a non-zero exit from
// a systemd timer unit turns into an alert and a restart loop, while the error
// is already recorded in the run log the dashboard shows. Only a failure to
// record anything at all is worth failing the process over.

import { createStateStore } from '../src/store.mjs'
import { runPass } from '../src/bot.mjs'

const store = createStateStore({
  baseUrl: process.env.BOT_API_URL || '',
  key: process.env.BOT_API_KEY || '',
  localPath: process.env.BOT_STATE_FILE || '',
})

try {
  const { run, saved } = await runPass({ store })
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
} catch (error) {
  console.error(`Bot pass could not be recorded at all: ${error.stack ?? error.message}`)
  process.exitCode = 1
}
