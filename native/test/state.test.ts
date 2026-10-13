import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_REVIEW_ATTEMPTS,
	NATIVE_STATE_ENTRY,
	type NativeGoal,
	type NativeCompletionReceipt,
	type NativeGoalProposal,
	type NativeSnapshot,
	SessionGoalStore,
} from "../state.ts";
import type { GoalTask } from "../../extensions/goal-record.ts";

const SESSION = "session-a";
const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

function copy<T>(value: T): T {
	return structuredClone(value);
}

function task(id: string, title = id, extra: Partial<GoalTask> = {}): GoalTask {
	return { id, title, status: "pending", ...extra };
}

function proposal(
	overrides: Partial<NativeGoalProposal> = {},
): NativeGoalProposal {
	return {
		objective: "Deliver the bounded native state slice.",
		verificationContract: "Run the deterministic native tests.",
		scopeFiles: ["native/state.ts"],
		...overrides,
	};
}

function harness(options: { fail?: () => boolean; sessionId?: string } = {}): {
	store: SessionGoalStore;
	entries: unknown[];
	appended: NativeSnapshot[];
} {
	const entries: unknown[] = [];
	const appended: NativeSnapshot[] = [];
	let sequence = 0;
	const store = new SessionGoalStore(
		(customType, data) => {
			appended.push(copy(data));
			if (options.fail?.() === true) throw new Error("append failed");
			entries.push({ type: "custom", customType, data: copy(data) });
		},
		() => NOW,
		() => `goal-${++sequence}`,
	);
	store.restore(entries, options.sessionId ?? SESSION);
	return { store, entries, appended };
}

function activeGoal(
	store: SessionGoalStore,
	input: NativeGoalProposal = proposal(),
): NativeGoal {
	const goal = store.propose(input);
	store.approve(goal.id, "command-hash", "/workspace/project");
	store.focus(goal.id);
	store.resume();
	return store.get(goal.id)!;
}

function receipt(
	goal: NativeGoal,
	sessionId = SESSION,
): NativeCompletionReceipt {
	return {
		criteriaHash: goal.criteriaHash,
		sessionId,
		root: "/workspace/project",
		commandHash: "command-hash",
		status: "passed",
		workspaceHash: "workspace-hash",
	};
}

function latestEntry(entries: readonly unknown[]): NativeSnapshot {
	const entry = entries.at(-1);
	assert.ok(entry && typeof entry === "object" && !Array.isArray(entry));
	const data = (entry as { data?: unknown }).data;
	assert.ok(data && typeof data === "object" && !Array.isArray(data));
	return copy(data as NativeSnapshot);
}

test("proposes paused goals, requires approval, focuses, resumes, and isolates reads", () => {
	const { store } = harness();
	const created = store.propose(proposal());
	assert.equal(created.status, "paused");
	assert.equal(created.approved, false);
	assert.equal(created.maxRuns, 20);
	assert.equal(created.runsUsed, 0);
	assert.equal(created.usageKnown, true);

	store.approve(created.id, "command-hash", "/workspace/project");
	assert.equal(store.get(created.id)?.status, "paused");
	assert.equal(store.get(created.id)?.approved, true);
	store.focus(created.id);
	store.resume();
	assert.equal(store.focused()?.status, "active");

	const returned = store.get(created.id)!;
	returned.scopeFiles.push("mutated.ts");
	returned.usage.tokensUsed = 999;
	assert.deepEqual(store.get(created.id)?.scopeFiles, ["native/state.ts"]);
	assert.equal(store.get(created.id)?.usage.tokensUsed, 0);

	const snapshot = store.snapshot();
	snapshot.goals[0]!.objective = "mutated outside";
	snapshot.goals[0]!.scopeFiles.push("another.ts");
	assert.equal(store.get(created.id)?.objective, proposal().objective);
	assert.deepEqual(store.get(created.id)?.scopeFiles, ["native/state.ts"]);
});

test("appends before installing state and preserves memory on persistence failure", () => {
	let shouldFail = true;
	const appended: NativeSnapshot[] = [];
	const store = new SessionGoalStore(
		(_customType, data) => {
			appended.push(data);
			data.goals.length = 0;
			if (shouldFail) throw new Error("durability unavailable");
		},
		() => NOW,
		() => "goal-1",
	);
	store.restore([], SESSION);
	const before = store.snapshot();
	assert.throws(() => store.propose(proposal()), /durability unavailable/);
	assert.deepEqual(store.snapshot(), before);
	assert.equal(store.get("goal-1"), undefined);

	shouldFail = false;
	const goal = store.propose(proposal());
	assert.equal(goal.id, "goal-1");
	assert.equal(appended.length, 2);
	assert.equal(store.get(goal.id)?.objective, proposal().objective);
});

