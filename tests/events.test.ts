import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  describeEvent,
  describeToolUse,
  heartbeat,
  milestoneOf,
  milestoneStatus,
  newStreamState,
  shortPath,
  summarizeOutput,
} from '../src/events'

const cwd = path.resolve('/work/F-046')

const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: {
    id: `msg-${id}`,
    content: [{ type: 'tool_use', id, name, input }],
    usage: { output_tokens: 1500 },
  },
})

const toolResult = (id: string, content: string, isError = false) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
})

describe('describeToolUse', () => {
  it('names what each tool call does', () => {
    expect(describeToolUse('Bash', { command: 'pnpm check', description: 'Run L1' }, cwd)).toBe(
      'bash: Run L1 · pnpm check',
    )
    expect(describeToolUse('Bash', { command: 'git status --short' }, cwd)).toBe(
      'bash: git status --short',
    )
    expect(describeToolUse('Write', { file_path: path.join(cwd, 'src', 'proxy.ts') }, cwd)).toBe(
      'write: src/proxy.ts',
    )
    expect(describeToolUse('Skill', { skill: 'clock-in', args: 'F-046' }, cwd)).toBe(
      'skill: /clock-in F-046',
    )
    expect(describeToolUse('Grep', { pattern: 'requireUser', path: 'src' }, cwd)).toBe(
      'grep: requireUser in src',
    )
  })

  it('keeps paths outside the worktree absolute', () => {
    const outside = path.resolve('/home/user/bin/pnpm')
    expect(shortPath(outside, cwd)).toBe(outside.split(path.sep).join('/'))
  })
})

describe('milestones', () => {
  it('recognises harness steps in Bash commands', () => {
    expect(milestoneOf('pnpm harness:feature activate F-046')).toBe('feature activate F-046')
    expect(milestoneOf('CI=1 pnpm harness:verify F-046')).toBe('harness:verify')
    expect(milestoneOf('pnpm harness:verify F-046 --dry-run')).toBeUndefined()
    expect(milestoneOf('pnpm harness:clean-state --allow-state-dirty')).toBe('clean-state check')
    expect(milestoneOf('git add -A && git commit -q -m "feat: x"')).toBe('git commit')
    expect(milestoneOf('pnpm check 2>&1 | tail -20')).toBe('L1 pnpm check')
    expect(milestoneOf('pnpm test:e2e tests/e2e/auth.spec.ts')).toBe('L3 test:e2e')
    expect(milestoneOf('git log --oneline -5')).toBeUndefined()
    expect(milestoneOf('grep -n "pnpm test:e2e" PROGRESS.md')).toBeUndefined()
    expect(milestoneOf('cd x && CI=1 pnpm test:e2e --retries=0')).toBe('L3 test:e2e')
  })

  it('judges the outcome from the output, not only the exit code', () => {
    expect(milestoneStatus('Tests  2 failed | 223 passed (225)', false)).toBe('warning')
    expect(milestoneStatus('Exit code 1', true)).toBe('failed')
    expect(milestoneStatus('Command running in background with ID: b1', false)).toBe('background')
    expect(milestoneStatus('Tests  225 passed (225)', false)).toBe('ok')
    expect(
      summarizeOutput(
        'clean-state check',
        '\x1b[32m[ok]\x1b[0m x\n{"level":50}\nclean-state: all checks passed',
      ),
    ).toBe('clean-state: all checks passed')
  })

  it('summarises test totals and commit subjects', () => {
    expect(
      summarizeOutput('L1 test:unit', ' Test Files  3 passed (3)\n      Tests  23 passed (23)\n'),
    ).toBe('Test Files 3 passed (3) · Tests 23 passed (23)')
    expect(
      summarizeOutput(
        'git commit',
        '[feat/F-046 da0d530] fix(harness): run pnpm through node\n 4 files changed',
      ),
    ).toBe('[feat/F-046 da0d530] fix(harness): run pnpm through node')
  })
})

