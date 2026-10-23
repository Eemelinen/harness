/**
 * Machine-checkable part of the clean-state checklist (AGENTS.md → Clock-out). Read-only and
 * idempotent; exit 0 only when every check passes.
 *
 *   harness clean-state                     full run (includes FAST=1 ./init.sh)
 *   harness clean-state --quick             skip init.sh (used by the Stop hook and the driver)
 *   harness clean-state --allow-state-dirty tolerate uncommitted state files (project.stateFiles)
 *   harness clean-state --require-terminal  fail if any feature is still in_progress
 *                                           (driver-run sessions must end passing or blocked)
 *   harness clean-state --base <ref>        diff base for the branch checks
 *                                           (default: origin/<defaultBranch>, then <defaultBranch>)
 *
 * Always checked: working tree, feature list, PROGRESS.md touched on the branch, `.env` not
 * tracked, the restart path. Project checks (no `.only`, coverage thresholds kept, no debug
 * output, marker blocks intact) come from `harness.config.json` → `cleanState`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { loadProject, type Project } from './config'
import { readFeatureList, summarizeFeatureList } from './feature-list'

export interface CleanStateOptions {
  quick?: boolean
  allowStateDirty?: boolean
  requireTerminal?: boolean
  base?: string
}

export interface CheckLine {
  status: 'ok' | 'fail' | 'skip'
  text: string
  details?: string[]
}

export interface CleanStateResult {
  ok: boolean
  base: string
  branch: string
  lines: CheckLine[]
}

function git(root: string, args: string[]): { code: number; out: string } {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: res.status ?? 1, out: res.stdout ?? '' }
}

/** Path of a `git status --porcelain` line (the destination of a rename). */
function porcelainPath(line: string): string {
  const raw = line.slice(3)
  const target = raw.includes(' -> ') ? (raw.split(' -> ')[1] ?? raw) : raw
  return target.replace(/^"|"$/g, '')
}

export function isStateFile(file: string, stateFiles: readonly string[]): boolean {
  return stateFiles.some((s) => (s.endsWith('/') ? file.startsWith(s) : file === s))
}

