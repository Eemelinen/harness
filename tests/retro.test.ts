import { describe, expect, it } from 'vitest'

import { configSchema } from '../src/config'
import {
  collectDriverLog,
  collectEvaluator,
  collectRuns,
  collectStreamTrace,
  fingerprintOf,
  hookBlockReason,
  issueBody,
  nextFeatureId,
  normalizeSummary,
  parseIssueFeature,
  repoSlug,
  reviewReasons,
  signalList,
  type Finding,
  type Signals,
} from '../src/retro'

const line = (msg: unknown) => JSON.stringify(msg)

const toolUse = (id: string, name: string, input: unknown, parent?: string) =>
  line({
    type: 'assistant',
    parent_tool_use_id: parent ?? null,
    message: { content: [{ type: 'tool_use', id, name, input }] },
  })

const toolError = (id: string, text: string, parent?: string) =>
  line({
    type: 'user',
    parent_tool_use_id: parent ?? null,
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] },
  })

const caps = configSchema.shape.caps.parse({})

describe('retro signals', () => {
  it('groups summaries that differ only in quoted text, numbers or paths', () => {
    expect(normalizeSummary("command denied: 'tail -5' is not on the allow-list")).toBe(
      normalizeSummary("command denied: 'head -30' is not on the allow-list"),
    )
    expect(normalizeSummary('3 failed in /work/a/b.ts')).toBe(normalizeSummary('12 failed in /x/y'))
  })

  it('reads the reason of a blocking hook', () => {
    expect(
      hookBlockReason(
        'PreToolUse:Bash hook error: [node "/p/guard.mjs"]: guard: Docker services are managed by the loop driver\n\nThis hook comes from the harness@inline plugin.',
      ),
    ).toBe('guard: Docker services are managed by the loop driver')
    expect(
      hookBlockReason(
        `PreToolUse:Bash hook error: [uv run python -m ideaforge.guard bash]: command denied: 'tail -5' is not on the allow-list`,
      ),
    ).toBe(`command denied: 'tail -5' is not on the allow-list`)
    expect(hookBlockReason('Exit code 1\nnot found')).toBeUndefined()
  })

  it('collects guard blocks and denials from a session trace, naming the subagent', () => {
    const trace = [
      toolUse('t1', 'Bash', { command: 'pnpm db:up' }),
      toolError(
        't1',
        'PreToolUse:Bash hook error: [node guard.mjs]: guard: services are managed by the loop driver',
      ),
      toolUse('a1', 'Agent', { subagent_type: 'harness:evaluator', prompt: 'review' }),
      toolUse('t2', 'Bash', { command: 'pnpm test:py' }, 'a1'),
      toolError(
        't2',
        "PreToolUse:Bash hook error: [guard]: command denied: 'pnpm test:py' is not on the allow-list",
        'a1',
      ),
      toolUse('t3', 'Bash', { command: 'git reset --hard' }),
      toolError(
        't3',
        'Permission for this action was denied by the Claude Code auto mode classifier.',
      ),
      toolUse('t4', 'Bash', { command: 'grep x y' }),
      toolError('t4', 'Exit code 1'),
      line({
        type: 'result',
        permission_denials: [
          { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'pnpm db:up' } },
          { tool_name: 'Write', tool_use_id: 't9', tool_input: { file_path: '/etc/x' } },
        ],
      }),
    ].join('\n')
    const signals: Signals = new Map()
    collectStreamTrace(trace, '.harness/traces/F-002-2026.generator.jsonl', signals)
    const list = signalList(signals)
    expect(list.map((s) => [s.kind, s.count])).toEqual([
      ['guard-block', 1],
      ['guard-block', 1],
      ['permission-denial', 1],
      ['permission-denial', 1],
    ])
    const evaluator = list.find((s) => s.summary.includes('test:py'))
    expect(evaluator?.examples[0]).toMatchObject({
      feature: 'F-002',
      agent: 'harness:evaluator',
      command: 'pnpm test:py',
    })
    // The result's denial of t1 is the guard block already counted; t9 is new.
    expect(list.find((s) => s.summary === 'Write call denied')?.examples[0]?.command).toBe('/etc/x')
  })

  it('collects non-Accept evaluator verdicts', () => {
    const signals: Signals = new Map()
    const result = (verdict: string) =>
      JSON.stringify({
        structured_output: { verdict, findings: [], required_follow_up: ['run init.sh twice'] },
        permission_denials: [],
      })
    collectEvaluator(result('Accept'), 'F-001-x.evaluator.json', signals)
    collectEvaluator(result('Revise'), 'F-002-x.evaluator.json', signals)
    collectEvaluator('{"partial', 'F-003-x.evaluator.json', signals)
    expect(signalList(signals)).toMatchObject([
      {
        kind: 'evaluator-revise',
        summary: 'evaluator Revise: run init.sh twice',
        features: ['F-002'],
      },
    ])
  })

  it('keeps the driver lines that report its own problems', () => {
    const log = [
      '[harness 20:40:10] ✗ L2 test:integration failed: This hook comes from the harness@inline plugin.',
      '[harness 20:41:00] ⚠ L1 test:unit reported failures: Tests 1 failed | 9 passed (10)',
      '[harness 20:42:00] ✗ Bash error: PreToolUse:Bash hook error: [guard]: denied',
      '[harness 20:43:00] claude: the build failed, fixing it',
      '[harness 20:44:00] gh pr create failed: HTTP 422',
      '[harness 20:45:00] PR opened: https://github.com/o/r/pull/1',
    ].join('\n')
    const signals: Signals = new Map()
    collectDriverLog(log, 'F-002-x.log', signals)
    expect(signalList(signals).map((s) => s.summary)).toEqual([
      '✗ L2 test:integration failed: This hook comes from the harness@inline plugin.',
      'gh pr create failed: HTTP 422',
    ])
  })

  it('collects failed attempts and sessions near a cap from the run log', () => {
    const signals: Signals = new Map()
    const row = {
      ts: '2026-10-23T20:00:00Z',
      feature: 'F-046',
      trace: '/r/t.jsonl',
      costUsd: 1,
      turns: 20,
      minutes: 10,
    }
    collectRuns(
      [
        { ...row, outcome: 'failed', note: '' },
        { ...row, outcome: 'pr', minutes: 55 },
        { ...row, outcome: 'merged' },
      ],
      caps,
      '/r',
      signals,
    )
    expect(signalList(signals).map((s) => [s.kind, s.summary])).toEqual([
      ['attempt-failed', 'attempt failed'],
      ['near-cap', 'a session used over 80% of a cap (turns, budget or wall clock)'],
    ])
  })
})

