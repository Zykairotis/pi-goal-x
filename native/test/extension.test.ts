import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@zykairotis/ice-coding-agent";
import iceGoals from "../extension.ts";
import type { GoalHost } from "../host.ts";

type Handler = (
	event: Record<string, unknown>,
	ctx: ExtensionContext,
) => unknown;
type Tool = {
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		update: undefined,
		ctx: ExtensionContext,
	) => Promise<unknown>;
};
type Command = {
	handler: (args: string, ctx: ExtensionContext) => Promise<unknown>;
};

function harness(
	options: {
		enabled?: boolean;
		mode?: "plan" | "build";
		trusted?: boolean;
		hasUI?: boolean;
		approved?: boolean;
		workgraph?: boolean;
	} = {},
) {
	const entries: unknown[] = [];
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	const sent: Array<{
		message: { customType: string; details?: unknown };
		options: unknown;
	}> = [];
	const state = {
		mode: options.mode ?? "build",
		trusted: options.trusted ?? true,
		aborts: 0,
		confirm: options.approved ?? true,
		idle: true,
		pending: false,
		lastWidget: [] as string[],
	};
	const events: Record<symbol, unknown> = {};
	const host: GoalHost = {
		version: 1,
		snapshot: () => ({
			sessionId: "session-1",
			mode: state.mode,
			trusted: state.trusted,
			root: "/tmp/workspace",
			mutationGeneration: 0,
			commandHash: "trusted-command",
			tools: [],
			workgraphDispatch: options.workgraph ?? false,
		}),
		verify: async () => {
			throw new Error("Not used by lifecycle tests");
		},
	};
	events[Symbol.for("ice.goals.host.v1")] = host;
	const ctx = {
		mode: options.hasUI === false ? "print" : "tui",
		hasUI: options.hasUI ?? true,
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/tmp/session-1.jsonl",
			getBranch: () => entries,
		},
		isProjectTrusted: () => state.trusted,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		abort: () => {
			state.aborts++;
		},
		ui: {
			confirm: async () => state.confirm,
			notify: () => {},
			setStatus: () => {},
			setWidget: (_name: string, lines?: string[]) => {
				state.lastWidget = lines ?? [];
			},
		},
	} as unknown as ExtensionContext;
	const api = {
		events,
		registerFlag: () => {},
		getFlag: (name: string) =>
			name === "ice-goals" ? options.enabled !== false : false,
		appendEntry: (customType: string, data: unknown) =>
			entries.push({ type: "custom", customType, data: structuredClone(data) }),
		registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: Command) =>
			commands.set(name, command),
		on: (name: string, handler: Handler) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		sendMessage: (
			message: { customType: string; details?: unknown },
			sendOptions: unknown,
		) => sent.push({ message, options: sendOptions }),
		setActiveTools: () => {
			throw new Error("Goals must not widen host tools");
		},
	} as unknown as ExtensionAPI;
	iceGoals(api);
	const emit = async (name: string, event: Record<string, unknown> = {}) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? [])
			result = await handler(event, ctx);
		return result;
	};
	const command = async (name: string, args = "") => {
		const value = commands.get(name);
		assert.ok(value);
		return value.handler(args, ctx);
	};
	const tool = async (name: string, params: Record<string, unknown> = {}) => {
		const value = tools.get(name);
		assert.ok(value);
		return value.execute(
			"tool-1",
			params,
			new AbortController().signal,
			undefined,
			ctx,
		);
	};
	const proposal = {
		objective: "Build the artifact",
		verificationContract: "Configured command verifies the artifact",
		scopeFiles: ["result.txt"],
		maxRuns: 2,
	};
	return {
		entries,
		sent,
		state,
		emit,
		command,
		tool,
		proposal,
		tools,
		commands,
	};
}

test("goal remains opt-in and never widens the host tool set", async () => {
	const h = harness({ enabled: false });
	await h.emit("session_start");
	assert.equal(h.tools.size, 0);
	assert.equal(h.commands.size, 0);
	assert.equal(h.sent.length, 0);
	assert.equal(h.entries.length, 0);
});

test("plan-mode drafting cannot approve or continue execution", async () => {
	const h = harness({ mode: "plan" });
	await h.emit("session_start");
	await h.command("goal", "create artifact");
	await h.tool("propose_goal_draft", h.proposal);
	await assert.rejects(h.command("goal-approve"), /trusted build/);
	await assert.rejects(h.command("goal-resume"), /trusted build/);
	await h.emit("agent_settled");
	assert.equal(
		h.sent.filter((item) => item.message.customType === "ice-goals-checkpoint")
			.length,
		0,
	);
});

