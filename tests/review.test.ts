import { describe, expect, it } from 'vitest'

import { hardStops, parseSafetyVerdict } from '../src/review'

const config = (extra: Record<string, unknown> = {}) => ({
  generator: { model: 'm' },
  evaluator: { model: 'm' },
  allowedTools: ['Bash(pnpm check*)'],
  ...extra,
})

const settings = (permissions: Record<string, unknown> = {}, plugin = true) => ({
  enabledPlugins: { 'harness@eemelinen-harness': plugin },
  permissions: { allow: ['Bash(pnpm test*)'], deny: ['Bash(git push*)'], ...permissions },
})

describe('hardStops', () => {
  it('lets ordinary config and settings changes through to the safety review', () => {
    expect(
      hardStops(
        { config: config(), settings: settings() },
        {
          config: config({ allowedTools: ['Bash(pnpm check*)', 'Bash(pnpm test:py*)'] }),
          settings: settings({ allow: ['Bash(pnpm test*)', 'Bash(uv run pytest*)'] }),
        },
      ),
    ).toEqual([])
    expect(hardStops({}, {})).toEqual([])
  })

  it('stops changes to the review itself and to the permission mode', () => {
    expect(
      hardStops(
        { config: config() },
        {
          config: config({
            reviewPaths: ['harness.config.json'],
            review: { mode: 'human' },
            generator: { model: 'm', permissionMode: 'bypassPermissions' },
          }),
        },
      ),
    ).toEqual([
      'removes reviewPaths: .claude/*, .github/workflows/*',
      'changes the review settings',
      'changes generator.permissionMode to bypassPermissions',
    ])
  })

  it('stops unscoped allows, removed deny rules and a disabled plugin', () => {
    expect(
      hardStops(
        { config: config(), settings: settings() },
        {
          config: config({ allowedTools: ['Bash(pnpm check*)', 'Bash(*)'] }),
          settings: settings(
            { allow: ['Bash'], deny: [], defaultMode: 'bypassPermissions' },
            false,
          ),
        },
      ),
    ).toEqual([
      'allowedTools allows every command: Bash(*)',
      '.claude/settings.json disables the harness@eemelinen-harness plugin',
      '.claude/settings.json removes deny rules: Bash(git push*)',
      '.claude/settings.json allows every command: Bash',
      '.claude/settings.json sets permissions.defaultMode to bypassPermissions',
    ])
  })

  it('stops a config that no longer parses and a deleted settings file', () => {
    expect(hardStops({ config: config(), settings: settings() }, { config: null })).toEqual([
      'harness.config.json is missing or invalid after the change',
      'deletes .claude/settings.json',
    ])
  })
})

describe('parseSafetyVerdict', () => {
  it('accepts only a complete structured verdict', () => {
    expect(
      parseSafetyVerdict({
        structured_output: { verdict: 'safe', reasons: ['adds a test runner'] },
      }),
    ).toEqual({ verdict: 'safe', reasons: ['adds a test runner'] })
    expect(
      parseSafetyVerdict({ structured_output: { verdict: 'safe', reasons: [] } }),
    ).toBeUndefined()
    expect(parseSafetyVerdict({ result: 'Verdict: safe' })).toBeUndefined()
    expect(parseSafetyVerdict(undefined)).toBeUndefined()
  })
})