describe('retro issues and intake', () => {
  const finding: Finding = {
    fingerprint: 'guard-matches-heredoc-data',
    target: 'harness',
    title: 'Skip heredoc data in guard Bash rules',
    problem: 'The guard matched a string in a Python heredoc.',
    evidence: ['F-002: python3 - <<EOF … blocked'],
    fix: 'Drop heredoc bodies before matching unless a shell reads them.',
    verification: ['L1: pnpm check', 'manual: look at it', 'not a step'],
    safety: true,
    confidence: 'high',
  }

  it('writes an issue the intake can read back', () => {
    const body = issueBody(finding, {
      project: 'Personal Finances',
      version: '0.2.0',
      date: '2026-10-23',
    })
    expect(fingerprintOf(body)).toBe('guard-matches-heredoc-data')
    expect(parseIssueFeature(body)).toEqual({
      title: 'Skip heredoc data in guard Bash rules',
      user_visible_behavior: 'Drop heredoc bodies before matching unless a shell reads them.',
      verification: ['L1: pnpm check'],
      safety: true,
    })
  })

  it('falls back to L1 and rejects a block without a title', () => {
    const block = (json: string) => `text\n\n\`\`\`json harness-feature\n${json}\n\`\`\`\n`
    expect(
      parseIssueFeature(block('{"title":"x","user_visible_behavior":"y"}'))?.verification,
    ).toEqual(['L1: pnpm check'])
    expect(parseIssueFeature(block('{"user_visible_behavior":"y"}'))).toBeUndefined()
    expect(parseIssueFeature(block('{not json'))).toBeUndefined()
    expect(parseIssueFeature('no block here')).toBeUndefined()
  })

  it('allocates the next free feature id', () => {
    expect(nextFeatureId(['F-001', 'F-012', 'F-007', 'chore'])).toBe('F-013')
    expect(nextFeatureId([])).toBe('F-001')
  })

  it('reads owner/name from GitHub remotes', () => {
    expect(repoSlug('https://github.com/Eemelinen/harness.git')).toBe('Eemelinen/harness')
    expect(repoSlug('git+https://github.com/Eemelinen/harness.git')).toBe('Eemelinen/harness')
    expect(repoSlug('git@github.com:Eemelinen/idea-generator.git')).toBe('Eemelinen/idea-generator')
    expect(repoSlug('https://gitlab.com/a/b')).toBeUndefined()
  })

  it('holds PRs that change review paths or come from a safety issue', () => {
    const paths = ['.claude/settings.json', 'harness.config.json', 'plugin/hooks/guard*']
    expect(reviewReasons(['src/a.ts', 'README.md'], paths)).toEqual([])
    expect(reviewReasons(['harness.config.json', 'plugin/hooks/guard-rules.mjs'], paths)).toEqual([
      'changes harness.config.json (reviewPaths)',
      'changes plugin/hooks/guard-rules.mjs (reviewPaths)',
    ])
    expect(reviewReasons(['src/a.ts'], paths, true)).toEqual([
      'the retro issue is marked as a safety change',
    ])
  })
})
