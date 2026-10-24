/**
 * `harness selftest`: does the installed harness still work in this project? Loads the config and
 * the feature list, renders the prompts, and runs the plugin hooks the way Claude Code runs them:
 * the guard must still block its core cases and still allow the project's own commands
 * (`allowedTools`, the feature list's verification steps), and the lifecycle hooks must exit
 * cleanly. Ends with doctor.
 *
 *   harness selftest           print the checks; exit 1 when one fails
 *   harness selftest --json    the checks as JSON
 *
 * The loop runs it for the installed and the new version before an update and holds back a
 * release whose checks regress (src/loop.ts → maybeUpdate); the harness repository runs it in
 * `pnpm check`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { loadProject, type Project } from './config'
import { doctor } from './doctor'
import { nextReadyFeature, readFeatureList } from './feature-list'
import { evaluatorAgent, generatorTemplate, pluginDir, render } from './loop'
import { PACKAGE_ROOT } from './run'

export interface Check {
  name: string
  ok: boolean
  detail: string
}

/**
 * The literal commands of `Bash(…)` allow entries and `Ln: <command>` verification steps; a
 * trailing `*` or `:*` is a prefix match and is dropped, an entry with another wildcard is skipped.
 */
export function projectCommands(allowedTools: string[], verification: string[]): string[] {
  const commands = [
    ...allowedTools.map((t) => /^Bash\((.+)\)$/.exec(t.trim())?.[1] ?? ''),
    ...verification.map((v) => /^L\d+:\s*(.+)$/.exec(v.trim())?.[1] ?? ''),
  ]
    .map((c) => c.replace(/:?\*$/, '').trim())
    .filter((c) => c && !c.includes('*'))
  return [...new Set(commands)]
}

/** Checks that fail in `after` but did not fail in `before` (a check `before` lacks counts as ok). */
export function regressions(before: Check[], after: Check[]): Check[] {
  const failedBefore = new Set(before.filter((c) => !c.ok).map((c) => c.name))
  return after.filter((c) => !c.ok && !failedBefore.has(c.name))
}

interface HookRun {
  code: number
  out: string
  err: string
}

function runHook(
  plugin: string,
  hook: string,
  root: string,
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): HookRun {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root, ...env }
  if (!env.HARNESS_STOP_GUARD) delete childEnv.HARNESS_STOP_GUARD
  const res = spawnSync(process.execPath, [path.join(plugin, 'hooks', `${hook}.mjs`)], {
    cwd: root,
    input: JSON.stringify({ cwd: root, session_id: 'harness-selftest', ...input }),
    encoding: 'utf8',
    timeout: 30_000,
    env: childEnv,
  })
  return {
    code: res.status ?? 1,
    out: (res.stdout ?? '').trim(),
    err: (res.error?.message ?? res.stderr ?? '').trim(),
  }
}

/** `blocked` (exit 2 or deny), `asked`, `allowed`, or `crashed` with the hook's output. */
function guardDecision(run: HookRun): 'blocked' | 'asked' | 'allowed' | 'crashed' {
  if (run.code === 2) return 'blocked'
  if (run.code !== 0) return 'crashed'
  if (!run.out) return 'allowed'
  try {
    const decision = (
      JSON.parse(run.out) as { hookSpecificOutput?: { permissionDecision?: string } }
    ).hookSpecificOutput?.permissionDecision
    return decision === 'deny' ? 'blocked' : decision === 'ask' ? 'asked' : 'allowed'
  } catch {
    return 'crashed'
  }
}

const describe = (run: HookRun) => (run.err || run.out).split('\n').slice(0, 3).join(' ').trim()

function guardChecks(project: Project, plugin: string, verification: string[]): Check[] {
  const { root, config } = project
  const guard = (tool: string, toolInput: Record<string, unknown>) =>
    runHook(
      plugin,
      'guard',
      root,
      { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput },
      { HARNESS_LOOP: '1' },
    )
  const outside = path.join(path.parse(root).root, 'harness-selftest-outside', 'file.txt')
  const mustBlock: [string, string, Record<string, unknown>][] = [
    ['force push', 'Bash', { command: 'git push --force origin main' }],
    ['push from a loop session', 'Bash', { command: 'git push origin feature' }],
    ['write outside the worktree', 'Write', { file_path: outside, content: 'x' }],
    [
      'lockfile edit',
      'Edit',
      { file_path: path.join(root, 'pnpm-lock.yaml'), old_string: 'a', new_string: 'b' },
    ],
    ['evaluator from a loop session', 'Agent', { subagent_type: 'harness:evaluator', prompt: 'x' }],
  ]
  const checks: Check[] = mustBlock.map(([label, tool, input]) => {
    const run = guard(tool, input)
    const decision = guardDecision(run)
    return {
      name: `guard blocks: ${label}`,
      ok: decision === 'blocked',
      detail: decision === 'blocked' ? 'blocked' : `${decision}: ${describe(run)}`,
    }
  })
  const sourceFile = path.join(root, config.project.sourceDirs[0] ?? 'src', 'harness-selftest.ts')
  const mustAllow: [string, string, Record<string, unknown>][] = [
    ...projectCommands(['Bash(git status)', ...config.allowedTools], verification).map(
      (command): [string, string, Record<string, unknown>] => [command, 'Bash', { command }],
    ),
    [
      `write ${path.relative(root, sourceFile).replace(/\\/g, '/')}`,
      'Write',
      { file_path: sourceFile, content: 'export {}\n' },
    ],
  ]
  for (const [label, tool, input] of mustAllow) {
    const run = guard(tool, input)
    const decision = guardDecision(run)
    checks.push({
      name: `guard allows: ${label}`,
      ok: decision === 'allowed',
      detail: decision === 'allowed' ? 'allowed' : `${decision}: ${describe(run)}`,
    })
  }
  return checks
}

