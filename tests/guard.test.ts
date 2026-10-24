import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { evaluate, globToRegExp, relativePath } from '../plugin/hooks/guard-rules.mjs'

const root = path.resolve('/work/project')

/** The guard rules metsavahti and idea-generator configure (abridged). */
const config = {
  guard: {
    bash: [
      {
        pattern:
          '(^|[;&|\\s])(npx |pnpm (exec|dlx) |\\./node_modules/\\.bin/)?(vitest|playwright)(\\s|$)',
        unless: 'dotenv -e \\.env\\.test|playwright install|pnpm test',
        reason: 'run tests through pnpm test:*',
      },
      {
        pattern: '(python3?|py|pytest|pip3?)(\\s|$)',
        atCommandStart: true,
        reason: 'run Python through uv',
      },
      {
        pattern: '(^|[;&|\\s])pnpm (run )?db:(up|down)',
        loopOnly: true,
        reason: 'services are managed by the loop driver',
      },
    ],
    paths: [
      { match: 'src/payload-types.ts', decision: 'deny', reason: 'generated' },
      { match: 'src/payload/migrations/index.ts', decision: 'skip' },
      { match: 'src/payload/migrations/*', decision: 'ask', reason: 'migrations are generated' },
      { match: 'AGENTS.md', tools: ['Write'], decision: 'ask', reason: 'keep the marker block' },
      {
        match: 'AGENTS.md',
        contentPattern: 'nextjs-agent-rules',
        decision: 'ask',
        reason: 'marker block',
      },
    ],
    rmAllow: ['/tmp/', 'node_modules', '.next'],
  },
}

const bash = (command: string, opts: { loop?: boolean; check?: number } = {}) =>
  evaluate(
    { tool_name: 'Bash', tool_input: { command } },
    {
      root,
      config,
      loop: opts.loop ?? false,
      checkFeatureList: () => ({ code: opts.check ?? 0, out: 'invalid: F-001' }),
    },
  )

const edit = (tool: string, file: string, input: Record<string, unknown> = {}, loop = false) =>
  evaluate(
    { tool_name: tool, tool_input: { file_path: file, ...input } },
    { root, config, loop, checkFeatureList: () => ({ code: 0, out: '' }) },
  )

