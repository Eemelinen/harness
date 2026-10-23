/**
 * Writes schema/harness.config.schema.json from the zod schema, so a project's
 * harness.config.json gets completion and validation in the editor through `$schema`.
 *   pnpm schema        (tests/config.test.ts fails when the file is stale)
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { configSchema } from '../src/config'

export function configJsonSchema(): string {
  const schema = z.toJSONSchema(configSchema, { io: 'input', unrepresentable: 'any' })
  return `${JSON.stringify({ ...schema, title: 'harness.config.json' }, null, 2)}\n`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../schema/harness.config.schema.json',
  )
  writeFileSync(file, configJsonSchema())
  console.log(`wrote ${path.relative(process.cwd(), file)}`)
}
