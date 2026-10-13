import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionGoalStore, type NativeSnapshot } from "../state.ts";

function harness() {
	let id = 0;
	const entries: unknown[] = [];
	const store = new SessionGoalStore(
		(customType, data: NativeSnapshot) =>
			entries.push({ type: "custom", customType, data: structuredClone(data) }),
		() => 1,
		() => `goal-${++id}`,
	);
	store.restore([], "owner");
	const propose = (objective = "Goal", tokenBudget?: number) =>
		store.propose({
			objective,
			verificationContract: "Run approved verification",
			scopeFiles: ["result.txt"],
			...(tokenBudget === undefined ? {} : { tokenBudget }),
		});
	const activate = (objective = "Goal", tokenBudget?: number) => {
		const goal = propose(objective, tokenBudget);
		store.approve(goal.id, "command", "/workspace");
		store.resume();
		return goal;
	};
	return { store, entries, propose, activate };
}

test("a checkpoint is consumed exactly once and allows review in its own work run", () => {
	const h = harness();
	const goal = h.activate();
	assert.equal(h.store.focused()?.id, goal.id);
	const checkpoint = h.store.claimContinuation();
	assert.ok(checkpoint);
	h.store.consumeContinuation(checkpoint);
	assert.throws(() => h.store.consumeContinuation(checkpoint), /stale/);
	const review = h.store.beginReview();
	assert.equal(h.store.isCurrent(review), true);
	h.store.charge(5);
	assert.equal(h.store.isCurrent(review), true);
});

test("the third review can pass, but an interrupted review consumes an attempt", () => {
	const h = harness();
	const goal = h.activate();
	for (let i = 0; i < 2; i++) {
		const review = h.store.beginReview();
		h.store.failedReview(review, "Not satisfied");
	}
	const final = h.store.beginReview();
	assert.equal(h.store.focused()?.reviewAttempts, 3);
	h.store.charge(1);
	h.store.complete(final, {
		criteriaHash: goal.criteriaHash,
		commandHash: "command",
		sessionId: "owner",
		root: "/workspace",
		workspaceHash: "hash",
		status: "passed",
	});
	h.store.charge(2);
	assert.equal(h.store.focused()?.status, "complete");
	assert.equal(h.store.focused()?.usage.tokensUsed, 3);
});

test("review usage remains charged to its original goal after a focus switch", () => {
	const h = harness();
	const first = h.activate("First");
	h.store.beginReview();
	h.store.pause("User switched focus");
	const second = h.activate("Second");
	h.store.charge(7, first.id);
	assert.equal(h.store.get(first.id)?.usage.tokensUsed, 7);
	assert.equal(h.store.get(second.id)?.usage.tokensUsed, 0);
});

test("restored unaccounted review usage blocks capped resume and retains its child reference", () => {
	const h = harness();
	const goal = h.activate("Capped", 100);
	const review = h.store.beginReview();
	h.store.recordReviewChild(review, "ag_child");
	const restored = new SessionGoalStore(() => {});
	restored.restore(h.entries, "owner");
	assert.equal(restored.get(goal.id)?.reviewChildId, "ag_child");
	assert.equal(restored.get(goal.id)?.usageKnown, false);
	assert.equal(restored.get(goal.id)?.status, "paused");
	assert.throws(() => restored.resume(), /unknown usage/);
});

test("unknown uncapped review usage preserves its failure decision and exhausts the finite allowance", () => {
	const h = harness();
	h.activate();
	for (let i = 0; i < 3; i++) {
		const review = h.store.beginReview();
		h.store.charge(undefined);
		h.store.failedReview(review, "Review interrupted");
	}
	assert.equal(h.store.focused()?.status, "paused");
	assert.throws(() => h.store.resume(), /allowance/);
});

test("proposals reject protected evidence, empty scope and excessive run allowance", () => {
	const h = harness();
	for (const scopeFiles of [
		[],
		["oauth.json"],
		["auth.json"],
		["credentials.json"],
		[".ice/file"],
		[".env.local"],
	]) {
		assert.throws(() =>
			h.store.propose({
				objective: "Goal",
				verificationContract: "Verify",
				scopeFiles,
			}),
		);
	}
	assert.throws(() =>
		h.store.propose({
			objective: "Goal",
			verificationContract: "Verify",
			scopeFiles: ["file"],
			maxRuns: 101,
		}),
	);
});
