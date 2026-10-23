// PostToolUse hook: run the project's formatter (harness.config.json → format, Prettier by
// default) on the edited file. Never blocks. Inert without harness.config.json or with
// `"format": null`.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { loadConfig, projectDir, readInput } from './lib.mjs'

const DEFAULT_FORMAT = 'pnpm exec prettier --write --log-level warn --ignore-unknown'

async function main() {
  const input = await readInput()
  const root = projectDir(input)
  const config = loadConfig(root)
  if (!config) return
  const format = config.format === undefined ? DEFAULT_FORMAT : config.format
  if (!format) return
  const file = input.tool_input?.file_path
  if (typeof file !== 'string' || !file) return
  const abs = path.resolve(root, file)
  const rel = path.relative(root, abs)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || !existsSync(abs)) return
  spawnSync(`${format} "${abs}"`, { cwd: root, shell: true, stdio: 'ignore', timeout: 20_000 })
}

await main()