describe('guard: Bash', () => {
  it('applies the core rules in every project', () => {
    expect(bash('npm install left-pad')).toEqual({
      block: 'use pnpm (packageManager pin); npm/yarn/npx are not allowed',
    })
    expect(bash('git push --force origin main')).toEqual({ block: 'force push is not allowed' })
    expect(bash('git reset --hard HEAD~1')?.block).toMatch(/destructive git/)
    expect(bash('rm -rf src')?.block).toMatch(/rm -rf/)
    expect(bash('rm -rf .next node_modules')).toBeNull()
    expect(bash('git status --short')).toBeNull()
  })

  it('applies project rules, honouring unless', () => {
    expect(bash('vitest run tests/unit')?.block).toMatch(/pnpm test/)
    expect(bash('pnpm exec playwright test')?.block).toMatch(/pnpm test/)
    expect(bash('pnpm exec playwright install chromium')).toBeNull()
    expect(bash('dotenv -e .env.test -- vitest run')).toBeNull()
  })

  it('matches atCommandStart rules only where a command starts', () => {
    expect(bash('pytest -q')?.block).toMatch(/uv/)
    expect(bash('cd x && python -m pkg')?.block).toMatch(/uv/)
    expect(bash('uv run pytest -q')).toBeNull()
    expect(bash('git commit -m "fix\n\npytest is flaky on CI"')).toBeNull()
  })

  it('adds the driver-only rules in a loop session', () => {
    expect(bash('pnpm db:up')).toBeNull()
    expect(bash('pnpm db:up', { loop: true })?.block).toMatch(/loop driver/)
    expect(bash('git push -u origin feat/F-001', { loop: true })?.block).toMatch(/pushes/)
    expect(bash('git checkout main', { loop: true })?.block).toMatch(/feature branch/)
    expect(bash('mkdir -p ~/bin', { loop: true })?.block).toMatch(/home directory/)
    expect(bash('echo x >> /c/Users/me/.bashrc', { loop: true })?.block).toMatch(/home directory/)
    expect(bash('git push origin feat/F-001')).toBeNull()
  })

  it('skips heredoc bodies that are data', () => {
    // Personal Finances F-002: a Python edit whose string mentioned `pnpm db:up` was blocked.
    const edit = "uv run python - <<'EOF'\ns = s.replace('pnpm db:up is unavailable', 'x')\nEOF"
    expect(bash(edit, { loop: true })).toBeNull()
    expect(
      bash('git commit -F - <<EOF\nfix: stop the npm install\n\nno git push here\nEOF', {
        loop: true,
      }),
    ).toBeNull()
    expect(bash('cat > notes.md <<-"END"\n\tvitest run\n\tEND\npnpm check')).toBeNull()
    // The command after the heredoc is still checked.
    expect(
      bash("uv run python - <<'EOF'\nprint(1)\nEOF\npnpm db:up", { loop: true })?.block,
    ).toMatch(/loop driver/)
  })

  it('checks heredoc bodies fed to a shell, and << inside quotes', () => {
    expect(bash('bash <<EOF\npnpm db:up\nEOF', { loop: true })?.block).toMatch(/loop driver/)
    expect(bash("ssh host sh -s <<'EOF'\nrm -rf src\nEOF")?.block).toMatch(/rm -rf/)
    expect(bash('echo "a <<EOF b"\npnpm db:up\nEOF', { loop: true })?.block).toMatch(/loop driver/)
    expect(bash('cat <<<EOF\nnpm install x')?.block).toMatch(/use pnpm/)
  })

  it('gates git commit on a valid feature list', () => {
    expect(bash('git add -A && git commit -m "feat: x"')).toBeNull()
    expect(bash('git commit -m "feat: x"', { check: 1 })).toEqual({
      block: 'feature_list.json is invalid; fix it before committing: invalid: F-001',
    })
  })
})

