// ICE adaptation of tmonk/pi-goal-x (MIT), baseline 64c5ace87f3400c0b55ef87f2d2912167f53dbaa.
// ICE owns execution. These structural interfaces only consume its versioned extension controllers.
import type { ExtensionContext } from "@zykairotis/ice-coding-agent";

export interface GoalHostSnapshot {
	sessionId: string;
	mode: "plan" | "build";
	trusted: boolean;
	root: string;
	mutationGeneration: number;
	commandHash?: string;
	tools: readonly string[];
	workgraphDispatch: boolean;
}

export interface VerificationReceipt {
	sessionId: string;
	root: string;
	generation: number;
	commandHash?: string;
	status: string;
	exitCode?: number;
}

export interface GoalHost {
	readonly version: 1;
	snapshot(ctx: ExtensionContext): GoalHostSnapshot;
	verify(
		ctx: ExtensionContext,
		options?: { signal?: AbortSignal },
	): Promise<VerificationReceipt>;
}

export interface ReviewResult {
	id: string;
	outcome:
		| "completed"
		| "failed"
		| "cancelled"
		| "interrupted"
		| "budget_exhausted";
	truncated: boolean;
	text: string;
	model?: { provider: string; id: string };
	payload?: Readonly<Record<string, unknown>>;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		cost: number;
	};
}

export interface ReviewerController {
	readonly version: 1;
	start(
		task: {
			agent: string;
			description: string;
			prompt: string;
			scope: { roots: string[] };
			outputSchema: Record<string, unknown>;
			maxTurns: number;
			maxTokens?: number;
			timeoutMs: number;
		},
		options?: { signal?: AbortSignal; onLaunched?: (id: string) => void },
	): Promise<ReviewResult>;
	stop(id: string): Promise<void>;
	openPatches(): ReadonlyArray<{ id: string }>;
}

const HOST_KEY = Symbol.for("ice.goals.host.v1");
const REVIEW_KEY = Symbol.for("ice.subagents.controller.v1");

export function goalHost(events: object): GoalHost {
	const value = (events as Record<symbol, unknown>)[HOST_KEY];
	if (!value || typeof value !== "object")
		throw new Error("ICE Goals requires the native goal host controller.");
	const host = value as Partial<GoalHost>;
	if (
		host.version !== 1 ||
		typeof host.snapshot !== "function" ||
		typeof host.verify !== "function"
	) {
		throw new Error("Unsupported ICE Goals host controller.");
	}
	return host as GoalHost;
}

export function reviewerController(events: object): ReviewerController {
	const value = (events as Record<symbol, unknown>)[REVIEW_KEY];
	if (!value || typeof value !== "object")
		throw new Error("ICE Goals requires native Subagents V2.");
	const controller = value as Partial<ReviewerController>;
	if (
		controller.version !== 1 ||
		typeof controller.start !== "function" ||
		typeof controller.stop !== "function" ||
		typeof controller.openPatches !== "function"
	) {
		throw new Error("Unsupported ICE subagent controller.");
	}
	return controller as ReviewerController;
}

export function requireBuild(
	host: GoalHost,
	ctx: ExtensionContext,
): GoalHostSnapshot {
	const snapshot = host.snapshot(ctx);
	if (
		snapshot.sessionId !== ctx.sessionManager.getSessionId() ||
		!ctx.sessionManager.getSessionFile()
	) {
		throw new Error("ICE Goals requires a current saved session.");
	}
	if (
		snapshot.mode !== "build" ||
		!snapshot.trusted ||
		!ctx.isProjectTrusted()
	) {
		throw new Error("ICE Goals execution requires a trusted build session.");
	}
	return snapshot;
}