function lifecycleChecks(project: Project, plugin: string): Check[] {
  const { root } = project
  const start = runHook(plugin, 'session-start', root, { hook_event_name: 'SessionStart' })
  const stop = runHook(plugin, 'stop-guard', root, { hook_event_name: 'Stop' })
  const format = runHook(plugin, 'format', root, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: path.join(os.tmpdir(), 'harness-selftest-format.txt') },
  })
  return [
    {
      name: 'session-start hook prints the session state',
      ok: start.code === 0 && start.out.length > 0,
      detail:
        start.code === 0 ? `${start.out.length} chars` : `exit ${start.code}: ${describe(start)}`,
    },
    {
      name: 'stop hook is inert outside the loop',
      ok: stop.code === 0 && !stop.out,
      detail:
        stop.code === 0 ? (stop.out ? stop.out : 'exit 0') : `exit ${stop.code}: ${describe(stop)}`,
    },
    {
      name: 'format hook exits cleanly',
      ok: format.code === 0,
      detail: format.code === 0 ? 'exit 0' : `exit ${format.code}: ${describe(format)}`,
    },
  ]
}

function attempt(name: string, fn: () => string): Check {
  try {
    return { name, ok: true, detail: fn() }
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

export function selftest(root: string = process.cwd()): Check[] {
  let project: Project
  try {
    project = loadProject(root)
  } catch (error) {
    return [
      {
        name: 'config loads',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      },
    ]
  }
  const { config } = project
  const checks: Check[] = [{ name: 'config loads', ok: true, detail: project.root }]
  let verification: string[] = []
  checks.push(
    attempt('feature list loads', () => {
      const list = readFeatureList(project.resolve(config.project.featureList), config.features)
      verification = list.features.flatMap((f) => f.verification)
      const next = nextReadyFeature(list)
      return `${list.features.length} features; next ready: ${next?.id ?? 'none'}`
    }),
  )
  const plugin = pluginDir(project.root)
  checks.push(
    attempt('generator prompt renders', () => {
      const prompt = render(generatorTemplate(project), {
        FEATURE_ID: 'F-000',
        FEATURE_TITLE: 'selftest',
        ATTEMPT: '1',
        MAX_ATTEMPTS: '2',
        CONTEXT: '',
      })
      const left = prompt.match(/\{\{\w+\}\}/g)
      if (left) throw new Error(`placeholders left: ${[...new Set(left)].join(', ')}`)
      return `${prompt.length} chars`
    }),
    attempt('evaluator agent parses', () => `tools ${evaluatorAgent(plugin).tools}`),
    attempt('evaluator schema parses', () => {
      JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'prompts', 'evaluator-schema.json'), 'utf8'))
      return 'ok'
    }),
    ...['ci-fixer.md', 'safety-review.md'].map((name) =>
      attempt(`prompt ${name} exists`, () => {
        if (!existsSync(path.join(PACKAGE_ROOT, 'prompts', name))) throw new Error('missing')
        return 'ok'
      }),
    ),
  )
  checks.push(...guardChecks(project, plugin, verification), ...lifecycleChecks(project, plugin))
  const health = doctor(project)
  const errors = health.lines.filter((l) => l.status === 'error').map((l) => l.text)
  checks.push({ name: 'doctor', ok: health.ok, detail: errors.join('; ') || 'ok' })
  return checks
}

export function selftestCommand(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean', default: false } },
  })
  const checks = selftest()
  if (values.json) console.log(JSON.stringify(checks, null, 2))
  else
    for (const c of checks)
      console.log(`  [${c.ok ? 'ok' : 'FAIL'}] ${c.name}${c.ok ? '' : ` — ${c.detail}`}`)
  const failed = checks.filter((c) => !c.ok).length
  if (!values.json)
    console.log(failed ? `\nselftest: ${failed} check(s) failed` : '\nselftest: all checks passed')
  return failed ? 1 : 0
}
