// Opt-in Stop hook for driver-run sessions. Inert unless the loop driver sets
// HARNESS_STOP_GUARD=1. Blocks the session from ending while the machine-checkable clean-state
// checks fail or the active feature is still in_progress, at most 3 times per session (Claude
// Code also caps consecutive Stop-hook blocks).
//   stdout {"decision":"block","reason":"…"} → Claude keeps working; plain exit 0 → may stop
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { loadConfig, projectDir, readInput, runHarness, stripAnsi } from './lib.mjs'

const MAX_BLOCKS = 3

async function main() {
  if (process.env.HARNESS_STOP_GUARD !== '1') return
  const input = await readInput()
  // A previous block already put Claude back to work in this turn; never loop.
  if (input.stop_hook_active === true) return
  const root = projectDir(input)
  if (!loadConfig(root)) return

  const dir = path.join(root, '.harness')
  const counter = path.join(dir, `stop-blocks-${input.session_id ?? 'unknown'}`)
  mkdirSync(dir, { recursive: true })
  let count = 0
  try {
    count = Number(readFileSync(counter, 'utf8')) || 0
  } catch {
    count = 0
  }
  if (count >= MAX_BLOCKS) {
    process.stderr.write('stop-guard: block cap reached for this session; letting it stop\n')
    return
  }

  const report = runHarness(root, ['clean-state', '--quick', '--require-terminal'])
  if (report.code === 0) return

  writeFileSync(counter, String(count + 1))
  const first = stripAnsi(report.out)
    .split('\n')
    .find((l) => l.includes('[FAIL]'))
    ?.replace(/.*\[FAIL\]\s*/, '')
  const reason = `Not clean yet: ${first || report.out.slice(0, 300) || 'clean-state check failed'}. Finish the loop: /harness:verify-feature the active feature (or pnpm harness:feature block <id> --reason "…"), then clock out so the tree is committed. Block ${count + 1}/${MAX_BLOCKS}.`
  console.log(JSON.stringify({ decision: 'block', reason }))
}

await main()
