import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const parseRunnerEnv = (source = '') => Object.fromEntries(
  String(source).split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separator = line.indexOf('=')
      return separator > 0 ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] : null
    })
    .filter(Boolean),
)

// The timer normally receives this through systemd EnvironmentFile. Read the
// same protected file as a fallback so a changed secret is available on the
// very next runner pass even when systemd keeps an older service environment.
export const readRunnerEnvironment = ({
  env = process.env,
  configPath = env.BTC_BOT_CONFIG_PATH || path.join(os.homedir(), '.config', 'btc-bot.env'),
  readFileSync = fs.readFileSync,
} = {}) => {
  try {
    const processValues = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''))
    return { ...parseRunnerEnv(readFileSync(configPath, 'utf8')), ...processValues }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...env }
    throw error
  }
}