export function cleanState(project: Project, options: CleanStateOptions = {}): CleanStateResult {
  const { root, config } = project
  const lines: CheckLine[] = []
  const ok = (text: string) => lines.push({ status: 'ok', text })
  const fail = (text: string, details?: string[]) => lines.push({ status: 'fail', text, details })
  const skip = (text: string) => lines.push({ status: 'skip', text })
  const defaultBranch = config.project.defaultBranch
  const remoteBase = `${config.project.remote}/${defaultBranch}`
  const base =
    options.base ??
    (git(root, ['rev-parse', '--verify', '--quiet', remoteBase]).code === 0
      ? remoteBase
      : defaultBranch)
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim()

  // 1. Working tree
  const dirty = git(root, ['status', '--porcelain']).out.split('\n').filter(Boolean)
  if (dirty.length === 0) {
    ok('working tree is clean')
  } else if (options.allowStateDirty) {
    const other = dirty.filter((l) => !isStateFile(porcelainPath(l), config.project.stateFiles))
    if (other.length === 0) ok('only state files are uncommitted (allowed)')
    else fail('uncommitted changes outside the state files:', other)
  } else {
    fail(
      'working tree is dirty (commit, or pass --allow-state-dirty when only state files changed):',
      dirty.slice(0, 10),
    )
  }

  // 2. Feature list
  const listFile = project.resolve(config.project.featureList)
  try {
    const list = readFeatureList(listFile, config.features)
    ok(`${config.project.featureList} OK — ${summarizeFeatureList(list)}`)
    if (options.requireTerminal) {
      const active = list.features.filter((f) => f.status === 'in_progress').map((f) => f.id)
      if (active.length === 0) ok('no feature left in_progress (session ended passing or blocked)')
      else
        fail(
          `${active.join(',')} is still in_progress; run /harness:verify-feature or mark it blocked before stopping`,
        )
    }
  } catch (error) {
    fail(`harness check: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 3. Branch diff checks (committed + uncommitted, relative to base)
  const added = (paths: string[]): string[] => {
    const diff = git(root, ['diff', base, '--', ...paths])
      .out.split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '--', ...paths])
      .out.split('\n')
      .filter(Boolean)
      .flatMap((f) => {
        const file = project.resolve(f)
        return existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
      })
    return [...diff, ...untracked]
  }
  const removed = (paths: string[]): string[] =>
    git(root, ['diff', base, '--', ...paths])
      .out.split('\n')
      .filter((l) => l.startsWith('-') && !l.startsWith('---'))

  if (git(root, ['rev-parse', '--verify', '--quiet', base]).code !== 0) {
    skip(`base ${base} does not exist; diff checks skipped`)
  } else {
    for (const check of config.cleanState.checks) {
      const pattern = new RegExp(check.pattern)
      const candidates = check.kind === 'added' ? added(check.paths) : removed(check.paths)
      const hits = candidates.filter((l) => pattern.test(l))
      if (hits.length > 0)
        fail(
          check.message,
          hits.slice(0, 3).map((h) => h.trim().slice(0, 160)),
        )
      else ok(check.name)
    }
    const progress = config.project.progress
    const branchFiles = git(root, ['diff', '--name-only', base]).out.split('\n').filter(Boolean)
    if (branchFiles.length === 0) skip(`no diff against ${base}; ${progress} check not applicable`)
    else if (!branchFiles.includes(progress))
      fail(
        `${progress} was not updated on this branch (Current Verified State, session entry, Next Steps)`,
      )
    else ok(`${progress} updated on this branch`)
  }

  // 4. Secrets and protected file content
  const tracked = git(root, ['ls-files', '--error-unmatch', '.env']).code === 0
  const staged = git(root, ['diff', '--cached', '--name-only']).out.split('\n').includes('.env')
  if (tracked || staged) fail('.env is tracked or staged')
  else ok('.env is not tracked or staged')
  for (const check of config.cleanState.files) {
    const file = project.resolve(check.file)
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (check.mustContain.every((s) => text.includes(s))) ok(check.name)
    else fail(check.message)
  }

  // 5. Restart path
  if (options.quick) {
    skip(`FAST=1 ${config.project.init} (--quick)`)
  } else {
    const init = spawnSync('bash', [config.project.init], {
      cwd: root,
      env: { ...process.env, FAST: '1' },
      stdio: 'ignore',
    })
    if (init.status === 0) ok(`FAST=1 ${config.project.init} exits 0`)
    else fail(`FAST=1 ${config.project.init} failed; the next session cannot start cleanly`)
  }

  return { ok: lines.every((l) => l.status !== 'fail'), base, branch, lines }
}

export function formatCleanState(result: CleanStateResult, color: boolean): string {
  const paint = (code: number, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text)
  const tag = { ok: paint(32, '[ok]  '), fail: paint(31, '[FAIL]'), skip: paint(33, '[skip]') }
  const out = [`clean-state check (base: ${result.base}, branch: ${result.branch})`]
  for (const line of result.lines) {
    out.push(`  ${tag[line.status]} ${line.text}`)
    for (const detail of line.details ?? []) out.push(`         ${detail}`)
  }
  const failures = result.lines.filter((l) => l.status === 'fail').length
  out.push(
    '',
    failures === 0 ? 'clean-state: all checks passed' : `clean-state: ${failures} check(s) failed`,
  )
  return out.join('\n')
}

export function cleanStateCommand(argv: string[], project: Project = loadProject()): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      quick: { type: 'boolean', default: false },
      'allow-state-dirty': { type: 'boolean', default: false },
      'require-terminal': { type: 'boolean', default: false },
      base: { type: 'string' },
    },
  })
  const result = cleanState(project, {
    quick: values.quick,
    allowStateDirty: values['allow-state-dirty'],
    requireTerminal: values['require-terminal'],
    base: values.base,
  })
  console.log(formatCleanState(result, Boolean(process.stdout.isTTY)))
  return result.ok ? 0 : 1
}
