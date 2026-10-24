/** Process helpers shared by the commands. */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The installed package's root (prompts, plugin, templates live here). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export interface ResolvedCommand {
  cmd: string
  args: string[]
  shell: boolean
}

/**
 * On Windows `pnpm` is a `.cmd` shim (or a corepack shim) that spawnSync cannot run without a
 * shell, and a shell mangles arguments with spaces (`--reason`); run pnpm's own entry point
 * through node. Outside `pnpm run` (a hook calling the CLI directly) `npm_execpath` is unset;
 * then the command goes through the shell with each argument quoted.
 */
export function resolveCommand(cmd: string, args: string[]): ResolvedCommand {
  if (process.platform !== 'win32' || cmd !== 'pnpm') return { cmd, args, shell: false }
  const pnpmEntry = process.env.npm_execpath
  if (pnpmEntry) return { cmd: process.execPath, args: [pnpmEntry, ...args], shell: false }
  // One command string: Node deprecates passing an argument list together with `shell`.
  return { cmd: [cmd, ...args.map(quoteForCmd)].join(' '), args: [], shell: true }
}

function quoteForCmd(arg: string): string {
  return /^[\w./:=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`
}

export interface ShResult {
  code: number
  out: string
  err: string
}

export function sh(
  command: string,
  commandArgs: string[],
  opts: { cwd: string; quiet?: boolean; env?: Record<string, string | undefined> },
): ShResult {
  const { cmd, args, shell } = resolveCommand(command, commandArgs)
  const res: SpawnSyncReturns<string> = spawnSync(cmd, args, {
    cwd: opts.cwd,
    shell,
    encoding: 'utf8',
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'pipe', 'inherit'],
    env: { ...process.env, ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  })
  return { code: res.status ?? 1, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() }
}

/** Variables through which `gh` and git reach a GitHub token. */
const TOKEN_VARIABLES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]

/**
 * The environment of a driver-started Claude session. Sessions never need GitHub, because the
 * driver pushes, opens PRs and reads CI. So the session gets no GitHub token: the token variables
 * are removed, and `gh` gets an empty config directory, so its stored login (`gh auth login`)
 * is not found either. A session that reads injected text (an issue, a PR, a trace) therefore
 * cannot act as the owner on GitHub. `git push` is also blocked by the guard.
 */
export function sessionEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra }
  for (const name of TOKEN_VARIABLES) delete env[name]
  const ghConfig = path.join(tmpdir(), 'harness-session-gh')
  mkdirSync(ghConfig, { recursive: true })
  env.GH_CONFIG_DIR = ghConfig
  env.GH_PROMPT_DISABLED = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

/** Run a configured command line (`docker info`, `pnpm db:up`) through the platform shell. */
export function shellLine(line: string, cwd: string, quiet = true): ShResult {
  const res = spawnSync(line, {
    cwd,
    shell: true,
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  return { code: res.status ?? 1, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() }
}