describe('guard: Edit/Write', () => {
  it('denies and asks per the first matching path rule', () => {
    expect(edit('Edit', path.join(root, 'src', 'payload-types.ts'))).toEqual({
      decision: 'deny',
      reason: 'generated',
    })
    expect(edit('Write', path.join(root, 'src/payload/migrations/20260101_x.ts'))).toEqual({
      decision: 'ask',
      reason: 'migrations are generated',
    })
    expect(edit('Edit', path.join(root, 'src/payload/migrations/index.ts'))).toBeNull()
    expect(edit('Edit', path.join(root, 'pnpm-lock.yaml'))?.decision).toBe('deny')
    expect(edit('Edit', path.join(root, 'src', 'app.ts'))).toBeNull()
  })

  it('limits rules by tool and by edited content', () => {
    expect(edit('Write', path.join(root, 'AGENTS.md'))?.reason).toBe('keep the marker block')
    expect(
      edit('Edit', path.join(root, 'AGENTS.md'), { old_string: 'a', new_string: 'b' }),
    ).toBeNull()
    expect(
      edit('Edit', path.join(root, 'AGENTS.md'), {
        old_string: '<!-- BEGIN:nextjs-agent-rules -->',
        new_string: '',
      })?.reason,
    ).toBe('marker block')
    expect(
      edit('MultiEdit', path.join(root, 'AGENTS.md'), {
        edits: [{ old_string: 'nextjs-agent-rules', new_string: 'x' }],
      })?.reason,
    ).toBe('marker block')
  })

  it('lets an exceptNewOnBranch rule pass files missing at the merge base', () => {
    const rules = {
      guard: {
        paths: [
          {
            match: 'src/migrations/*',
            decision: 'ask',
            reason: 'migrations are generated',
            exceptNewOnBranch: true,
          },
          { match: 'src/*', decision: 'deny', reason: 'later rule' },
          { match: 'docs/*', decision: 'ask', reason: 'docs' },
        ],
      },
    }
    const calls: string[] = []
    const onBase: Record<string, boolean | null> = {
      'src/migrations/new.ts': false,
      'src/migrations/old.ts': true,
      'src/migrations/unknown.ts': null,
      'docs/new.md': false,
    }
    const decide = (file: string, existsOnBase?: (rel: string) => boolean | null) =>
      evaluate(
        { tool_name: 'Edit', tool_input: { file_path: path.join(root, file) } },
        {
          root,
          config: rules,
          loop: true,
          checkFeatureList: () => ({ code: 0, out: '' }),
          existsOnBase,
        },
      )
    const known = (rel: string) => {
      calls.push(rel)
      return onBase[rel] ?? null
    }
    // A new file skips the rule; evaluation moves on to the next one.
    expect(decide('src/migrations/new.ts', known)).toEqual({
      decision: 'deny',
      reason: 'later rule',
    })
    expect(decide('src/migrations/old.ts', known)?.reason).toBe('migrations are generated')
    expect(decide('src/migrations/unknown.ts', known)?.reason).toBe('migrations are generated')
    expect(decide('src/migrations/new.ts')?.reason).toBe('migrations are generated')
    // Rules without the key never ask git.
    expect(decide('docs/new.md', known)?.reason).toBe('docs')
    expect(calls).toEqual([
      'src/migrations/new.ts',
      'src/migrations/old.ts',
      'src/migrations/unknown.ts',
    ])
  })

  it('confines driver-run sessions to the worktree and the temp directory', () => {
    expect(edit('Write', path.resolve('/elsewhere/file.ts'), {}, true)?.decision).toBe('deny')
    expect(edit('Write', path.join(tmpdir(), 'scratch.txt'), {}, true)).toBeNull()
    expect(edit('Write', path.resolve('/elsewhere/file.ts'))).toBeNull()
  })

  it('leaves the evaluator to the driver in a loop session', () => {
    const agent = (tool: string, subagent_type: string, loop: boolean) =>
      evaluate(
        { tool_name: tool, tool_input: { subagent_type, prompt: 'Score the diff' } },
        { root, config, loop, checkFeatureList: () => ({ code: 0, out: '' }) },
      )
    expect(agent('Agent', 'harness:evaluator', true)?.decision).toBe('deny')
    expect(agent('Task', 'evaluator', true)?.reason).toMatch(/driver runs the evaluator/)
    expect(agent('Agent', 'harness:evaluator', false)).toBeNull()
    expect(agent('Agent', 'Explore', true)).toBeNull()
  })

  it('routes subagent launches through the guard', () => {
    const hooks = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '../plugin/hooks/hooks.json'), 'utf8'),
    ) as { hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] } }
    const guarded = hooks.hooks.PreToolUse.filter((h) =>
      h.hooks.some((c) => c.command.includes('guard.mjs')),
    ).flatMap((h) => h.matcher.split('|'))
    expect(guarded).toEqual(expect.arrayContaining(['Agent', 'Task']))
  })

  it('normalises Windows paths and shell-case globs', () => {
    expect(relativePath(path.join(root, 'src', 'a.ts'), root)).toBe('src/a.ts')
    expect(relativePath(path.resolve('/other/a.ts'), root)).toBeNull()
    expect(
      globToRegExp('src/app/(payload)/admin/*').test('src/app/(payload)/admin/x/page.tsx'),
    ).toBe(true)
    expect(globToRegExp('.env.*.local').test('.env.dev.local')).toBe(true)
    expect(globToRegExp('.env.*.local').test('.env.example')).toBe(false)
  })
})

