// SessionStart hook: print a compact, read-only state summary into Claude's context.
// Must stay fast (< 1 s plus the configured status commands). It never fails the session.
// Inert in a project without harness.config.json.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { loadConfig, projectDir, readInput, today } from './lib.mjs'

const input = await readInput()
const root = projectDir(input)
const config = loadConfig(root)

function git(args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return res.status === 0 ? res.stdout.trimEnd() : ''
}

function shellOk(command) {
  const res = spawnSync(command, { cwd: root, shell: true, stdio: 'ignore', timeout: 5000 })
  return res.status === 0
}

if (config) {
  const project = config.project ?? {}
  const progress = project.progress ?? 'PROGRESS.md'
  const featureList = project.featureList ?? 'feature_list.json'
  const sourceDirs = project.sourceDirs ?? ['src']
  const out = []

  out.push(`## ${project.name ?? path.basename(root)} session state (${today()})`)
  out.push(`repo: ${root} · branch: ${git(['rev-parse', '--abbrev-ref', 'HEAD']) || '?'}`)
  out.push('', 'recent commits:')
  for (const line of git(['log', '--oneline', '-5']).split('\n').filter(Boolean))
    out.push(`  ${line}`)

  const dirty = git(['status', '--short']).split('\n').filter(Boolean)
  if (dirty.length > 0) {
    out.push('', 'uncommitted changes:')
    for (const line of dirty.slice(0, 15)) out.push(`  ${line}`)
    const paths = dirty.map((l) => l.slice(3))
    const sourceDirty = paths.some((p) => sourceDirs.some((d) => p.startsWith(`${d}/`)))
    const stateDirty = paths.some((p) => p === progress || p === featureList)
    if (sourceDirty && !stateDirty) {
      out.push(
        '',
        `WARNING: source files (${sourceDirs.join(', ')}) have uncommitted changes but ${progress} / ${featureList} are untouched.`,
        'A previous session may have stopped without clock-out. Read the diff before continuing.',
      )
    }
  }

  const progressFile = path.join(root, progress)
  if (existsSync(progressFile)) {
    const lines = readFileSync(progressFile, 'utf8').split('\n')
    const start = lines.findIndex((l) => l.startsWith('## Current Verified State'))
    if (start !== -1) {
      const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
      out.push('', ...lines.slice(start, end === -1 ? undefined : end).map((l) => l.trimEnd()))
    }
  }

  const listFile = path.join(root, featureList)
  if (existsSync(listFile)) {
    try {
      const list = JSON.parse(readFileSync(listFile, 'utf8'))
      const by = (s) => list.features.filter((f) => f.status === s)
      const active = by('in_progress')[0]
      const next = by('not_started').sort((a, b) => a.priority - b.priority)[0]
      out.push('')
      out.push(
        active
          ? `active feature: ${active.id} — ${active.title}`
          : 'active feature: none (WIP=1 slot is free)',
      )
      if (next) out.push(`next not_started: ${next.id} — ${next.title}`)
      out.push(
        `features: ${list.features.length} total · ${by('passing').length} passing · ${by('in_progress').length} in_progress · ${by('blocked').length} blocked`,
      )
    } catch (error) {
      out.push(`${featureList}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const status = config.sessionStart?.lines ?? []
  if (status.length > 0) out.push('')
  for (const line of status) {
    if (line.file) out.push(existsSync(path.join(root, line.file)) ? line.present : line.missing)
    else if (line.command) out.push(shellOk(line.command) ? line.ok : line.fail)
    else if (line.env) {
      const text = process.env[line.env] ? line.set : line.unset
      if (text) out.push(text)
    }
  }

  out.push(
    '',
    config.sessionStart?.hint ??
      'Clock-in: AGENTS.md → Clock-in (or /harness:clock-in). Layers: AGENTS.md → Verification layers.',
  )
  console.log(out.filter((l) => l !== undefined).join('\n'))
}
