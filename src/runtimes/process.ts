/** Spawning a CLI turn: own process group, JSON lines out, group kill on stop. */
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

/** Where CLIs commonly live when the host was started from a GUI and PATH is thin. */
const EXTRA_DIRS = ['.local/bin', '.npm-global/bin', '.bun/bin', '.volta/bin', 'bin'].map((dir) => join(homedir(), dir))
  .concat(['/opt/homebrew/bin', '/usr/local/bin'])

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** An explicit path if it runs, else the first match on PATH and the usual install dirs. */
export function findCommand(name: string, override = ''): string | undefined {
  if (override !== '') {
    if (isAbsolute(override)) return executable(override) ? override : undefined
    name = override
  }
  const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_DIRS]
  for (const dir of dirs) {
    const path = join(dir, name)
    if (executable(path)) return path
  }
  return undefined
}

/** PATH with the usual install dirs appended, so a CLI's own `#!/usr/bin/env node` still resolves. */
export function childEnv(extra: Record<string, string> = {}, drop: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const key of drop) delete env[key]
  const have = new Set((env.PATH ?? '').split(delimiter))
  env.PATH = [env.PATH ?? '', ...EXTRA_DIRS.filter((dir) => !have.has(dir))].filter(Boolean).join(delimiter)
  return env
}

/** SIGTERM the child's whole process group, SIGKILL if it lingers. */
export function killGroup(child: ChildProcess, graceMs = 2000): void {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name)
    } catch {
      try {
        child.kill(name)
      } catch {
        // already gone
      }
    }
  }
  signal('SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal('SIGKILL')
  }, graceMs).unref()
}

export interface LineChild {
  readonly child: ChildProcess
  /** Resolves when the process has closed, with its exit code and the tail of stderr. */
  readonly closed: Promise<{ code: number | null; stderr: string }>
}

/** Starts `command` in its own process group and feeds each stdout line to `onLine`. */
export function spawnLines(options: {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Written to stdin, which is then closed. Omit to keep stdin open (`keepStdin`) or ignored. */
  stdin?: string
  keepStdin?: boolean
  onLine: (line: string) => void
}): LineChild {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: [options.stdin !== undefined || options.keepStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  let buffer = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() !== '') options.onLine(line)
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000)
  })
  child.stdin?.on('error', () => {})
  if (options.stdin !== undefined) child.stdin?.end(options.stdin)
  const closed = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on('error', (error) => resolve({ code: null, stderr: `${stderr}\n${error.message}`.trim() }))
    child.on('close', (code) => {
      if (buffer.trim() !== '') options.onLine(buffer)
      resolve({ code, stderr })
    })
  })
  return { child, closed }
}

export function parseJson(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The last non-empty lines of stderr, for an error message. */
export function stderrTail(stderr: string, lines = 4): string {
  return stderr.split('\n').map((line) => line.trim()).filter(Boolean).slice(-lines).join(' | ').slice(0, 600)
}