describe('guard.mjs as a hook process', () => {
  const hook = path.resolve(import.meta.dirname, '../plugin/hooks/guard.mjs')
  const runHook = (dir: string, input: unknown) =>
    spawnSync(process.execPath, [hook], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HARNESS_LOOP: '' },
    })

  it('is inert in a project without harness.config.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-noconfig-'))
    const res = runHook(dir, { tool_name: 'Bash', tool_input: { command: 'npm install' } })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('')
  })

  it('blocks with exit 2 and answers path rules with a permission decision', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-guard-'))
    writeFileSync(path.join(dir, 'harness.config.json'), JSON.stringify(config))
    const blocked = runHook(dir, { tool_name: 'Bash', tool_input: { command: 'npx vitest' } })
    expect(blocked.status).toBe(2)
    expect(blocked.stderr).toMatch(/^guard: /)
    const denied = runHook(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'src', 'payload-types.ts') },
    })
    expect(denied.status).toBe(0)
    expect(JSON.parse(denied.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'guard: generated',
      },
    })
  })

  describe('exceptNewOnBranch against git', () => {
    const git = (dir: string, ...args: string[]) => {
      const res = spawnSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: dir, encoding: 'utf8' },
      )
      if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
      return res.stdout.trim()
    }
    const write = (dir: string, file: string, content = 'x\n') => {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      writeFileSync(path.join(dir, file), content)
    }
    const migrations = {
      project: { defaultBranch: 'trunk' },
      guard: {
        paths: [
          {
            match: 'src/migrations/*',
            decision: 'ask',
            reason: 'migrations are generated',
            exceptNewOnBranch: true,
          },
        ],
      },
    }
    const decision = (dir: string, file: string) => {
      const res = runHook(dir, {
        tool_name: 'Edit',
        tool_input: { file_path: path.join(dir, file), old_string: 'x', new_string: 'y' },
      })
      expect(res.status).toBe(0)
      return res.stdout === '' ? null : JSON.parse(res.stdout).hookSpecificOutput.permissionDecision
    }

    /** `trunk` has old.ts; the feature branch commits added.ts and leaves untracked.ts untracked. */
    function repo() {
      const dir = mkdtempSync(path.join(tmpdir(), 'harness-guard-git-'))
      git(dir, 'init', '-q', '-b', 'trunk')
      write(dir, 'harness.config.json', JSON.stringify(migrations))
      write(dir, 'src/migrations/old.ts')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'init')
      git(dir, 'checkout', '-q', '-b', 'feat/F-001')
      write(dir, 'src/migrations/added.ts')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-q', '-m', 'feat: migration')
      write(dir, 'src/migrations/untracked.ts')
      return dir
    }

    it('passes files the branch added and guards files on the default branch', () => {
      const dir = repo()
      expect(decision(dir, 'src/migrations/added.ts')).toBeNull()
      expect(decision(dir, 'src/migrations/untracked.ts')).toBeNull()
      expect(decision(dir, 'src/migrations/brand-new.ts')).toBeNull()
      expect(decision(dir, 'src/migrations/old.ts')).toBe('ask')
    })

    it('prefers the remote default branch for the merge base', () => {
      const dir = repo()
      // origin/trunk is ahead of the local trunk and already has added.ts.
      git(dir, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD')
      expect(decision(dir, 'src/migrations/added.ts')).toBe('ask')
      expect(decision(dir, 'src/migrations/untracked.ts')).toBeNull()
    })

    it('fires when git cannot answer', () => {
      const noRepo = mkdtempSync(path.join(tmpdir(), 'harness-guard-nogit-'))
      write(noRepo, 'harness.config.json', JSON.stringify(migrations))
      expect(decision(noRepo, 'src/migrations/new.ts')).toBe('ask')
      const noBase = repo()
      write(noBase, 'harness.config.json', JSON.stringify({ ...migrations, project: {} }))
      expect(decision(noBase, 'src/migrations/added.ts')).toBe('ask')
    })
  })

  it('fails the commit gate closed when the harness package is not installed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-nopkg-'))
    writeFileSync(path.join(dir, 'harness.config.json'), '{}')
    const res = runHook(dir, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } })
    expect(res.status).toBe(2)
    expect(res.stderr).toMatch(/not installed in this project; run pnpm install/)
  })
})
