# Why this harness exists

Each part of the harness counters one specific way coding agents fail. Knowing which failure a part
prevents is what lets a project configure it, or leave it out, without losing its purpose.

## Background and sources

The harness implements the course **Learn Harness Engineering** by walkinglabs, lectures 1–13,
on Claude Code. That course is based on two Anthropic engineering articles.

| Source                                                                                                                                                                   | What it contributes                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [learn-harness-engineering (GitHub)](https://github.com/walkinglabs/learn-harness-engineering) · [course site](https://walkinglabs.github.io/learn-harness-engineering/) | 14 lectures (`docs/en/lectures/lecture-NN-*/`); starter templates for `AGENTS.md`, `feature_list.json`, `init.sh` and a progress file (`docs/en/resources/templates/`); the `skills/harness-creator/` skill; `tools/audit-harness.sh` |
| [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) (Anthropic, Nov 2025)                   | Initializer session + `init.sh` + progress file + JSON feature list; one feature per session; commit and leave a clean state; the session-start routine; end-to-end testing like a user                                               |
| [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) (Anthropic, Mar 2026)                  | Separate generator and evaluator; context resets with structured handoff instead of compaction; agreeing on "done" before work starts; removing harness parts as models improve                                                       |

You do not need to read these sources to use the harness; this guide carries what matters.
Read them when a design question comes up that the guide does not answer.

## Failure modes and the part that counters each

| Failure mode (course lecture)                                                         | Counter-measure in this harness                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A strong model still fails on real tasks because the environment is unclear (L01–L02) | The whole harness: explicit instructions, state, verification and lifecycle                                                                                                               |
| Knowledge lives in the chat and is lost at the next session (L03)                     | Repo files are the only memory: `AGENTS.md`, `PROGRESS.md`, `feature_list.json`, `docs/DECISIONS.md`                                                                                      |
| One giant instruction file is ignored or contradicts itself (L04)                     | `AGENTS.md` is a short router with constraints carrying `why:`/`source:`, and links out to detail                                                                                         |
| Long tasks lose continuity across context windows (L05)                               | Clock-in reads state and clock-out writes it; `PROGRESS.md` has Current Verified State and Next Steps; the session-start hook prints them; the driver gives every feature a fresh session |
| Setup is redone or broken in every session (L06)                                      | `init.sh` is the single startup path, and `FAST=1 ./init.sh` must always exit 0 (the clean-state check enforces it)                                                                       |
| The agent overreaches: starts several things and finishes none (L07)                  | WIP=1, enforced by `harness check` and `harness feature activate`; features sized for one session; the evaluator scores scope                                                             |
| Work has no shared, machine-readable definition (L08)                                 | `feature_list.json`: a JSON queue with `depends_on`, `verification` and `evidence`, changed only by scripts                                                                               |
| The agent declares victory early (L09)                                                | `passing` requires evidence that `harness:verify` writes itself; the driver post-check and a fresh-context evaluator re-check the claim                                                   |
| Unit tests pass but the feature does not work (L10)                                   | Named layers L1 → L2 → L3, run in order and never skipped; L3 is required when a change crosses components                                                                                |
| Nobody can tell afterwards what the agent did (L11)                                   | `.harness/traces/*.jsonl`, `.harness/runs.jsonl`, `harness report`, evidence lines and PR bodies                                                                                          |
| A session leaves the repo dirty or half-done (L12)                                    | `harness clean-state` at clock-out, in the Stop hook and in the driver post-check; the commit gates                                                                                       |
| A human has to keep prompting the agent (L13)                                         | `harness loop`: preflight → worktree → generator → post-check → evaluator → PR → merge → next                                                                                             |
| The agent grades its own work too kindly (Anthropic, 2026)                            | The evaluator is a separate read-only session with a strict rubric and a JSON verdict; its tuning log calibrates it against human judgement                                               |
| An unattended agent does something destructive (Metsävahti D-008)                     | Deny list, the guard hook, auto-mode classifier with `--permission-prompts none`, caps, a PR per feature with CI as the merge gate                                                        |

## Principles to keep when adapting

These are what make the harness work. A project that drops one of them is not the same harness.

1. **Gates are scripts, not prose.** If a rule matters, a script with an exit code enforces it,
   and skills, hooks, the driver and CI call that same script.
2. **State changes only through scripts.** Nobody hand-edits a feature's `status`, whether human
   or agent.
3. **Evidence over confidence.** The status `passing` is a consequence of commands that ran,
   never a judgement call.
4. **One feature, one session, one PR.** Small units keep context, review and rollback cheap.
5. **The interactive path and the unattended path are the same path.** The driver runs the
   same skills and scripts a human would, plus stricter stop conditions.
6. **Fail closed.** Unknown verdicts count as Revise, `manual:` steps are never waived
   unattended, and missing Docker fails verification instead of skipping a layer.
7. **Every constraint states its reason.** A rule whose `why:` no longer holds can be removed
   safely; a rule without one cannot.

## What to build first

Adopt it in this order, so the harness is useful at every step:

1. **Phase 1 (agent-followed loop):** `AGENTS.md`, `PROGRESS.md`, `feature_list.json`,
   `init.sh`, the package (`check`, `feature`, `verify`, `clean-state`), the plugin (hooks and
   skills), `.claude/settings.json` permissions and the commit gates. This alone fixes L03–L12.
2. **Phase 2 (driver-run loop):** the `loop` part of `harness.config.json` (models, caps,
   `allowedTools`), the evaluator rubric, CI with required checks, and branch protection. Add it
   once phase 1 has run cleanly for a few interactive sessions.
3. **Optional:** a ticket importer, a quality document, design-system lint, and a services
   preflight. Add them only when the project has the matching need.

Small projects without integration or end-to-end tests can ship phase 1 with only L1. Skip what
the project does not need, but never keep a gate that is weakened to always pass.
