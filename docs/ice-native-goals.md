# ICE-native goals

This fork keeps the upstream Pi implementation and adds a separate ICE entry at `native/extension.ts`. ICE's `ice` manifest selects that entry; the upstream `pi` manifest is not merged into it.

The native entry is optional and off by default. It uses the existing parent Ice session, native session entries, Subagents V2, and the configured ICE verifier. It does not load upstream Goal X's SDK auditor, goal-file database/locks, provider payload hooks, or network recovery loop.

## Current delivery scope

Implemented locally: guided proposals, explicit approval, session-local goals and focus, task evidence, pause/resume/revision/clear, compact or expanded widgets, bounded continuation, independent review through V2, and fresh host verification. This is the first native slice, not full upstream UI/command parity.

Not implemented in the native entry: project-wide Workgraph linking, cross-session goal pools, the blocker Oracle, the upstream settings editor, generic waits, or automatic old `.pi` data migration. Sisyphus metadata is an ordered-plan style, not deterministic dependency enforcement. Workgraph remains the durable project-work authority; enabling Workgraph dispatch blocks session-local goal continuation rather than starting two coordinators.

No package has been published and local implementation changes have not been pushed. Use a reviewed local checkout for testing; the GitHub fork still contains its upstream baseline until an explicit push is approved.

## Host requirements

- The ICE source build containing `Symbol.for("ice.goals.host.v1")` with `snapshot` and authorized `verify`.
- Native Subagents V2 with reported cache-write usage for complete capped-run accounting.
- A saved session and trusted build mode for execution and approval.
- A user-configured verifier, supplied through `--ice-verify` as a JSON argv array. The extension cannot replace it with model-authored shell commands.
- A reviewed `ice-goal-review` definition requesting only `read`, `grep`, `find`, and `ls`, with `permissionMode: review`. The supplied definition is `native/agents/ice-goal-review.md`. Provision it explicitly in an approved agent directory; do not overwrite an existing definition silently. Validation itself is provider-free:

```bash
ice agents validate ./native/agents/ice-goal-review.md
```

These are in-process permissions, not an OS sandbox. Trusted verifier commands run as the host user. Use independent isolation for untrusted or unattended execution; no autonomous safety certification is claimed.

## Loading the local entry

From the fork checkout, explicitly load the source entry. This does not install it globally:

```bash
ice --offline -e ./native/extension.ts --ice-goals --ice-mode plan
```

Plan mode permits session-native proposals only. It cannot approve goals, execute their work, or run verification.

For execution, choose and review the verifier command before startup. For example, a project's known regression script:

```bash
ice -e ./native/extension.ts --ice-goals --ice-mode build --approve \
  --ice-verify '["node","scripts/verify-goal.mjs"]'
```

Use `--ice-allow-bash` only if the work actually needs host Bash. Goals does not require broad `--allow-external`, change your model route, or install credentials. Merely loading the entry without `--ice-goals` registers no goal tools or commands.

## Workflow

1. Invoke `/goal <idea>` explicitly. Normal prompts do not create goals.
2. Discuss outcome, constraints, task contracts, required verification and relevant evidence files. The model saves a paused proposal through `propose_goal_draft`.
3. Inspect the complete proposal with `/goal-status expand`, then `/goal-approve`. The confirmation includes the objective, full task tree, contracts, budget, evidence scope, canonical workspace and verifier identity.
4. Use `/goal-resume` explicitly to start work.
5. The model records task evidence and requests completion using `update_goal`. Its own claim never accepts the goal.
6. The existing host verifier runs first; a failing or stale receipt stops completion before review. A separate V2 reviewer then inspects actual evidence against the frozen criteria, given the host-observed receipt, and must list every approved evidence path. Only a matching fresh receipt, valid approval and approved evidence unchanged through review can complete the goal.

Changing the objective/task contracts invalidates approval. Changing the workspace or configured verifier requires explicit reapproval. File scope must include every relevant source/test/artifact input needed to establish the goal; the file hash is not a whole-filesystem snapshot.

## Commands

| Command | Behavior |
| --- | --- |
| `/goal [idea]` | Begin guided drafting without execution authority |
| `/goal-approve` | Explicitly approve the full focused proposal in trusted build mode |
| `/goal-resume` | Resume an approved goal with a finite run allowance |
| `/goal-pause` | Stop goal continuation and cancel owned review |
| `/goal-tweak <change>` | Draft a revision; reapproval is mandatory |
| `/goal-focus <id>` | Select a session-local goal; focus does not silently resume it |
| `/goal-unfocus` | Detach session focus without accepting work |
| `/goal-list` | List goals in the current session branch |
| `/goal-status [expand]` | Inspect state and toggle the expanded widget |
| `/goal-clear` | Confirm clearing current goal state; session history is retained and no success is claimed |
| `/goal-cancel` | Cancel drafting without deleting work or accepting it |

## Limits and recovery

- Default 20 extension-started runs per explicit resume; proposals may request a finite allowance of at most 100, shown for approval.
- At most three review attempts: initial review plus two repairs. Failed/interrupted attempts count. Criterion revision/reapproval is explicit.
- `tokenBudget` and `maxRuns` accept `null` for unset, because some provider routes fill every declared tool field. Revising a budget-limited goal requires removing the budget or raising it above the tokens already used.
- Optional user-requested token budget counts observed uncached input, cache writes and output for the parent and goal-owned review. Cache reads remain separately observed. This is not a prepaid provider-billing guarantee; a reported turn can overshoot the cap. Missing usage pauses capped work rather than implying free usage.
- No extra goal-level provider retry loop. Native retries remain host-owned; failed/aborted work pauses for inspection.
- Restored active goals pause. Interrupted effects, queued checkpoints and reviewers are not automatically replayed.
- An in-flight review retains its native child reference. If it was interrupted before usage was recorded, restored capped goals remain blocked by unknown usage. Inspect that child and its effects before changing the budget or revising the goal.
- Evidence scope is 1–50 non-secret, non-symlink regular file paths, bounded to 16 MiB total per snapshot. Traversal, protected agent/credential paths, directories and oversized reads are refused.
- Native snapshots are capped at 128 KiB, 20 goals and 50 tasks per goal with bounded depth and text. Large proposals fail rather than silently dropping requirements.

User input takes priority and pauses continuation. Cancellation is cooperative and does not roll back already-started effects. Open parent-session patches block completion in this first slice; patch integration remains explicit through ICE's own controls.

## Headless clients

Missing confirmation never means approval. `--ice-goals-approve` is an explicit session-wide startup authorization for goal approval in an otherwise trusted build session; it does not change mode, trust, verifier configuration or child permissions. Clearing a goal still requires explicit client confirmation.

RPC/print/JSON projections use plain text and never invoke a terminal component factory. No real-model/provider or live reviewer certification is inferred from unit tests.

## Verification and provenance

The preserved upstream source is MIT licensed. Baseline: `tmonk/pi-goal-x` commit `64c5ace87f3400c0b55ef87f2d2912167f53dbaa`. Original license and author attribution remain.

Provider-free tests live in `native/test/`. ICE host and controller regressions live in its coding-agent package. Implementation records are under `specs/2026-10-13-ice-native-goals/`; observed command results, rather than this document, determine readiness.
