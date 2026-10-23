import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadProject } from '../src/config'
import { doctor, initModeProblem, MARKETPLACE, PLUGIN_KEY, REPO } from '../src/doctor'

function project(settings: unknown, extraFiles: string[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'harness-doctor-'))
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  write(
    'harness.config.json',
    JSON.stringify({ generator: { model: 'opus' }, evaluator: { model: 'opus' } }),
  )
  write(
    'feature_list.json',
    JSON.stringify({
      project: 'x',
      last_updated: '2026-10-23',
      rules: {
        single_active_feature: true,
        passing_requires_evidence: true,
        do_not_skip_verification: true,
      },
      status_legend: { not_started: 'a', in_progress: 'b', blocked: 'c', passing: 'd' },
      features: [
        {
          id: 'F-000',
          priority: 0,
          area: 'harness',
          title: 'bootstrap',
          user_visible_behavior: 'x',
          status: 'not_started',
          verification: ['L1: pnpm check'],
          evidence: [],
          notes: '',
        },
      ],
    }),
  )
  for (const file of ['AGENTS.md', 'PROGRESS.md', 'init.sh', 'docs/harness/evaluator-rubric.md'])
    write(file, '')
  for (const file of extraFiles) write(file, '')
  write('.claude/settings.json', JSON.stringify(settings))
  return loadProject(dir)
}

const pinned = (ref: string) => ({
  extraKnownMarketplaces: { [MARKETPLACE]: { source: { source: 'github', repo: REPO, ref } } },
  enabledPlugins: { [PLUGIN_KEY]: true },
})

/** Stage init.sh with an explicit mode; update-index sets it the same way on every platform. */
function trackInit(root: string, chmod: '+x' | '-x') {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git('init', '--quiet')
  git('add', 'init.sh')
  git('update-index', `--chmod=${chmod}`, 'init.sh')
}

describe('doctor', () => {
  it('passes when the plugin is enabled and pinned to the package version', () => {
    const result = doctor(project(pinned('v1.2.3')), '1.2.3')
    expect(result.ok).toBe(true)
    expect(result.lines.filter((l) => l.status !== 'ok')).toEqual([])
  })

  it('fails when the plugin ref and the package version differ', () => {
    const result = doctor(project(pinned('v1.2.2')), '1.2.3')
    expect(result.ok).toBe(false)
    expect(result.lines.find((l) => l.status === 'error')?.text).toMatch(
      /ref is v1.2.2 but the installed package is 1.2.3/,
    )
  })

  it('fails when the plugin is not enabled or old hooks are still registered', () => {
    const hooks = {
      ...pinned('v1.2.3'),
      enabledPlugins: {},
      hooks: {
        Stop: [{ hooks: [{ command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/stop-guard.sh' }] }],
      },
    }
    const errors = doctor(project(hooks), '1.2.3')
      .lines.filter((l) => l.status === 'error')
      .map((l) => l.text)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatch(/enabledPlugins/)
    expect(errors[1]).toMatch(/old harness hooks/)
  })

  it('fails when init.sh is committed without the executable bit', () => {
    const p = project(pinned('v1.2.3'))
    trackInit(p.root, '-x')
    const result = doctor(p, '1.2.3')
    expect(result.ok).toBe(false)
    expect(result.lines.find((l) => l.status === 'error')?.text).toMatch(
      /init\.sh is committed as 100644.*git update-index --chmod=\+x init\.sh/,
    )
  })

  it('accepts an executable init.sh and skips the mode check outside git', () => {
    const p = project(pinned('v1.2.3'))
    expect(initModeProblem(p)).toBeUndefined()
    trackInit(p.root, '+x')
    expect(initModeProblem(p)).toBeUndefined()
    expect(doctor(p, '1.2.3').ok).toBe(true)
  })

  it('warns about leftover copies of the in-repo harness', () => {
    const result = doctor(project(pinned('v1.2.3'), ['scripts/harness-loop.ts']), '1.2.3')
    expect(result.ok).toBe(true)
    expect(result.lines.find((l) => l.status === 'warn')?.text).toMatch(/scripts\/harness-loop\.ts/)
  })
})
