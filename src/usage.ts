/**
 * Subscription usage for the runtimes the user is signed into. Read-only: it borrows the login each CLI already
 * stores and asks the vendor's own usage endpoint, the same numbers `/usage` shows inside the CLI. The CLIs own
 * token refresh; an expired token is reported, never refreshed here.
 *
 * - Claude: OAuth token from the Keychain item "Claude Code-credentials" (read with /usr/bin/security, as Claude
 *   Code writes it, so no prompt), falling back to ~/.claude/.credentials.json; then
 *   GET api.anthropic.com/api/oauth/usage (+ /profile for the email).
 * - Codex: ~/.codex/auth.json (or $CODEX_HOME); then GET chatgpt.com/backend-api/wham/usage.
 *
 * Requests go through /usr/bin/curl so the user's proxy environment applies; the token is passed in a config on
 * stdin, never on the command line.
 */
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface UsageWindow {
  id: string
  label: string
  /** 0-100, null when the vendor omitted it. */
  usedPct: number | null
  /** ISO-8601. */
  resetsAt: string | null
}

export interface ProviderUsage {
  provider: 'claude' | 'codex'
  status: 'ok' | 'signedOut' | 'expired' | 'error'
  plan: string | null
  account: string | null
  windows: UsageWindow[]
  details: { label: string; value: string }[]
  error: string | null
}

const HTTP_TIMEOUT_SECONDS = 15
const CACHE_TTL_MS = 120_000
const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials'
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20'

type Json = Record<string, unknown>

function blank(provider: ProviderUsage['provider'], status: ProviderUsage['status'], error: string | null = null): ProviderUsage {
  return { provider, status, plan: null, account: null, windows: [], details: [], error }
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function obj(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined
}

interface HttpResult {
  status: number
  retryAfter: number | null
  body: string
}

/** GET with headers, via curl. Rejects when the host cannot be reached. */
function httpGet(url: string, headers: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/curl', ['--silent', '--show-error', '--max-time', String(HTTP_TIMEOUT_SECONDS), '--dump-header', '-', '--config', '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim().replace(/^curl: \(\d+\) /, '') || `curl exited with ${code}`))
      // A proxy CONNECT adds its own header block; the last block before the body is the real one.
      let rest = out
      let head = ''
      while (/^HTTP\/[\d.]+ \d{3}/.test(rest)) {
        const end = rest.search(/\r?\n\r?\n/)
        if (end === -1) break
        head = rest.slice(0, end)
        rest = rest.slice(end).replace(/^\r?\n\r?\n/, '')
      }
      const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(head)?.[1] ?? 0)
      const retry = /^retry-after:\s*(\d+)/im.exec(head)?.[1]
      resolve({ status, retryAfter: retry === undefined ? null : Number(retry), body: rest })
    })
    const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    child.stdin.end([`url = ${quote(url)}`, ...Object.entries(headers).map(([name, value]) => `header = ${quote(`${name}: ${value}`)}`)].join('\n'))
  })
}

// Claude

interface ClaudeOauth {
  accessToken: string
  expiresAt: number | null
  subscriptionType: string | null
  rateLimitTier: string | null
}

export function parseClaudeCredentials(raw: string): ClaudeOauth | undefined {
  try {
    const oauth = obj(obj(JSON.parse(raw))?.claudeAiOauth)
    const accessToken = str(oauth?.accessToken)
    if (oauth === undefined || accessToken === null) return undefined
    return { accessToken, expiresAt: num(oauth.expiresAt), subscriptionType: str(oauth.subscriptionType), rateLimitTier: str(oauth.rateLimitTier) }
  } catch {
    return undefined
  }
}

function securityLookup(args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', args, { timeout: 3000 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined))
  })
}

