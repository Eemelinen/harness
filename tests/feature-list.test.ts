import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { configSchema } from '../src/config'
import {
  featureKeyOrder,
  isHumanOnly,
  isReady,
  nextReadyFeature,
  normalizeFeature,
  summarizeFeatureList,
  validateFeatureList,
  writeFeatureList,
  type Feature,
  type FeatureList,
} from '../src/feature-list'

const feature = (overrides: Partial<Feature> & Pick<Feature, 'id'>): Feature => ({
  priority: Number(overrides.id.slice(2)),
  area: 'test',
  title: overrides.id,
  user_visible_behavior: 'behaves',
  status: 'not_started',
  depends_on: [],
  verification: ['L1: pnpm check'],
  evidence: [],
  attempts: 0,
  notes: '',
  ...overrides,
})

const listWith = (features: Feature[]): FeatureList => ({
  project: 'test',
  last_updated: '2026-09-06',
  rules: {
    single_active_feature: true,
    passing_requires_evidence: true,
    do_not_skip_verification: true,
  },
  status_legend: { not_started: 'a', in_progress: 'b', blocked: 'c', passing: 'd' },
  features,
})

const metsavahti = configSchema.shape.features.parse({
  ticketPattern: '^MV-\\d{3}$',
  ticketExample: 'MV-042',
  extraFields: {
    epic: { pattern: '^E\\d{2}$', example: 'E03', after: 'ticket' },
    design: { type: 'string[]', after: 'spec' },
  },
})

describe('feature list rules', () => {
  it('accepts a valid list and summarises it', () => {
    const list = validateFeatureList(
      listWith([
        feature({ id: 'F-001', status: 'passing', evidence: ['ok'] }),
        feature({ id: 'F-002' }),
      ]),
    )
    expect(summarizeFeatureList(list)).toBe(
      '2 features · 1 passing · 0 in_progress · 0 blocked · 1 not_started · 1 ready (1 unattended) · VCR 1/1',
    )
  })

  it('rejects two in_progress features', () => {
    expect(() =>
      validateFeatureList(
        listWith([
          feature({ id: 'F-001', status: 'in_progress' }),
          feature({ id: 'F-002', status: 'in_progress' }),
        ]),
      ),
    ).toThrow(/WIP=1/)
  })

  it('rejects passing without evidence, blocked without notes and unlabelled steps', () => {
    expect(() =>
      validateFeatureList(listWith([feature({ id: 'F-001', status: 'passing' })])),
    ).toThrow(/no evidence/)
    expect(() =>
      validateFeatureList(listWith([feature({ id: 'F-001', status: 'blocked' })])),
    ).toThrow(/notes do not say why/)
    expect(() =>
      validateFeatureList(listWith([feature({ id: 'F-001', verification: ['run the tests'] })])),
    ).toThrow(/L1: /)
    expect(() => validateFeatureList(listWith([feature({ id: 'F-01' })]))).toThrow(/F-001/)
  })

  it('rejects a "--" before the test file unless the feature already passed', () => {
    const step = 'L1: pnpm test:unit -- tests/unit/a.test.ts (it works)'
    expect(() =>
      validateFeatureList(listWith([feature({ id: 'F-001', verification: [step] })])),
    ).toThrow(/drop the "--"/)
    expect(() =>
      validateFeatureList(
        listWith([
          feature({ id: 'F-001', status: 'passing', verification: [step], evidence: ['ran'] }),
        ]),
      ),
    ).not.toThrow()
  })
})