test("validates scope, task count, duplicate ids, and nesting bounds", () => {
	const { store } = harness();
	for (const scopeFiles of [
		["../secret"],
		["/absolute"],
		["C:\\absolute"],
		["src/./file.ts"],
		["src//file.ts"],
	]) {
		assert.throws(
			() => store.propose(proposal({ scopeFiles })),
			/relative|traversal|segments/,
		);
	}

	assert.throws(
		() =>
			store.propose(
				proposal({
					tasks: [task("same"), task("same")],
				}),
			),
		/Duplicate task id/,
	);
	const tooMany = Array.from({ length: 51 }, (_, index) => task(`t-${index}`));
	assert.throws(
		() => store.propose(proposal({ tasks: tooMany })),
		/more than 50/,
	);
	const tooDeep: GoalTask = task("d0", "d0", {
		subtasks: [
			task("d1", "d1", {
				subtasks: [
					task("d2", "d2", {
						subtasks: [task("d3", "d3", { subtasks: [task("d4")] })],
					}),
				],
			}),
		],
	});
	assert.throws(() => store.propose(proposal({ tasks: [tooDeep] })), /depth/);
});

test("criteria hash excludes progress but rejects changed criteria on restore", () => {
	const { store, entries } = harness();
	const goal = activeGoal(
		store,
		proposal({
			tasks: [task("one", "One", { verificationContract: "show one" })],
		}),
	);
	const before = goal.criteriaHash;
	store.updateTask("one", "complete", "observed evidence");
	assert.equal(store.get(goal.id)?.criteriaHash, before);

	const malformed = latestEntry(entries);
	malformed.goals[0]!.objective = "changed objective";
	const restored = new SessionGoalStore(
		() => {},
		() => NOW,
		() => "unused",
	);
	assert.throws(
		() =>
			restored.restore(
				[{ type: "custom", customType: NATIVE_STATE_ENTRY, data: malformed }],
				SESSION,
			),
		/criteriaHash/,
	);
	assert.equal(store.get(goal.id)?.objective, goal.objective);
});

test("restores only the owner session and pauses active state", () => {
	const source = harness();
	const goal = activeGoal(source.store);
	const entries = copy(source.entries);
	const fork = new SessionGoalStore(
		() => {},
		() => NOW,
		() => "fork-goal",
	);
	fork.restore(entries, "session-b");
	assert.equal(fork.snapshot().goals.length, 0);
	assert.equal(fork.snapshot().sessionId, "session-b");

	const restored = new SessionGoalStore(
		() => {},
		() => NOW,
		() => "restored-goal",
	);
	restored.restore(entries, SESSION);
	assert.equal(restored.get(goal.id)?.status, "paused");
	assert.match(restored.get(goal.id)?.pauseReason ?? "", /Restored/);
	assert.equal(
		restored.isCurrent({
			goalId: goal.id,
			generation: source.store.snapshot().generation,
			criteriaHash: goal.criteriaHash,
		}),
		false,
	);
});

test("focus and criteria changes invalidate in-flight operations", () => {
	const { store } = harness();
	const goal = activeGoal(store);
	const continuation = store.claimContinuation();
	assert.ok(continuation);
	assert.equal(store.isCurrent(continuation), true);
	store.focus(null);
	assert.equal(store.isCurrent(continuation), false);
	assert.throws(
		() => store.complete(continuation, receipt(goal)),
		/stale|different operation/,
	);

	store.focus(goal.id);
	const review = store.beginReview();
	store.revise(proposal({ objective: "A revised objective." }));
	assert.equal(store.isCurrent(review), false);
	assert.equal(store.get(goal.id)?.approved, false);
	assert.equal(store.get(goal.id)?.status, "paused");
	assert.equal(store.get(goal.id)?.receipt, undefined);
	store.approve(goal.id, "command-hash", "/workspace/project");
	store.resume();
	const taskReview = store.beginReview();
	store.replaceTasks([task("replacement")]);
	assert.equal(store.isCurrent(taskReview), false);
	assert.equal(store.get(goal.id)?.approved, false);
});

test("task updates enforce children, contracted evidence, and human skip reasons", () => {
	const { store } = harness();
	const goal = activeGoal(
		store,
		proposal({
			tasks: [
				task("parent", "Parent", {
					subtasks: [
						task("child", "Child", { verificationContract: "show child" }),
					],
				}),
			],
		}),
	);
	const criteriaHash = goal.criteriaHash;
	assert.throws(
		() => store.updateTask("parent", "complete"),
		/pending subtask/,
	);
	assert.throws(
		() => store.updateTask("child", "complete"),
		/requires evidence/,
	);
	assert.throws(() => store.updateTask("parent", "skipped"), /explicit reason/);
	store.updateTask("child", "complete", "child evidence");
	store.updateTask("parent", "complete");
	assert.equal(store.get(goal.id)?.criteriaHash, criteriaHash);
	assert.equal(store.get(goal.id)?.taskList?.tasks[0]?.status, "complete");

	const skipGoal = activeGoal(
		store,
		proposal({ objective: "Skip goal", tasks: [task("skip")] }),
	);
	store.updateTask("skip", "skipped", undefined, "human-approved reason");
	assert.equal(store.get(skipGoal.id)?.taskList?.tasks[0]?.status, "skipped");
	store.updateTask("skip", "pending");
	assert.equal(store.get(skipGoal.id)?.taskList?.tasks[0]?.status, "pending");
});