describe('describeEvent', () => {
  it('reports a milestone when it starts and when its result arrives', () => {
    const state = newStreamState(cwd, 0)
    expect(describeEvent(toolUse('t1', 'Bash', { command: 'pnpm check' }), state, 1000)).toEqual([
      'bash: pnpm check',
      '▶ L1 pnpm check started',
    ])
    expect(describeEvent(toolResult('t1', 'Tests  225 passed (225)'), state, 2000)).toEqual([
      '✓ L1 pnpm check done: Tests 225 passed (225)',
    ])
    expect(describeEvent(toolUse('t2', 'Bash', { command: 'pnpm check' }), state)).toHaveLength(2)
    expect(describeEvent(toolResult('t2', 'Exit code 1\n 2 failed', true), state)[0]).toMatch(
      /^✗ L1 pnpm check failed: .*2 failed/,
    )
  })

  it('surfaces failed tool calls, hook blocks and skill errors', () => {
    const state = newStreamState(cwd)
    describeEvent(toolUse('t3', 'Skill', { skill: 'clock-out' }), state)
    expect(
      describeEvent(
        toolResult('t3', '<tool_use_error>Skill clock-out cannot be used with Skill tool', true),
        state,
      ),
    ).toEqual(['✗ Skill error: <tool_use_error>Skill clock-out cannot be used with Skill tool'])
    expect(
      describeEvent(
        {
          type: 'system',
          subtype: 'hook_response',
          hook_name: 'PreToolUse:Bash',
          exit_code: 2,
          stderr: 'guard: force push is not allowed\n',
        },
        state,
      ),
    ).toEqual(['⛔ PreToolUse:Bash blocked: guard: force push is not allowed'])
    const deny = JSON.stringify({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'guard: secrets',
      },
    })
    expect(
      describeEvent(
        {
          type: 'system',
          subtype: 'hook_response',
          hook_name: 'PreToolUse:Write',
          exit_code: 0,
          stdout: deny,
        },
        state,
      ),
    ).toEqual(['⛔ PreToolUse:Write deny: guard: secrets'])
    expect(
      describeEvent(
        {
          type: 'system',
          subtype: 'hook_response',
          hook_name: 'SessionStart',
          exit_code: 0,
          stdout: '## state',
        },
        state,
      ),
    ).toEqual([])
  })

  it('counts turns and tokens for the heartbeat', () => {
    const state = newStreamState(cwd, 0)
    describeEvent(
      toolUse('t4', 'Bash', { command: 'CI=1 pnpm harness:verify F-046' }),
      state,
      60_000,
    )
    describeEvent(toolUse('t5', 'Read', { file_path: 'PROGRESS.md' }), state, 120_000)
    expect(heartbeat(state, 600_000)).toBe(
      '… 10 min · 2 turns · 3k output tokens · last event 480 s ago · running: harness:verify, Read',
    )
  })
})

describe('project configuration', () => {
  it('reports the test layers a project configures as milestones', () => {
    const state = newStreamState(cwd, 0, [
      { pattern: 'uv run pytest\\b', label: 'L1 pytest' },
      { pattern: 'pnpm test:py\\b', label: 'L1 test:py' },
    ])
    expect(milestoneOf('uv run pytest tests/test_x.py -q', state.layers)).toBe('L1 pytest')
    expect(milestoneOf('pnpm test:py', state.layers)).toBe('L1 test:py')
    expect(milestoneOf('pnpm check', state.layers)).toBeUndefined()
    expect(milestoneOf('echo "uv run pytest"', state.layers)).toBeUndefined()
  })

  it('records the plugins the session loaded from its init event', () => {
    const state = newStreamState(cwd)
    expect(
      describeEvent(
        {
          type: 'system',
          subtype: 'init',
          model: 'claude-opus-5-5',
          permissionMode: 'auto',
          plugins: [{ name: 'harness', path: '/p' }, 'other'],
        },
        state,
      ),
    ).toEqual([
      'session started · model claude-opus-5-5 · permission mode auto · plugins harness, other',
    ])
    expect(state.plugins).toEqual(['harness', 'other'])
  })
})
