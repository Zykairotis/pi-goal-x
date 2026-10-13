import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@zykairotis/ice-coding-agent";
import { requestCompletion } from "../completion.ts";
import type {
	GoalHost,
	ReviewResult,
	ReviewerController,
	VerificationReceipt,
} from "../host.ts";
import { SessionGoalStore } from "../state.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "ice-goal-complete-"));
	await writeFile(join(root, "result.txt"), "actual artifact");
	const entries: unknown[] = [];
	const store = new SessionGoalStore(
		(_type, data) => entries.push(structuredClone(data)),
		() => 1,
		() => "goal-1",
	);
	store.restore([], "session-1");
	const proposed = store.propose({
		objective: "Produce the artifact",
		verificationContract: "Configured verifier checks result.txt contents",
		scopeFiles: ["result.txt"],
	});
	store.approve(proposed.id, "configured-command", root);
	store.resume();
	const ctx = {
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/tmp/session-1.jsonl",
		},
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
	const state = {
		mode: "build" as "plan" | "build",
		commandHash: "configured-command",
		generation: 0,
		verifyCalls: 0,
		reviewCalls: 0,
		lastPrompt: "",
		open: false,
	};
	let review: ReviewResult = {
		id: "child-1",
		outcome: "completed",
		truncated: false,
		text: "",
		payload: {
			approved: true,
			criteriaHash: proposed.criteriaHash,
			summary: "Artifact inspected against the approved criteria.",
			evidencePaths: ["result.txt"],
		},
		usage: {
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: 0,
		},
	};
	let verifier: VerificationReceipt = {
		sessionId: "session-1",
		root,
		generation: 0,
		commandHash: state.commandHash,
		status: "passed",
		exitCode: 0,
	};
	let afterReview: (() => Promise<void>) | undefined;
	let afterVerify: (() => Promise<void>) | undefined;
	const host: GoalHost = {
		version: 1,
		snapshot: () => ({
			sessionId: "session-1",
			mode: state.mode,
			trusted: true,
			root,
			mutationGeneration: state.generation,
			commandHash: state.commandHash,
			tools: [],
			workgraphDispatch: false,
		}),
		verify: async () => {
			state.verifyCalls++;
			await afterVerify?.();
			return verifier;
		},
	};
	const reviewer: ReviewerController = {
		version: 1,
		start: async (task, options) => {
			assert.equal(task.agent, "ice-goal-review");
			state.reviewCalls++;
			state.lastPrompt = task.prompt;
			options?.onLaunched?.("child-1");
			await afterReview?.();
			return review;
		},
		stop: async () => {},
		openPatches: () => (state.open ? [{ id: "unapplied-child" }] : []),
	};
	const events = {
		[Symbol.for("ice.goals.host.v1")]: host,
		[Symbol.for("ice.subagents.controller.v1")]: reviewer,
	};
	return {
		root,
		store,
		ctx,
		state,
		events,
		setReview(value: Partial<ReviewResult>) {
			review = { ...review, ...value };
		},
		setVerifier(value: Partial<VerificationReceipt>) {
			verifier = { ...verifier, ...value };
		},
		onReview(fn: () => Promise<void>) {
			afterReview = fn;
		},
		onVerify(fn: () => Promise<void>) {
			afterVerify = fn;
		},
		close: () => rm(root, { recursive: true, force: true }),
	};
}

test("completion requires independent evidence plus fresh host verification and charges review", async () => {
	const f = await fixture();
	try {
		const result = await requestCompletion(
			f.store,
			f.events,
			f.ctx,
			new AbortController().signal,
		);
		assert.equal(result.completed, true);
		assert.equal(f.store.focused()?.status, "complete");
		assert.equal(f.store.focused()?.usage.tokensUsed, 15);
		assert.equal(f.state.verifyCalls, 1);
	} finally {
		await f.close();
	}
});

for (const [name, patch] of [
	["model rejection", { payload: { approved: false } }],
	["missing payload", { payload: undefined }],
	["truncated report", { truncated: true }],
	["interrupted child", { outcome: "interrupted" }],
	[
		"wrong criterion hash",
		{
			payload: {
				approved: true,
				criteriaHash: "wrong",
				summary: "claim",
				evidencePaths: ["result.txt"],
			},
		},
	],
] as const) {
	test(`completion rejects ${name} and still charges observed reviewer usage`, async () => {
		const f = await fixture();
		try {
			f.setReview(patch);
			const result = await requestCompletion(
				f.store,
				f.events,
				f.ctx,
				new AbortController().signal,
			);
			assert.equal(result.completed, false);
			assert.notEqual(f.store.focused()?.status, "complete");
			assert.equal(f.store.focused()?.usage.tokensUsed, 15);
			assert.equal(f.state.verifyCalls, 1);
		} finally {
			await f.close();
		}
	});
}

for (const [name, patch] of [
	["failed command", { status: "failed", exitCode: 1 }],
	["wrong workspace", { root: "/other/workspace" }],
	["wrong command", { commandHash: "other-command" }],
	["wrong session", { sessionId: "other-session" }],
	["stale mutation generation", { generation: 1 }],
] as const) {
	test(`completion rejects ${name}`, async () => {
		const f = await fixture();
		try {
			f.setVerifier(patch);
			const result = await requestCompletion(
				f.store,
				f.events,
				f.ctx,
				new AbortController().signal,
			);
			assert.equal(result.completed, false);
			assert.notEqual(f.store.focused()?.status, "complete");
			assert.equal(f.state.reviewCalls, 0);
		} finally {
			await f.close();
		}
	});
}