describe('depends_on rules', () => {
  it('defaults depends_on and attempts when absent', () => {
    const raw = listWith([feature({ id: 'F-001' })]) as unknown as {
      features: Record<string, unknown>[]
    }
    const first = raw.features[0]
    if (!first) throw new Error('unreachable')
    delete first.depends_on
    delete first.attempts
    const list = validateFeatureList(raw)
    expect(list.features[0]?.depends_on).toEqual([])
    expect(list.features[0]?.attempts).toBe(0)
  })

  it('rejects unknown, self and cyclic dependencies', () => {
    expect(() =>
      validateFeatureList(listWith([feature({ id: 'F-001', depends_on: ['F-999'] })])),
    ).toThrow(/unknown feature F-999/)
    expect(() =>
      validateFeatureList(listWith([feature({ id: 'F-001', depends_on: ['F-001'] })])),
    ).toThrow(/depends on itself/)
    expect(() =>
      validateFeatureList(
        listWith([
          feature({ id: 'F-001', depends_on: ['F-002'] }),
          feature({ id: 'F-002', depends_on: ['F-003'] }),
          feature({ id: 'F-003', depends_on: ['F-001'] }),
        ]),
      ),
    ).toThrow(/cycle: F-001 → F-002 → F-003 → F-001/)
  })

  it('rejects in_progress while a dependency is not passing', () => {
    expect(() =>
      validateFeatureList(
        listWith([
          feature({ id: 'F-001' }),
          feature({ id: 'F-002', status: 'in_progress', depends_on: ['F-001'] }),
        ]),
      ),
    ).toThrow(/depends on non-passing F-001/)
  })

  it('computes readiness, human-only and the next feature by priority', () => {
    const list = validateFeatureList(
      listWith([
        feature({ id: 'F-001', status: 'passing', evidence: ['ok'] }),
        feature({ id: 'F-002', depends_on: ['F-001'], priority: 20 }),
        feature({ id: 'F-003', depends_on: ['F-004'], priority: 5 }),
        feature({ id: 'F-004', priority: 30 }),
        feature({
          id: 'F-005',
          priority: 1,
          verification: ['L1: pnpm check', 'manual: look at it'],
        }),
      ]),
    )
    const byId = (id: string) => list.features.find((f) => f.id === id) as Feature
    expect(isReady(byId('F-002'), list)).toBe(true)
    expect(isReady(byId('F-003'), list)).toBe(false)
    expect(isHumanOnly(byId('F-005'))).toBe(true)
    expect(nextReadyFeature(list)?.id).toBe('F-002')
    expect(nextReadyFeature(list, { includeHumanOnly: true })?.id).toBe('F-005')
    expect(nextReadyFeature(list, { exclude: ['F-002'] })?.id).toBe('F-004')
    expect(summarizeFeatureList(list)).toMatch(/3 ready \(2 unattended\)/)
  })
})

describe('project-specific fields', () => {
  it('checks the ticket against the configured pattern', () => {
    expect(() =>
      validateFeatureList(listWith([feature({ id: 'F-001', ticket: 'FIN-001' })]), metsavahti),
    ).toThrow(/ticket must look like MV-042/)
    expect(() =>
      validateFeatureList(listWith([feature({ id: 'F-001', ticket: 'MV-001' })]), metsavahti),
    ).not.toThrow()
  })

  it('accepts declared extra fields and rejects undeclared ones instead of dropping them', () => {
    const withExtras = feature({ id: 'F-001', ticket: 'MV-001', epic: 'E03', design: ['a#b'] })
    expect(validateFeatureList(listWith([withExtras]), metsavahti).features[0]?.design).toEqual([
      'a#b',
    ])
    expect(() =>
      validateFeatureList(listWith([feature({ id: 'F-001', epic: 'X' })]), metsavahti),
    ).toThrow(/epic must look like E03/)
    expect(() => validateFeatureList(listWith([withExtras]))).toThrow(/epic|design|Unrecognized/)
  })

  it('normalises key order with extra fields after the key they name', () => {
    expect(featureKeyOrder(metsavahti)).toEqual([
      'id',
      'priority',
      'area',
      'title',
      'user_visible_behavior',
      'status',
      'depends_on',
      'ticket',
      'epic',
      'spec',
      'design',
      'verification',
      'evidence',
      'attempts',
      'max_attempts',
      'notes',
    ])
    const keys = Object.keys(
      normalizeFeature(
        feature({ id: 'F-001', design: ['d'], spec: 'x', ticket: 'MV-042', epic: 'E01' }),
        metsavahti,
      ),
    )
    expect(keys.slice(7, 11)).toEqual(['ticket', 'epic', 'spec', 'design'])
  })

  it('keeps two extra fields after the same key in config order', () => {
    const features = configSchema.shape.features.parse({
      extraFields: { a: { after: 'spec' }, b: { after: 'spec' } },
    })
    const order = featureKeyOrder(features)
    expect(order.slice(order.indexOf('spec'), order.indexOf('spec') + 3)).toEqual([
      'spec',
      'a',
      'b',
    ])
  })

  it('writes a list that reads back identically', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-list-'))
    const file = path.join(dir, 'feature_list.json')
    const list = validateFeatureList(
      listWith([feature({ id: 'F-001', ticket: 'MV-001', epic: 'E01', design: ['x'] })]),
      metsavahti,
    )
    writeFeatureList(list, { file, features: metsavahti, format: false })
    const written = readFileSync(file, 'utf8')
    writeFeatureList(validateFeatureList(JSON.parse(written), metsavahti), {
      file,
      features: metsavahti,
      format: false,
    })
    expect(readFileSync(file, 'utf8')).toBe(written)
  })
})

describe('error report', () => {
  it('groups one problem repeated across features into one line', () => {
    const many = Array.from({ length: 8 }, (_, i) => feature({ id: `F-00${i + 1}`, epic: 'E01' }))
    let message = ''
    try {
      validateFeatureList(listWith(many))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message.split('\n')).toEqual([
      'feature_list.json is invalid:',
      '✖ Unrecognized key: "epic"',
      '  → at features[0], features[1], features[2], features[3], features[4] and 3 more',
    ])
  })
})
