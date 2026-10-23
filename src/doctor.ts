/**
 * `harness doctor`: is this project wired to the shared harness correctly? Run by init.sh and by
 * the loop driver's preflight. Errors fail the command; warnings only report.
 *
 * - `harness.config.json` and the feature list are valid.
 * - The plugin is enabled in `.claude/settings.json`, and its marketplace is pinned to the same
 *   tag as the installed package (`v<version>`), so interactive sessions and driver-run sessions
 *   (which load the plugin from the package) run the same harness.
 * - Files the harness reads exist (AGENTS.md, PROGRESS.md, the init script, the evaluator rubric,
 *   the generator notes file when configured).
 * - No leftover copies of the old in-repo harness (they would run their hooks twice).
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { loadProject, type Project } from './config'
import { readFeatureList } from './feature-list'
import { PACKAGE_ROOT } from './run'

export const MARKETPLACE = 'eemelinen-harness'
export const PLUGIN_KEY = `harness@${MARKETPLACE}`
export const REPO = 'Eemelinen/harness'

export interface DoctorLine {
  status: 'ok' | 'warn' | 'error'
  text: string
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    version: string
  }
  return pkg.version
}

interface ClaudeSettings {
  extraKnownMarketplaces?: Record<
    string,
    { source?: { source?: string; repo?: string; ref?: string } }
  >
  enabledPlugins?: Record<string, boolean>
  hooks?: unknown
}

const legacyCopies = [
  'scripts/harness-loop.ts',
  'scripts/harness-feature.ts',
  'scripts/verify-feature.ts',
  'scripts/validate-feature-list.ts',
  'scripts/harness-events.ts',
  'scripts/clean-state-check.sh',
  '.claude/hooks/guard.sh',
  '.claude/hooks/stop-guard.sh',
  '.claude/skills/clock-in/SKILL.md',
  '.claude/skills/clock-out/SKILL.md',
  '.claude/skills/verify-feature/SKILL.md',
  '.claude/agents/evaluator.md',
]

export function doctor(
  project: Project,
  version: string = packageVersion(),
): { ok: boolean; lines: DoctorLine[] } {
  const lines: DoctorLine[] = []
  const add = (status: DoctorLine['status'], text: string) => lines.push({ status, text })
  const { config } = project

  add(
    'ok',
    `@eemelinen/harness ${version} · config ${path.join(project.root, 'harness.config.json')}`,
  )
  try {
    readFeatureList(project.resolve(config.project.featureList), config.features)
    add('ok', `${config.project.featureList} is valid`)
  } catch (error) {
    add('error', error instanceof Error ? error.message : String(error))
  }

  const settingsFile = project.resolve('.claude', 'settings.json')
  let settings: ClaudeSettings = {}
  try {
    settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as ClaudeSettings
  } catch {
    add('error', '.claude/settings.json is missing or not valid JSON')
  }
  if (settings.enabledPlugins?.[PLUGIN_KEY] === true) add('ok', `plugin ${PLUGIN_KEY} enabled`)
  else add('error', `.claude/settings.json → enabledPlugins["${PLUGIN_KEY}"] must be true`)
  const source = settings.extraKnownMarketplaces?.[MARKETPLACE]?.source
  const expectedRef = `v${version}`
  if (!source) {
    add('error', `.claude/settings.json → extraKnownMarketplaces["${MARKETPLACE}"] is missing`)
  } else if (source.source === 'github' && source.repo === REPO) {
    if (source.ref === expectedRef) add('ok', `plugin marketplace pinned to ${expectedRef}`)
    else
      add(
        'error',
        `plugin marketplace ref is ${source.ref ?? '(none)'} but the installed package is ${version}; set ref to "${expectedRef}" (or install the matching package)`,
      )
  } else {
    add('warn', `plugin marketplace source is ${JSON.stringify(source)} (local development?)`)
  }

  const hooks = JSON.stringify(settings.hooks ?? {})
  if (/\.claude\/hooks\/(guard|stop-guard|session-start|format)\.sh/.test(hooks))
    add(
      'error',
      '.claude/settings.json still registers the old harness hooks; the plugin provides them',
    )

  const required = [
    'AGENTS.md',
    config.project.progress,
    config.project.init,
    'docs/harness/evaluator-rubric.md',
    ...(config.prompts.generatorNotes ? [config.prompts.generatorNotes] : []),
  ]
  const missing = required.filter((f) => !existsSync(project.resolve(f)))
  if (missing.length === 0) add('ok', `project files present (${required.join(', ')})`)
  else add('error', `missing project files: ${missing.join(', ')}`)

  const leftovers = legacyCopies.filter((f) => existsSync(project.resolve(f)))
  if (leftovers.length > 0)
    add('warn', `old in-repo harness files still present: ${leftovers.join(', ')}`)

  return { ok: lines.every((l) => l.status !== 'error'), lines }
}

export function doctorCommand(_argv: string[], project: Project = loadProject()): number {
  const result = doctor(project)
  for (const line of result.lines)
    console.log(`  [${line.status}]${' '.repeat(6 - line.status.length)}${line.text}`)
  console.log(result.ok ? 'harness doctor: ok' : 'harness doctor: errors found')
  return result.ok ? 0 : 1
}