async function claudeCredentials(): Promise<ClaudeOauth | undefined> {
  // Claude Code derives the Keychain account from $USER (a fixed name for usernames with unusual characters).
  const user = process.env.USER ?? ''
  const account = user !== '' && /^[A-Za-z0-9._-]+$/.test(user) ? user : 'claude-code-user'
  if (process.platform === 'darwin') {
    for (const args of [
      ['find-generic-password', '-a', account, '-w', '-s', CLAUDE_KEYCHAIN_SERVICE],
      ['find-generic-password', '-w', '-s', CLAUDE_KEYCHAIN_SERVICE],
    ]) {
      const raw = await securityLookup(args)
      const oauth = raw === undefined ? undefined : parseClaudeCredentials(raw)
      if (oauth !== undefined) return oauth
    }
  }
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  try {
    return parseClaudeCredentials(await readFile(join(dir, '.credentials.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** "max" + "default_claude_max_20x" -> "Max 20x". */
export function claudePlan(subscription: string | null, tier: string | null): string | null {
  if (subscription === null || subscription === '') return null
  let label = subscription[0]!.toUpperCase() + subscription.slice(1)
  const last = tier?.split('_').at(-1)
  if (last && last.toLowerCase() !== subscription.toLowerCase()) label += ` ${last}`
  return label
}

function claudeWindow(id: string, label: string, value: unknown): UsageWindow | undefined {
  const window = obj(value)
  if (window === undefined) return undefined
  return { id, label, usedPct: num(window.utilization), resetsAt: str(window.resets_at) }
}

export function claudeWindows(response: Json): UsageWindow[] {
  const out = ([['five_hour', 'Session (5h)'], ['seven_day', 'Weekly']] as const)
    .map(([field, label]) => claudeWindow(field, label, response[field]))
    .filter((window): window is UsageWindow => window !== undefined)
  // Model- and surface-scoped weekly limits: the legacy top-level keys and the newer `limits[]` entries describe
  // the same limit. Merge by name, the `limits[]` entry winning.
  const scoped = ([['seven_day_opus', 'Opus']] as const)
    .map(([field, name]) => claudeWindow(`weekly_${name.toLowerCase()}`, `Weekly · ${name}`, response[field]))
    .filter((window): window is UsageWindow => window !== undefined)
  for (const entry of Array.isArray(response.limits) ? (response.limits as Json[]) : []) {
    if (entry.kind !== 'weekly_scoped') continue
    const scope = obj(entry.scope)
    let name: string | null = null
    for (const dimension of ['model', 'surface']) {
      const target = obj(scope?.[dimension])
      name = str(target?.display_name) ?? str(target?.id)
      if (name !== null) break
    }
    if (name === null) continue
    const id = `weekly_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
    const window: UsageWindow = { id, label: `Weekly · ${name}`, usedPct: num(entry.percent), resetsAt: str(entry.resets_at) }
    const previous = scoped.find((existing) => existing.id === id)
    if (previous === undefined) scoped.push(window)
    else {
      previous.usedPct = window.usedPct ?? previous.usedPct
      previous.resetsAt = window.resetsAt ?? previous.resetsAt
      previous.label = window.label
    }
  }
  return [...out, ...scoped]
}

/** Claude's usage endpoint answers 429 with a Retry-After in the tens of minutes; until it passes, say so instead of calling again. */
let claudeLimitedUntil = 0

async function claudeUsage(): Promise<ProviderUsage> {
  const oauth = await claudeCredentials()
  if (oauth === undefined) return blank('claude', 'signedOut')
  const report = blank('claude', 'ok')
  report.plan = claudePlan(oauth.subscriptionType, oauth.rateLimitTier)
  if (oauth.expiresAt !== null && oauth.expiresAt <= Date.now()) {
    report.status = 'expired'
    return report
  }
  if (claudeLimitedUntil > Date.now()) {
    return blank('claude', 'error', `Rate limited by Claude. Try again in ${Math.max(1, Math.ceil((claudeLimitedUntil - Date.now()) / 60_000))}m.`)
  }
  const headers = { Authorization: `Bearer ${oauth.accessToken}`, Accept: 'application/json', 'anthropic-beta': CLAUDE_OAUTH_BETA }
  const [usage, profile] = await Promise.allSettled([
    httpGet('https://api.anthropic.com/api/oauth/usage', headers),
    httpGet('https://api.anthropic.com/api/oauth/profile', headers),
  ])
  if (usage.status === 'rejected') return blank('claude', 'error', `Couldn't reach Anthropic (${String(usage.reason?.message ?? usage.reason)})`)
  const response = usage.value
  if (response.status === 401 || response.status === 403) {
    report.status = 'expired'
    return report
  }
  if (response.status === 429) {
    claudeLimitedUntil = Date.now() + (response.retryAfter ?? 600) * 1000
    return blank('claude', 'error', 'Rate limited by Claude. Try again later.')
  }
  if (response.status < 200 || response.status >= 300) return blank('claude', 'error', `Claude usage API returned ${response.status}`)
  let body: Json | undefined
  try {
    body = obj(JSON.parse(response.body))
  } catch {
    body = undefined
  }
  if (body === undefined) return blank('claude', 'error', 'Unreadable Claude usage response')
  report.windows = claudeWindows(body)
  const extra = obj(body.extra_usage)?.is_enabled
  if (typeof extra === 'boolean') report.details.push({ label: 'Extra usage', value: extra ? 'Enabled' : 'Disabled' })
  if (profile.status === 'fulfilled' && profile.value.status >= 200 && profile.value.status < 300) {
    try {
      report.account = str(obj(obj(JSON.parse(profile.value.body))?.account)?.email)
    } catch {
      // The email is a nicety.
    }
  }
  return report
}

// Codex

function durationLabel(seconds: number | null, fallback: string): [string, string] {
  const s = seconds === null ? 0 : Math.trunc(seconds)
  if (s === 604_800) return ['weekly', 'Weekly']
  if (s === 18_000) return ['five_hour', 'Session (5h)']
  if (s > 0 && s % 86_400 === 0) return [`${s}s`, `${s / 86_400}-day`]
  if (s > 0 && s % 3_600 === 0) return [`${s}s`, `${s / 3_600}-hour`]
  return [fallback.toLowerCase().replace(/ /g, '_'), fallback]
}

export function codexWindows(rateLimit: unknown, scope?: string): UsageWindow[] {
  const limits = obj(rateLimit)
  if (limits === undefined) return []
  const out: UsageWindow[] = []
  for (const [slot, fallback] of [['primary_window', 'Primary limit'], ['secondary_window', 'Secondary limit']] as const) {
    const window = obj(limits[slot])
    if (window === undefined) continue
    const [id, label] = durationLabel(num(window.limit_window_seconds), fallback)
    const reset = num(window.reset_at)
    out.push({
      id: scope === undefined ? id : `${scope}:${id}`,
      label: scope === undefined ? label : `${scope} · ${label}`,
      usedPct: num(window.used_percent),
      resetsAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    })
  }
  return out
}

/** 61671.934 -> "61,671.93". */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

async function codexUsage(): Promise<ProviderUsage> {
  let auth: Json | undefined
  try {
    auth = obj(JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), 'utf8')))
  } catch {
    return blank('codex', 'signedOut')
  }
  const tokens = obj(auth?.tokens)
  const token = str(tokens?.access_token)
  // An API-key-only login has no subscription quota to show.
  if (token === null) return blank('codex', 'signedOut')
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  }
  const accountId = str(tokens?.account_id)
  if (accountId !== null) headers['ChatGPT-Account-Id'] = accountId
  let response: HttpResult
  try {
    response = await httpGet('https://chatgpt.com/backend-api/wham/usage', headers)
  } catch (error) {
    return blank('codex', 'error', `Couldn't reach ChatGPT (${error instanceof Error ? error.message : String(error)})`)
  }
  if (response.status === 401 || response.status === 403) return blank('codex', 'expired')
  if (response.status < 200 || response.status >= 300) return blank('codex', 'error', `Codex usage API returned ${response.status}`)
  if (response.body.trimStart().startsWith('<')) return blank('codex', 'error', 'Codex usage API returned HTML')
  let body: Json | undefined
  try {
    body = obj(JSON.parse(response.body))
  } catch {
    body = undefined
  }
  if (body === undefined) return blank('codex', 'error', 'Unreadable Codex usage response')
  const report = blank('codex', 'ok')
  report.plan = str(body.plan_type)
  report.account = str(body.email)
  report.windows = codexWindows(body.rate_limit)
  for (const extra of Array.isArray(body.additional_rate_limits) ? (body.additional_rate_limits as Json[]) : []) {
    const name = str(extra.limit_name) ?? str(extra.metered_feature)
    if (name !== null) report.windows.push(...codexWindows(extra.rate_limit, name))
  }
  report.windows.push(...codexWindows(body.code_review_rate_limit, 'Code review'))
  const balance = num(obj(body.credits)?.balance)
  if (balance !== null) report.details.push({ label: 'Credits', value: `${formatNumber(balance)} left` })
  return report
}

let cache: { at: number; providers: ProviderUsage[] } | undefined

/** Both providers, each failing on its own. A snapshot younger than two minutes is reused unless `force`. */
export async function providerUsage(force = false): Promise<{ providers: ProviderUsage[]; fetchedAt: number }> {
  if (!force && cache !== undefined && Date.now() - cache.at < CACHE_TTL_MS) return { providers: cache.providers, fetchedAt: cache.at }
  const settled = await Promise.allSettled([claudeUsage(), codexUsage()])
  const providers = settled.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : blank(index === 0 ? 'claude' : 'codex', 'error', String(result.reason?.message ?? result.reason)))
  cache = { at: Date.now(), providers }
  return { providers, fetchedAt: cache.at }
}