test("workspace changes during verification invalidate an otherwise passing receipt", async () => {
	const f = await fixture();
	try {
		f.onVerify(() =>
			writeFile(join(f.root, "result.txt"), "changed after review"),
		);
		const result = await requestCompletion(
			f.store,
			f.events,
			f.ctx,
			new AbortController().signal,
		);
		assert.equal(result.completed, false);
		assert.match(result.summary, /stale/);
	} finally {
		await f.close();
	}
});

test("a focus/pause change during review prevents its result from completing", async () => {
	const f = await fixture();
	try {
		f.onReview(async () => {
			f.store.pause("User paused while reviewing");
		});
		const result = await requestCompletion(
			f.store,
			f.events,
			f.ctx,
			new AbortController().signal,
		);
		assert.equal(result.completed, false);
		assert.equal(f.store.focused()?.status, "paused");
		assert.equal(f.state.verifyCalls, 1);
	} finally {
		await f.close();
	}
});

test("completion rejects a verifier configuration changed after user approval", async () => {
	const f = await fixture();
	try {
		f.state.commandHash = "replacement-command";
		await assert.rejects(
			requestCompletion(f.store, f.events, f.ctx, new AbortController().signal),
			/since approval/,
		);
		assert.equal(f.state.verifyCalls, 0);
	} finally {
		await f.close();
	}
});

test("review cache writes count against the goal budget while cache reads do not", async () => {
	const f = await fixture();
	try {
		const goal = f.store.focused()!;
		f.store.revise({
			objective: goal.objective,
			verificationContract: goal.verificationContract!,
			scopeFiles: goal.scopeFiles,
			tokenBudget: 16,
		});
		f.store.approve(goal.id, "configured-command", f.root);
		f.store.resume();
		f.setReview({
			usage: {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 1000,
				cacheWriteTokens: 1,
				cost: 0,
			},
		});
		const result = await requestCompletion(
			f.store,
			f.events,
			f.ctx,
			new AbortController().signal,
		);
		assert.equal(result.completed, false);
		assert.equal(f.store.focused()?.usage.tokensUsed, 16);
		assert.equal(f.store.focused()?.status, "budget_limited");
		assert.equal(f.state.verifyCalls, 1);
	} finally {
		await f.close();
	}
});

test("completion rejects plan mode, no verifier, open patches and already-aborted signals", async () => {
	const f = await fixture();
	try {
		f.state.mode = "plan";
		await assert.rejects(
			requestCompletion(f.store, f.events, f.ctx, new AbortController().signal),
			/trusted build/,
		);
		f.state.mode = "build";
		f.state.commandHash = "";
		await assert.rejects(
			requestCompletion(f.store, f.events, f.ctx, new AbortController().signal),
			/verifier/,
		);
		f.state.commandHash = "configured-command";
		f.state.open = true;
		await assert.rejects(
			requestCompletion(f.store, f.events, f.ctx, new AbortController().signal),
			/patches/,
		);
		f.state.open = false;
		const abort = new AbortController();
		abort.abort();
		await assert.rejects(
			requestCompletion(f.store, f.events, f.ctx, abort.signal),
			/cancelled/,
		);
	} finally {
		await f.close();
	}
});

test("the reviewer receives the host verifier receipt before judging criteria", async () => {
	const f = await fixture();
	try {
		const result = await requestCompletion(
			f.store,
			f.events,
			f.ctx,
			new AbortController().signal,
		);
		assert.equal(result.completed, true);
		assert.match(
			f.state.lastPrompt,
			/"hostVerification":\{"status":"passed","exitCode":0,"commandHash":"configured-command"\}/,
		);
	} finally {
		await f.close();
	}
});

test("review evidence may list extra inspected files but must cover every approved path", async () => {
	const f = await fixture();
	try {
		const goal = f.store.focused()!;
		f.setReview({
			payload: {
				approved: true,
				criteriaHash: goal.criteriaHash,
				summary: "Inspected the artifact and its verifier.",
				evidencePaths: ["result.txt", "verify.mjs"],
			},
		});
		const extra = await requestCompletion(
			f.store,
			f.events,
			f.ctx,
			new AbortController().signal,
		);
		assert.equal(extra.completed, true);
	} finally {
		await f.close();
	}
	const g = await fixture();
	try {
		const goal = g.store.focused()!;
		g.setReview({
			payload: {
				approved: true,
				criteriaHash: goal.criteriaHash,
				summary: "Inspected only the verifier.",
				evidencePaths: ["verify.mjs"],
			},
		});
		const missing = await requestCompletion(
			g.store,
			g.events,
			g.ctx,
			new AbortController().signal,
		);
		assert.equal(missing.completed, false);
		assert.match(missing.summary, /Independent review/);
	} finally {
		await g.close();
	}
});

test("workspace changes during review invalidate an earlier passing verifier receipt", async () => {
	const f = await fixture();
	try {
		f.onReview(() => writeFile(join(f.root, "result.txt"), "changed in review"));
		const result = await requestCompletion(
			f.store,
			f.events,
			f.ctx,
			new AbortController().signal,
		);
		assert.equal(result.completed, false);
		assert.match(result.summary, /changed during review/);
		assert.equal(f.state.verifyCalls, 1);
	} finally {
		await f.close();
	}
});