test("continuation runs are finite and resume resets only the run allowance", () => {
	const { store } = harness();
	const goal = activeGoal(store, proposal({ maxRuns: 2 }));
	const first = store.claimContinuation();
	assert.ok(first);
	store.charge(0);
	const second = store.claimContinuation();
	assert.ok(second);
	store.charge(0);
	assert.equal(store.claimContinuation(), undefined);
	assert.equal(store.get(goal.id)?.runsUsed, 2);
	assert.equal(store.get(goal.id)?.status, "paused");
	store.resume();
	assert.equal(store.get(goal.id)?.runsUsed, 0);
	assert.equal(
		store.claimContinuation()?.generation,
		store.snapshot().generation,
	);
});

test("unknown usage pauses capped goals and exhausted budgets cannot resume", () => {
	const { store } = harness();
	const goal = activeGoal(store, proposal({ tokenBudget: 10 }));
	store.charge(undefined);
	assert.equal(store.get(goal.id)?.usageKnown, false);
	assert.equal(store.get(goal.id)?.status, "paused");
	assert.throws(() => store.resume(), /unknown usage/);

	const known = harness().store;
	const knownGoal = activeGoal(
		known,
		proposal({ objective: "Known budget", tokenBudget: 10 }),
	);
	known.charge(10);
	assert.equal(known.get(knownGoal.id)?.status, "budget_limited");
	assert.throws(() => known.resume(), /Budget-limited/);
});

test("reviews allow three total attempts, then pause, and passed receipts complete", () => {
	const { store } = harness();
	const goal = activeGoal(store);
	for (let attempt = 1; attempt < MAX_REVIEW_ATTEMPTS; attempt += 1) {
		const token = store.beginReview();
		assert.equal(store.isCurrent(token), true);
		store.failedReview(token, `review failure ${attempt}`);
		assert.equal(store.get(goal.id)?.reviewAttempts, attempt);
		assert.equal(store.get(goal.id)?.status, "active");
	}
	const finalToken = store.beginReview();
	store.failedReview(finalToken, "final review failure");
	assert.equal(store.get(goal.id)?.reviewAttempts, MAX_REVIEW_ATTEMPTS);
	assert.equal(store.get(goal.id)?.status, "paused");
	assert.throws(() => store.beginReview(), /exhausted/);

	const second = harness();
	const completeGoal = activeGoal(
		second.store,
		proposal({ objective: "Receipt goal" }),
	);
	const review = second.store.beginReview();
	second.store.complete(review, receipt(completeGoal));
	const complete = second.store.get(completeGoal.id)!;
	assert.equal(complete.status, "complete");
	assert.deepEqual(complete.receipt, receipt(completeGoal));
	const returned = second.store.get(completeGoal.id)!;
	returned.receipt!.root = "mutated";
	assert.equal(
		second.store.get(completeGoal.id)?.receipt?.root,
		"/workspace/project",
	);
});

test("malformed native snapshots fail closed without replacing existing memory", () => {
	const { store, entries } = harness();
	const goal = store.propose(proposal());
	const before = store.snapshot();
	const malformed = latestEntry(entries);
	malformed.goals.push(copy(malformed.goals[0]!));
	const candidate = new SessionGoalStore(
		() => {},
		() => NOW,
		() => "candidate",
	);
	assert.throws(
		() =>
			candidate.restore(
				[{ type: "custom", customType: NATIVE_STATE_ENTRY, data: malformed }],
				SESSION,
			),
		/Duplicate goal id/,
	);
	assert.deepEqual(store.snapshot(), before);

	const foreign = copy(before);
	foreign.sessionId = "session-b";
	const ownerStore = new SessionGoalStore(
		() => {},
		() => NOW,
		() => "owner",
	);
	ownerStore.restore(
		[{ type: "custom", customType: NATIVE_STATE_ENTRY, data: foreign }],
		SESSION,
	);
	assert.equal(ownerStore.snapshot().goals.length, 0);
	assert.equal(ownerStore.get(goal.id), undefined);
});

test("expanded state persists without changing the operation generation", () => {
	const { store } = harness();
	const before = store.snapshot();
	store.toggleExpanded();
	const after = store.snapshot();
	assert.equal(after.expanded, true);
	assert.equal(after.generation, before.generation);
	store.toggleExpanded();
	assert.equal(store.snapshot().expanded, false);
});

test("revising a budget-limited goal requires removing or raising the exhausted budget", () => {
	const { store } = harness();
	const goal = activeGoal(store, proposal({ tokenBudget: 10 }));
	store.charge(10);
	assert.equal(store.get(goal.id)?.status, "budget_limited");
	assert.throws(
		() => store.revise(proposal({ tokenBudget: 10 })),
		/must exceed the 10 tokens already used/,
	);
	store.revise(proposal({ tokenBudget: 50 }));
	assert.equal(store.get(goal.id)?.status, "paused");
	store.revise(proposal());
	assert.equal(store.get(goal.id)?.tokenBudget, undefined);
	assert.equal(store.get(goal.id)?.approved, false);
});
