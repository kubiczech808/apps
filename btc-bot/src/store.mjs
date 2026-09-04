// Where the state lives.
//
// The hosting is the single source of truth, reached over HTTPS rather than
// FTP: two runners (the Pi on a one-minute timer, GitHub Actions as the
// fallback) have to agree on one document, and an HTTP endpoint can arbitrate
// — with a lease — where two FTP clients writing the same file cannot.
//
// A local copy is still written when a path is configured. It is a cache and a
// post-mortem artefact, never the authority: if the two disagree, the hosting
// wins, because that is what the other runner and the dashboard read.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const readJsonFile = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

export const createStateStore = ({
  baseUrl,
  key,
  localPath,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
  logger = console,
} = {}) => {
  const call = async (action, { method = 'GET', body } = {}) => {
    if (!baseUrl) throw new Error('no BOT_API_URL configured')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${baseUrl}?action=${action}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(key ? { 'X-Bot-Key': key } : {}),
        },
        body,
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`api.php ${action} HTTP ${response.status}: ${text.slice(0, 200)}`)
      return text ? JSON.parse(text) : null
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    baseUrl,

    load: async () => {
      if (baseUrl) {
        try {
          const payload = await call('state')
          if (payload && payload.state) {
            return { state: payload.state, commands: payload.commands ?? [], origin: 'hosting' }
          }
          // A hosting that answers but holds no state yet is still the
          // authority; falling back to a stale local copy here would
          // resurrect positions the operator had already cleared.
          if (payload) return { state: null, commands: payload.commands ?? [], origin: 'hosting-empty' }
        } catch (error) {
          logger.warn(`Could not load state from hosting (${error.message}); falling back to local copy`)
        }
      }
      if (localPath) {
        const local = await readJsonFile(localPath)
        if (local) return { state: local, commands: [], origin: 'local' }
      }
      return { state: null, commands: [], origin: 'none' }
    },

    /**
     * `localOnly` is for the runner that just lost the lease. Publishing there
     * would overwrite whatever the lease holder has since published with the
     * state this runner read BEFORE it was refused — the dashboard would flick
     * back to a stale set of positions once every fallback tick.
     */
    save: async (state, { localOnly = false } = {}) => {
      const serialised = JSON.stringify(state)
      const results = { local: false, hosting: false, error: null }

      if (localPath) {
        await mkdir(dirname(localPath), { recursive: true })
        await writeFile(localPath, serialised, 'utf8')
        results.local = true
      }

      if (baseUrl && !localOnly) {
        try {
          await call('publish', { method: 'POST', body: serialised })
          results.hosting = true
        } catch (error) {
          results.error = error.message
        }
      }

      return results
    },

    /**
     * Claim the right to act for `ttlMs`.
     *
     * The Pi runs every minute and Actions every fifteen. Without a lease both
     * could read the same "no position" state and open two. The hosting holds
     * the lease so the loser finds out before it trades, not after.
     */
    claimLease: async ({ owner, ttlMs }) => {
      if (!baseUrl) return { granted: true, owner, reason: 'no hosting configured' }
      return call('lease', { method: 'POST', body: JSON.stringify({ owner, ttlMs }) })
    },
  }
}
