# ICE-native adaptation implementation

The approved full plan is retained at /tmp/ice-goal-compare.T4NR5E/ICE-GOAL-X-PLAN.md. This document records the first implementation slice, not a claim that every optional stage is delivered.

## Modules

- native/state.ts: bounded SessionGoalStore, native custom entries, persistence-before-commit, strict restoration, approved criteria hash, stale-operation generations and finite allowances.
- native/host.ts: structural adapters to Symbol.for("ice.goals.host.v1") and Symbol.for("ice.subagents.controller.v1"). No direct SDK agent sessions or shell execution.
- native/extension.ts: explicitly enabled commands/tools, drafting/approval/focus, bounded native follow-up on settled, user-input priority, fresh authority checks, dashboard projections.
- native/completion.ts: host-configured verification first, then finite read-only V2 review given the host receipt; exact criteria/session/root/command/generation receipt checks and before/after approved-file hashes. Required tasks must be complete, not skipped.
- native/workspace.ts: bounded hashes of explicitly approved regular evidence files. Refuses traversal, secret/configuration paths, symlinks, directories and oversized reads. Scope must include all relevant source/test/artifact inputs; this is not a whole-filesystem or OS sandbox guarantee.
- native/agents/ice-goal-review.md: read-only profile for explicit provision through native agent configuration. Installation must not silently copy it into user settings.

Reuse unchanged upstream pure domain modules for goal/task types, titles/status/token formatting and task counts. ICE entry does not import goal-auditor, goal-files/locks, ledger, provider-payload cache hooks or the upstream scheduler. Original extension remains on the fork for ancestry and regression comparison.

## Host integration

ICE safe-verify publishes a versioned controller exposing snapshot(ctx) and verify(ctx,{signal}). It runs only the already-configured host verifier under current trusted build authority. Missing controller/configuration/approval, stale context, abort or overlap fail closed. Native automatic verification remains owned by the existing host.

The dedicated reviewer is provisioned explicitly; native permissions/depth/cancellation/budgets remain authoritative. A V2 structured payload is untrusted semantic evidence. A passing command is necessary but does not alone prove the objective. No project-wide Workgraph interface is invented.

## Verification

Upstream selected six-file baseline: 93 tests pass, original tsc check passes. npm ci --ignore-scripts reported six inherited development-tree high vulnerabilities; audit artifact /tmp/ice-goal-compare.T4NR5E/upstream-audit.json. Reviewed fixes pin direct versions and override minimatch/brace-expansion/js-yaml. After reading Undici 8.10.0–8.10.2 release notes and evaluating transport/cache/decompression changes, the fork-only override moved to 8.10.2. Final fork npm audit reports zero vulnerabilities; ICE's dependency metadata is unchanged.

Final verification: 45 native tests pass; 93 selected preserved upstream tests pass; both fork typechecks pass; 71 ICE host/guard/controller tests pass using fake/faux providers. Mandatory corepack npm@12.0.2 run check passed with no fixes/warnings after an unusually slow filesystem import scan. The coding-agent package build passed. Built CLI loading and definition validation passed; runtime freshness survey found no stale affected files. A real isolated RPC startup smoke registered all 11 native commands and sent zero model requests.

No global runtime activation, live model run, commit, push, package publication or Curax update has occurred.
