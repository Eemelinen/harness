/**
 * Feature state transitions for `feature_list.json` (AGENTS.md → Working rules).
 * Every command re-validates the file and rewrites it through Prettier, so a human,
 * a skill (`/harness:clock-in`) and the loop driver all change state the same way.
 *
 *   harness feature next [--json] [--include-manual] [--exclude F-001,F-002]
 *   harness feature show <id> [--json]
 *   harness feature list [--status not_started]
 *   harness feature activate <id>            not_started → in_progress (WIP=1, deps passing)
 *   harness feature block <id> --reason "…"  any → blocked
 *   harness feature unblock <id>             blocked → not_started
 *   harness feature attempt <id> [--reason "…"]
 *        attempts += 1; auto-blocks at max_attempts (feature field or caps.maxAttempts)
 */
import path from 'node:path'
import { parseArgs } from 'node:util'

import { loadProject, type Project } from './config'
import {
  featureStatuses,
  isHumanOnly,
  isReady,
  nextReadyFeature,
  readFeatureList,
  today,
  writeFeatureList,
  type Feature,
  type FeatureList,
  type FeatureStatus,
} from './feature-list'

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message)
}

function requireFeature(list: FeatureList, id: string | undefined): Feature {
  if (!id) fail('feature id is required (e.g. F-042)')
  const feature = list.features.find((f) => f.id === id)
  if (!feature) {
    const candidates = list.features
      .filter((f) => f.status === 'in_progress' || f.status === 'not_started')
      .map((f) => `${f.id} (${f.status})`)
    fail(`unknown feature ${id}; candidates: ${candidates.join(', ') || 'none'}`)
  }
  return feature
}

const coreFields = new Set([
  'id',
  'priority',
  'area',
  'title',
  'user_visible_behavior',
  'status',
  'depends_on',
  'ticket',
  'spec',
  'verification',
  'evidence',
  'attempts',
  'max_attempts',
  'notes',
])

