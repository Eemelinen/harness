- This repository is the harness itself. Read the module's header comment and the doc it links
  (`docs/how-it-works.md`, `docs/config.md`, `docs/self-improvement.md`) before changing it.
- A retro feature's `notes` hold the issue's problem, evidence and proposed fix. The traces it cites
  live in the reporting project, not here; reproduce the problem in a test instead (a temporary
  directory, a synthetic stream-json trace, a command string for the guard).
- Plugin hooks (`plugin/hooks/*.mjs`) must stay dependency-free. Logic the CLI and a hook share
  lives in the hook file and is imported by `src/` (see `plugin/hooks/guard-rules.mjs`).
- After changing `src/config.ts`, run `pnpm schema`. Never edit `schema/harness.config.schema.json`,
  `CHANGELOG.md` or `version` by hand.
- Never run `pnpm harness:loop`, `pnpm harness:retro`, `claude` or `gh`.
