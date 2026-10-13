# Implementation milestones

## 2026-10-13 — authorized fork and baseline

- User approved execution of the plan and asked to continue.
- Created https://github.com/Zykairotis/pi-goal-x; verified GitHub isFork and parent=tmonk/pi-goal-x.
- Cloned into /home/mewtwo/Zks/ice-goal-x; origin points to our fork, upstream to tmonk; branch ice/native-goals at 64c5ace87f3400c0b55ef87f2d2912167f53dbaa.
- No implementation commits, pushes, publication or user runtime changes.
- Initial gh fork rejected a flag before executing. Corrected it; clone auto-added upstream, so did not add it again.
- npm ci --ignore-scripts passed. It reported six inherited high development-tree advisories; full audit retained under /tmp/ice-goal-compare.T4NR5E/upstream-audit.json.
- Six selected provider-free upstream test files: 93 tests passed; original npm run check/tsc passed.
- ICE baseline npm run check started with active npm 12.0.2. Biome and pinned dependency checks passed. The repository-wide TypeScript import scan is unusually slow; no successful final exit is claimed yet.

## Native adaptation in progress

- ICE's tool-provided worktree isolation refused submodules. Created native detached worktrees instead; writers edit only their isolated paths.
- Separate writers implement SessionGoalStore and the narrow host verifier controller. Parent owns integration and verification.
- Added native structural host/reviewer adapters, explicit reviewer profile, completion gate, command/tool entrypoint and evidence-file fingerprint.
- Evidence fingerprint tests: 2 pass.
- Added pending completion/lifecycle test cases; they will run once the isolated state writer is integrated.
- Updated fork package identity/manifest to @zykairotis/ice-goal and ICE-native entry, preserving upstream Pi entry. Direct versions pinned to baseline installed versions. Targeted transitive minimatch/brace-expansion/js-yaml remediation, without changing undici override.
- Lockfile refresh succeeded; audit now reports two remaining advisories. Their details and any remediation need review before package readiness.

## Solo integration and verified first slice

- After the user prohibited subagents, the registry confirmed no children remained. Parent inspected and integrated retained files, then completed all remaining changes directly. No further work was delegated.
- Corrected continuation consumption, reviewer accounting during focus/pause, retained interrupted-review references, third-attempt review accounting, final-turn usage, and strict scope limits.
- Bound approval to actual workspace/verifier identity. Confirmation displays the full goal/task contracts and budget. Source review found native custom follow-ups bypass before_agent_start; moved live goal data to the request-local context hook and consumed checkpoints on message_start. Disabled entry registers no goal commands/tools.
- Added cache-write forwarding from native V2 observations; goal budgets count uncached input/cache writes/output. No billing or hard-prepaid guarantee.
- Added model-text terminal control sanitization and confirmed clear-without-success behavior.
- Reviewed Undici 8.10.0–8.10.2 release notes before applying the fork-only 8.10.2 security override. Hydration used --ignore-scripts. Final fork audit: zero vulnerabilities; no ICE dependency metadata changes.
- Final fork: 45 native regressions and 93 selected upstream regressions pass; upstream/native typechecks pass.
- Final ICE focused tests: 71 pass. Initial faux usage assertion failed because the provider computes input/cache counts from the prompt; corrected the assertion to compare forwarded fields against runtime-observed usage, then reran successfully.
- Mandatory corepack npm@12.0.2 run check passed. Active and required npm version: 12.0.2. Initial filesystem page-read delay cleared without weakening checks.
- coding-agent build passed. Built CLI source-extension loading and reviewer definition validation passed. Freshness survey: no stale affected source files.
- Real isolated RPC startup smoke registered all 11 native commands with zero model requests and no delegated work. Reproduction script: /tmp/ice-goal-compare.T4NR5E/rpc-loading-smoke.mjs; scratch session: /tmp/ice-goals-rpc-smoke-dt5jjA.
- No source commits/pushes, package publication, global extension/agent installation, live model/reviewer run, running-app restart or Curax snapshot. The rebuilt host code is available on the next local ICE launch; Goals remains opt-in and is not globally enabled.

Remaining scope: optional Workgraph linkage/cross-session pools, blocker Oracle, richer upstream settings/UI parity and explicitly approved live reviewer/TUI certification. These are not represented as delivered.

## Post-compaction reconciliation

- Reconciled delayed failure notifications against the current usage-forwarding test. The corrected observed-usage assertion is present; no additional source changes were needed.
- Fresh solo reruns: all 71 host/controller tests, all 45 native tests and both fork typechecks pass.
- Fresh corepack npm@12.0.2 run check passed with no formatting fixes. Full output retained at /tmp/ice-goal-compare.T4NR5E/post-compaction-root-check.log.
- Fresh runtime survey found no stale affected files and confirmed installed ice points to this worktree's dist. Output retained at /tmp/ice-goal-compare.T4NR5E/post-compaction-runtime-survey.log.
- Fresh RPC startup smoke registered all 11 goal commands with zero model requests. Output retained at /tmp/ice-goal-compare.T4NR5E/post-compaction-rpc-smoke.log; scratch session /tmp/ice-goals-rpc-smoke-cQ6fKC.
- No new delegation, source changes, build, global installation, live provider request, commit, push or Curax update. Setup and live reviewer/TUI checks remain separate approval gates.

## 2026-10-13 — first live TUI run and fixes

- Live tmux run against the rebuilt local ICE, route omni cx/gpt-6.1-sol (medium), scratch git repo with a project-local ice-goal-review definition and `--ice-verify '["node","verify.mjs"]'`.
- Plan mode: all 11 commands registered; /goal-approve refused with "requires a trusted build session".
- Defect 1: the route filled every optional tool field, so propose_goal_draft set tokenBudget 1 and maxRuns 1. The goal became budget_limited on its first run, and every revision kept the budget and was rejected. Fixed by making both fields nullable and mapping null to unset; revise now names the required budget change.
- Defect 2: the reviewer correctly withheld approval because the criteria required the configured verifier and the host ran it only after review. Every goal whose criteria named the verifier deadlocked. Fixed by running the host verifier first, passing its receipt to the reviewer, and re-checking generation, patches and approved-file hashes after review. Approval also failed when the reviewer listed extra inspected files; evidence now must cover every approved path and may include others.
- Two earlier reviewer launches failed with the provider error "Our servers are currently overloaded" and zero usage; that was transient, and the goal failed closed as designed.
- After the fixes: 50 native tests, both typechecks and eslint pass. A fresh live run went draft, approve (tokenBudget null, maxRuns 20), resume, write, host verifier pass, reviewer approval, complete, with known usage (12,694 tokens).
- No commit, push, publication, global installation or Curax snapshot.