export function describeFeature(feature: Feature, list: FeatureList): string {
  const lines = [
    `${feature.id} · ${feature.title} [${feature.status}] priority ${feature.priority} · area ${feature.area}`,
    `  behaviour: ${feature.user_visible_behavior}`,
  ]
  if (feature.ticket) lines.push(`  ticket: ${feature.ticket}`)
  if (feature.spec) lines.push(`  spec: ${feature.spec}`)
  for (const [key, value] of Object.entries(feature)) {
    if (coreFields.has(key) || value === undefined) continue
    lines.push(`  ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
  }
  if (feature.depends_on.length) {
    const byId = new Map(list.features.map((f) => [f.id, f]))
    lines.push(
      `  depends_on: ${feature.depends_on.map((d) => `${d} (${byId.get(d)?.status ?? '?'})`).join(', ')}`,
    )
  }
  lines.push(`  verification:`)
  for (const step of feature.verification) lines.push(`    - ${step}`)
  if (feature.evidence.length) {
    lines.push(`  evidence:`)
    for (const line of feature.evidence) lines.push(`    - ${line}`)
  }
  lines.push(
    `  attempts: ${feature.attempts}${feature.max_attempts ? `/${feature.max_attempts}` : ''}`,
  )
  lines.push(`  ready: ${isReady(feature, list)} · human-only: ${isHumanOnly(feature)}`)
  if (feature.notes) lines.push(`  notes: ${feature.notes}`)
  return lines.join('\n')
}

function appendNote(feature: Feature, note: string): void {
  feature.notes = feature.notes.trim() ? `${feature.notes.trim()} ${note}` : note
}

/** Runs one `harness feature` command; returns the exit code. */
export function featureCommand(argv: string[], project: Project = loadProject()): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      'include-manual': { type: 'boolean', default: false },
      exclude: { type: 'string' },
      status: { type: 'string' },
      reason: { type: 'string' },
      file: { type: 'string' },
    },
  })
  const [command, id] = positionals
  const { config } = project
  const file = values.file ? path.resolve(values.file) : project.resolve(config.project.featureList)
  const list = readFeatureList(file, config.features)
  const save = () => {
    list.last_updated = today()
    writeFeatureList(list, { file, features: config.features, cwd: project.root })
  }

  try {
    switch (command) {
      case 'next': {
        const exclude = values.exclude ? values.exclude.split(',').map((s) => s.trim()) : []
        const feature = nextReadyFeature(list, {
          includeHumanOnly: values['include-manual'],
          exclude,
        })
        if (values.json) {
          console.log(JSON.stringify(feature ?? null))
        } else if (feature) {
          console.log(feature.id)
        }
        return feature ? 0 : 3
      }
      case 'show': {
        const feature = requireFeature(list, id)
        console.log(values.json ? JSON.stringify(feature, null, 2) : describeFeature(feature, list))
        return 0
      }
      case 'list': {
        const status = values.status as FeatureStatus | undefined
        if (status && !featureStatuses.includes(status)) fail(`unknown status ${status}`)
        const rows = list.features
          .filter((f) => !status || f.status === status)
          .sort((a, b) => a.priority - b.priority)
          .map(
            (f) =>
              `${f.id}  ${f.status.padEnd(11)} p${String(f.priority).padStart(3)}  ${f.area.padEnd(12)} ${f.title}${
                isReady(f, list) ? (isHumanOnly(f) ? '  [ready, human-only]' : '  [ready]') : ''
              }`,
          )
        console.log(rows.join('\n'))
        return 0
      }
      case 'activate': {
        const feature = requireFeature(list, id)
        const active = list.features.find((f) => f.status === 'in_progress')
        if (active && active.id !== feature.id) {
          fail(`${active.id} is already in_progress (WIP=1); finish or block it first`)
        }
        if (feature.status === 'in_progress') {
          console.log(`${feature.id} is already in_progress`)
          return 0
        }
        if (feature.status !== 'not_started') {
          fail(
            `${feature.id} is ${feature.status}; only not_started features can be activated (unblock first)`,
          )
        }
        if (!isReady(feature, list)) {
          const byId = new Map(list.features.map((f) => [f.id, f]))
          const waiting = feature.depends_on.filter((d) => byId.get(d)?.status !== 'passing')
          fail(`${feature.id} depends on non-passing ${waiting.join(', ')}`)
        }
        feature.status = 'in_progress'
        save()
        console.log(`${feature.id} → in_progress`)
        return 0
      }
      case 'block': {
        const feature = requireFeature(list, id)
        const reason = values.reason?.trim()
        if (!reason) fail('--reason is required')
        feature.status = 'blocked'
        appendNote(feature, `Blocked ${today()}: ${reason}`)
        save()
        console.log(`${feature.id} → blocked`)
        return 0
      }
      case 'unblock': {
        const feature = requireFeature(list, id)
        if (feature.status !== 'blocked') fail(`${feature.id} is ${feature.status}, not blocked`)
        feature.status = 'not_started'
        appendNote(feature, `Unblocked ${today()}.`)
        save()
        console.log(`${feature.id} → not_started`)
        return 0
      }
      case 'attempt': {
        const feature = requireFeature(list, id)
        feature.attempts += 1
        const max = feature.max_attempts ?? config.caps.maxAttempts
        const reason = values.reason?.trim()
        if (reason) appendNote(feature, `Attempt ${feature.attempts} failed ${today()}: ${reason}`)
        let outcome = `${feature.id} attempts ${feature.attempts}/${max}`
        if (feature.attempts >= max && feature.status !== 'passing') {
          feature.status = 'blocked'
          appendNote(feature, `Auto-blocked after ${feature.attempts} attempts; needs a human.`)
          outcome += ' → blocked'
        }
        save()
        console.log(outcome)
        return 0
      }
      default:
        fail(
          `unknown command ${command ?? ''}; use next, show, list, activate, block, unblock or attempt`,
        )
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    console.error(`harness feature: ${error.message}`)
    return 1
  }
}