test("headless approval fails closed without startup authorization", async () => {
	const h = harness({ hasUI: false });
	await h.emit("session_start");
	await h.command("goal", "create artifact");
	await h.tool("propose_goal_draft", h.proposal);
	await h.command("goal-approve");
	await assert.rejects(h.command("goal-resume"), /approved/);
});

test("bounded goal continuation pauses on user input and rejects its stale checkpoint", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.command("goal", "create artifact");
	await h.tool("propose_goal_draft", h.proposal);
	await h.command("goal-approve");
	await h.command("goal-resume");
	const checkpoint = h.sent.find(
		(item) => item.message.customType === "ice-goals-checkpoint",
	);
	assert.ok(checkpoint);
	await h.emit("input", { source: "interactive", text: "different work" });
	await h.emit("message_start", {
		message: {
			role: "custom",
			customType: "ice-goals-checkpoint",
			details: checkpoint.message.details,
		},
	});
	assert.equal(h.state.aborts, 1);
	const count = h.sent.length;
	await h.emit("agent_settled");
	assert.equal(h.sent.length, count);
});

test("native custom checkpoints consume their token and inject only request-local goal context", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.command("goal", "create artifact");
	await h.tool("propose_goal_draft", h.proposal);
	await h.command("goal-approve");
	await h.command("goal-resume");
	const checkpoint = h.sent.find(
		(item) => item.message.customType === "ice-goals-checkpoint",
	);
	assert.ok(checkpoint);
	await h.emit("agent_start");
	await h.emit("message_start", {
		message: {
			role: "custom",
			customType: "ice-goals-checkpoint",
			details: checkpoint.message.details,
		},
	});
	assert.equal(h.state.aborts, 0);
	const persisted = h.entries.length;
	const context = (await h.emit("context", { messages: [] })) as {
		messages: Array<{ content: string }>;
	};
	assert.match(context.messages[0]!.content, /Build the artifact/);
	assert.equal(h.entries.length, persisted);
	await h.emit("turn_end", {
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheWrite: 2, cacheRead: 100 },
		},
	});
	await h.emit("agent_end");
	await h.emit("agent_settled");
	assert.equal(
		h.sent.filter((item) => item.message.customType === "ice-goals-checkpoint")
			.length,
		2,
	);
});

test("goal widgets cannot emit terminal control sequences from model-authored text", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.command("goal", "draft");
	await h.tool("propose_goal_draft", {
		...h.proposal,
		objective: `Artifact${String.fromCharCode(27)}]52;c;payload${String.fromCharCode(7)}`,
	});
	assert.equal(
		h.state.lastWidget.join("").includes(String.fromCharCode(27)),
		false,
	);
	assert.equal(
		h.state.lastWidget.join("").includes(String.fromCharCode(7)),
		false,
	);
});

test("Workgraph dispatch cannot compete with session-local goal continuation", async () => {
	const h = harness({ workgraph: true });
	await h.emit("session_start");
	await h.command("goal", "create artifact");
	await h.tool("propose_goal_draft", h.proposal);
	await h.command("goal-approve");
	await assert.rejects(h.command("goal-resume"), /Workgraph/);
});

test("clearing a goal needs confirmation and never claims completion", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.command("goal", "draft");
	await h.tool("propose_goal_draft", h.proposal);
	const count = h.entries.length;
	h.state.confirm = false;
	await h.command("goal-clear");
	assert.equal(h.entries.length, count);
	h.state.confirm = true;
	await h.command("goal-clear");
	const result = (await h.tool("get_goal")) as {
		content: Array<{ text: string }>;
	};
	assert.equal(result.content[0]!.text, "null");
});

test("resume is explicit after restoring a saved active goal", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.command("goal", "create artifact");
	await h.tool("propose_goal_draft", h.proposal);
	await h.command("goal-approve");
	await h.command("goal-resume");
	const count = h.sent.length;
	await h.emit("session_start");
	await h.emit("agent_settled");
	assert.equal(h.sent.length, count);
	assert.match(h.state.lastWidget.join("\n"), /paused/);
});

test("null token budget and run allowance mean unset, not a model-invented cap", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.command("goal", "create artifact");
	const result = (await h.tool("propose_goal_draft", {
		...h.proposal,
		tokenBudget: null,
		maxRuns: null,
	})) as { details: { goal: { tokenBudget?: number; maxRuns: number } } };
	assert.equal(result.details.goal.tokenBudget, undefined);
	assert.equal(result.details.goal.maxRuns, 20);
});
