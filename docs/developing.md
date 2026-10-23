# Developing the harness

Every project pins a release, so a change here reaches a project only when its pins move. That
keeps an experiment in one project from breaking the others.

## Working on a change

```bash
pnpm install
pnpm check          # typecheck, format:check, unit tests
pnpm schema         # after changing src/config.ts; tests fail while the schema file is stale
```

The plugin hooks (`plugin/hooks/*.mjs`) must stay dependency-free: they run from Claude Code's
plugin cache, which has no `node_modules`. Put logic that needs zod in `src/` and call it through
the project's CLI (`runHarness` in `plugin/hooks/lib.mjs`). Put hook logic that tests need in an
importable module (`guard-rules.mjs`) and keep the entry file thin.

## Trying a change in a project before releasing

From the project:

```bash
pnpm add -D "@eemelinen/harness@link:../harness"   # the CLI now runs from your checkout
claude --plugin-dir ../harness/plugin              # the plugin too, for this session
pnpm harness:doctor                                # warns: the plugin pin and the package differ
```

`--plugin-dir` overrides the installed marketplace plugin of the same name. Edits to skills and
hooks apply after `/reload-plugins`. The driver loads the plugin from the installed package, so a
linked package means driver runs use your checkout as well. Do not commit the `link:` dependency.

## Releasing

1. **Version and changelog.** Bump `version` in `package.json` (semver: a config key removed or
   renamed, or a changed CLI flag, is a major change). Add the entry to `CHANGELOG.md`.
2. **Check.** Run `pnpm check`.
3. **Commit and tag.** Commit, then `git tag vX.Y.Z && git push origin main vX.Y.Z`.
4. **Update each project:**
   - `pnpm add -D "@eemelinen/harness@github:Eemelinen/harness#vX.Y.Z"`
   - set the marketplace `ref` in `.claude/settings.json` to `vX.Y.Z`
   - `pnpm harness:doctor`, then `pnpm check`
   - commit as `chore(harness): update to vX.Y.Z`
   - interactive sessions pick the new plugin up after `claude plugin marketplace update eemelinen-harness`
     (or a restart with auto-update on)
