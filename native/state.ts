import { createHash, randomUUID } from "node:crypto";
import type {
	GoalRecord,
	GoalTask,
	GoalTaskList,
} from "../extensions/goal-record.ts";

export const NATIVE_STATE_ENTRY = "ice-goals-state";
export const DEFAULT_MAX_RUNS = 20;
export const MAX_GOALS = 20;
export const MAX_TASKS = 50;
export const MAX_TASK_DEPTH = 3;
export const MAX_OBJECTIVE_LENGTH = 4000;
export const MAX_CONTRACT_LENGTH = 4000;
export const MAX_EVIDENCE_LENGTH = 2000;
export const MAX_SNAPSHOT_BYTES = 128 * 1024;
export const MAX_REVIEW_ATTEMPTS = 3;
export const MAX_RUNS = 100;

const MAX_ID_LENGTH = 256;
const MAX_SCOPE_FILES = 50;
const MAX_SCOPE_FILE_LENGTH = 1000;
const MAX_TASK_ID_LENGTH = 256;
const MAX_TASK_TITLE_LENGTH = 2000;
const MAX_TIMESTAMP_LENGTH = 128;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_RECEIPT_HASH_LENGTH = 256;
const MAX_ROOT_LENGTH = 4000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const RESTORE_PAUSE_REASON =
	"Restored goal is paused until explicitly resumed.";
const RUNS_EXHAUSTED_REASON = "Continuation run allowance exhausted.";
const UNKNOWN_USAGE_REASON = "Token usage is unknown; capped goals are paused.";
const TOKEN_BUDGET_REASON = "Token budget exhausted.";
const PROTECTED_SCOPE_SEGMENTS = new Set([
	".git",
	".ice",
	".pi",
	"node_modules",
	".env",
	"auth",
	"oauth",
	"credentials",
	"service-account",
]);

export interface NativeCompletionReceipt {
	criteriaHash: string;
	sessionId: string;
	root: string;
	commandHash: string;
	status: "passed";
	workspaceHash: string;
}

export interface NativeGoal extends GoalRecord {
	criteriaHash: string;
	scopeFiles: string[];
	approved: boolean;
	approvedCommandHash?: string;
	approvedRoot?: string;
	maxRuns: number;
	runsUsed: number;
	reviewAttempts: number;
	usageKnown: boolean;
	pendingReviewUsage?: true;
	reviewChildId?: string;
	receipt?: NativeCompletionReceipt;
}

export interface NativeSnapshot {
	version: 1;
	sessionId: string;
	goals: NativeGoal[];
	focusedGoalId: string | null;
	generation: number;
	expanded: boolean;
}

export interface GoalOperationToken {
	goalId: string;
	generation: number;
	criteriaHash: string;
}

export interface NativeGoalProposal {
	objective: string;
	verificationContract: string;
	scopeFiles: string[];
	tasks?: GoalTask[];
	tokenBudget?: number;
	maxRuns?: number;
	sisyphus?: boolean;
}

type AppendState = (customType: string, data: NativeSnapshot) => void;
type OperationKind = "continuation" | "review";

interface PendingOperation {
	token: GoalOperationToken;
	kind: OperationKind;
}

interface MutableState {
	sessionId: string;
	goals: Map<string, NativeGoal>;
	focusedGoalId: string | null;
	generation: number;
	expanded: boolean;
}

interface PreparedProposal {
	objective: string;
	verificationContract: string;
	scopeFiles: string[];
	tasks?: GoalTask[];
	tokenBudget?: number;
	maxRuns: number;
	sisyphus: boolean;
}

interface TaskValidation {
	tasks: GoalTask[];
	count: number;
}

interface StructuralTask {
	id: string;
	title: string;
	verificationContract: string | null;
	lightweightSubtasks: boolean | null;
	subtasks: StructuralTask[];
}

const NATIVE_GOAL_KEYS = [
	"id",
	"objective",
	"status",
	"autoContinue",
	"usage",
	"sisyphus",
	"createdAt",
	"updatedAt",
	"pauseReason",
	"tokenBudget",
	"taskList",
	"verificationContract",
	"criteriaHash",
	"scopeFiles",
	"approved",
	"approvedCommandHash",
	"approvedRoot",
	"maxRuns",
	"runsUsed",
	"reviewAttempts",
	"usageKnown",
	"pendingReviewUsage",
	"reviewChildId",
	"receipt",
] as const;
const SNAPSHOT_KEYS = [
	"version",
	"sessionId",
	"goals",
	"focusedGoalId",
	"generation",
	"expanded",
] as const;
const TASK_KEYS = [
	"id",
	"title",
	"status",
	"completedAt",
	"skippedAt",
	"evidence",
	"skipReason",
	"verificationContract",
	"lightweightSubtasks",
	"subtasks",
] as const;
const TASK_LIST_KEYS = ["tasks", "blockCompletion", "proposedAt"] as const;
const RECEIPT_KEYS = [
	"criteriaHash",
	"sessionId",
	"root",
	"commandHash",
	"status",
	"workspaceHash",
] as const;
const PROPOSAL_KEYS = [
	"objective",
	"verificationContract",
	"scopeFiles",
	"tasks",
	"tokenBudget",
	"maxRuns",
	"sisyphus",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
	throw new Error(message);
}

function assertExactKeys(
	record: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(record)) {
		if (!allowedSet.has(key))
			fail(`${label} contains unsupported field "${key}".`);
	}
}

function boundedString(
	value: unknown,
	label: string,
	maximum: number,
	nonEmpty = true,
): string {
	if (typeof value !== "string") fail(`${label} must be a string.`);
	if (value.length > maximum)
		fail(`${label} exceeds its ${maximum}-character bound.`);
	if (nonEmpty && value.trim().length === 0)
		fail(`${label} must not be empty.`);
	return value;
}

function exactIdentifier(
	value: unknown,
	label: string,
	maximum: number,
): string {
	const result = boundedString(value, label, maximum);
	if (result !== result.trim())
		fail(`${label} must not have leading or trailing whitespace.`);
	return result;
}

function safeInteger(
	value: unknown,
	label: string,
	minimum: number,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	) {
		fail(`${label} must be a safe integer between ${minimum} and ${maximum}.`);
	}
	return value;
}

function optionalString(
	record: Record<string, unknown>,
	key: string,
	label: string,
	maximum: number,
): string | undefined {
	if (!(key in record) || record[key] === undefined) return undefined;
	return boundedString(record[key], label, maximum);
}

function optionalSafeInteger(
	record: Record<string, unknown>,
	key: string,
	label: string,
	minimum: number,
	maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
	if (!(key in record) || record[key] === undefined) return undefined;
	return safeInteger(record[key], label, minimum, maximum);
}

function validateSessionId(value: unknown, allowEmpty = false): string {
	if (typeof value !== "string") fail("sessionId must be a string.");
	if (value.length > MAX_SESSION_ID_LENGTH)
		fail(`sessionId exceeds its ${MAX_SESSION_ID_LENGTH}-character bound.`);
	if (!allowEmpty && value.trim().length === 0)
		fail("sessionId must not be empty.");
	if (value !== value.trim())
		fail("sessionId must not have leading or trailing whitespace.");
	return value;
}

function validateHash(value: unknown, label: string): string {
	const hash = boundedString(value, label, MAX_RECEIPT_HASH_LENGTH);
	if (!HASH_PATTERN.test(hash))
		fail(`${label} must be a lowercase SHA-256 hex digest.`);
	return hash;
}

function validateScopeFiles(value: unknown, label = "scopeFiles"): string[] {
	if (!Array.isArray(value)) fail(`${label} must be an array.`);
	if (value.length < 1) fail(`${label} must contain at least one file.`);
	if (value.length > MAX_SCOPE_FILES)
		fail(`${label} cannot contain more than ${MAX_SCOPE_FILES} files.`);
	const result: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		const path = exactIdentifier(item, `${label} entry`, MAX_SCOPE_FILE_LENGTH);
		if (path.includes("\0")) fail(`${label} cannot contain NUL bytes.`);
		if (
			path.startsWith("/") ||
			path.startsWith("\\") ||
			/^[A-Za-z]:/.test(path)
		) {
			fail(`${label} entries must be relative paths.`);
		}
		const segments = path.split(/[\\/]/);
		if (
			segments.some(
				(segment) =>
					segment.length === 0 || segment === "." || segment === "..",
			)
		) {
			fail(
				`${label} entries must not contain traversal or empty path segments.`,
			);
		}
		if (
			segments.some((segment) => {
				const lower = segment.toLowerCase();
				return (
					PROTECTED_SCOPE_SEGMENTS.has(lower) ||
					lower.startsWith(".env.") ||
					lower.startsWith("auth.") ||
					lower.startsWith("oauth.") ||
					lower.startsWith("service-account.") ||
					lower.startsWith("credentials.")
				);
			})
		) {
			fail(`${label} contains a protected path.`);
		}
		if (seen.has(path)) fail(`${label} contains duplicate path "${path}".`);
		seen.add(path);
		result.push(path);
	}
	return result;
}

function cloneTask(task: GoalTask): GoalTask {
	const result: GoalTask = {
		id: task.id,
		title: task.title,
		status: task.status,
	};
	if (task.completedAt !== undefined) result.completedAt = task.completedAt;
	if (task.skippedAt !== undefined) result.skippedAt = task.skippedAt;
	if (task.evidence !== undefined) result.evidence = task.evidence;
	if (task.skipReason !== undefined) result.skipReason = task.skipReason;
	if (task.verificationContract !== undefined)
		result.verificationContract = task.verificationContract;
	if (task.lightweightSubtasks !== undefined)
		result.lightweightSubtasks = task.lightweightSubtasks;
	if (task.subtasks !== undefined)
		result.subtasks = task.subtasks.map(cloneTask);
	return result;
}

function cloneTaskList(taskList: GoalTaskList): GoalTaskList {
	return {
		tasks: taskList.tasks.map(cloneTask),
		blockCompletion: taskList.blockCompletion,
		proposedAt: taskList.proposedAt,
	};
}

function cloneReceipt(
	receipt: NativeCompletionReceipt,
): NativeCompletionReceipt {
	return {
		criteriaHash: receipt.criteriaHash,
		sessionId: receipt.sessionId,
		root: receipt.root,
		commandHash: receipt.commandHash,
		status: receipt.status,
		workspaceHash: receipt.workspaceHash,
	};
}

function cloneNativeGoal(goal: NativeGoal): NativeGoal {
	const result: NativeGoal = {
		id: goal.id,
		objective: goal.objective,
		status: goal.status,
		autoContinue: goal.autoContinue,
		usage: {
			tokensUsed: goal.usage.tokensUsed,
			activeSeconds: goal.usage.activeSeconds,
		},
		sisyphus: goal.sisyphus,
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
		verificationContract: goal.verificationContract,
		criteriaHash: goal.criteriaHash,
		scopeFiles: [...goal.scopeFiles],
		approved: goal.approved,
		maxRuns: goal.maxRuns,
		runsUsed: goal.runsUsed,
		reviewAttempts: goal.reviewAttempts,
		usageKnown: goal.usageKnown,
	};
	if (goal.approvedCommandHash !== undefined)
		result.approvedCommandHash = goal.approvedCommandHash;
	if (goal.approvedRoot !== undefined) result.approvedRoot = goal.approvedRoot;
	if (goal.pauseReason !== undefined) result.pauseReason = goal.pauseReason;
	if (goal.tokenBudget !== undefined) result.tokenBudget = goal.tokenBudget;
	if (goal.taskList !== undefined)
		result.taskList = cloneTaskList(goal.taskList);
	if (goal.receipt !== undefined) result.receipt = cloneReceipt(goal.receipt);
	if (goal.pendingReviewUsage === true) result.pendingReviewUsage = true;
	if (goal.reviewChildId !== undefined)
		result.reviewChildId = goal.reviewChildId;
	return result;
}

function cloneSnapshot(snapshot: NativeSnapshot): NativeSnapshot {
	return {
		version: 1,
		sessionId: snapshot.sessionId,
		goals: snapshot.goals.map(cloneNativeGoal),
		focusedGoalId: snapshot.focusedGoalId,
		generation: snapshot.generation,
		expanded: snapshot.expanded,
	};
}

function structuralTasks(tasks: readonly GoalTask[]): StructuralTask[] {
	return tasks.map((task) => ({
		id: task.id,
		title: task.title,
		verificationContract: task.verificationContract ?? null,
		lightweightSubtasks:
			task.lightweightSubtasks === undefined ? null : task.lightweightSubtasks,
		subtasks: task.subtasks === undefined ? [] : structuralTasks(task.subtasks),
	}));
}

function criteriaHashForValues(
	objective: string,
	verificationContract: string,
	scopeFiles: readonly string[],
	tasks: readonly GoalTask[],
	blockCompletion: boolean | null,
): string {
	const canonical = JSON.stringify({
		objective,
		verificationContract,
		scopeFiles: [...scopeFiles],
		blockCompletion,
		tasks: structuralTasks(tasks),
	});
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function criteriaHashForGoal(
	goal: Pick<
		NativeGoal,
		"objective" | "verificationContract" | "scopeFiles" | "taskList"
	>,
): string {
	return criteriaHashForValues(
		goal.objective,
		goal.verificationContract ?? fail("Goal verificationContract is missing."),
		goal.scopeFiles,
		goal.taskList?.tasks ?? [],
		goal.taskList?.blockCompletion ?? null,
	);
}

function validateTaskTree(value: unknown, label: string): TaskValidation {
	if (!Array.isArray(value)) fail(`${label} must be an array.`);
	if (value.length > MAX_TASKS)
		fail(`${label} cannot contain more than ${MAX_TASKS} tasks.`);
	const ids = new Set<string>();
	let count = 0;

	function walk(list: unknown[], depth: number): GoalTask[] {
		if (depth > MAX_TASK_DEPTH)
			fail(`${label} exceeds maximum task depth ${MAX_TASK_DEPTH}.`);
		const output: GoalTask[] = [];
		for (const item of list) {
			if (!isRecord(item)) fail(`${label} contains a non-object task.`);
			assertExactKeys(item, TASK_KEYS, "Task");
			count += 1;
			if (count > MAX_TASKS)
				fail(`${label} cannot contain more than ${MAX_TASKS} tasks.`);
			const id = exactIdentifier(item.id, "Task id", MAX_TASK_ID_LENGTH);
			if (ids.has(id)) fail(`Duplicate task id "${id}".`);
			ids.add(id);
			const title = boundedString(
				item.title,
				`Task "${id}" title`,
				MAX_TASK_TITLE_LENGTH,
			);
			const status = item.status;
			if (
				status !== "pending" &&
				status !== "complete" &&
				status !== "skipped"
			) {
				fail(`Task "${id}" has an invalid status.`);
			}
			const completedAt = optionalString(
				item,
				"completedAt",
				`Task "${id}" completedAt`,
				MAX_TIMESTAMP_LENGTH,
			);
			const skippedAt = optionalString(
				item,
				"skippedAt",
				`Task "${id}" skippedAt`,
				MAX_TIMESTAMP_LENGTH,
			);
			const evidence = optionalString(
				item,
				"evidence",
				`Task "${id}" evidence`,
				MAX_EVIDENCE_LENGTH,
			);
			const skipReason = optionalString(
				item,
				"skipReason",
				`Task "${id}" skipReason`,
				MAX_EVIDENCE_LENGTH,
			);
			const verificationContract = optionalString(
				item,
				"verificationContract",
				`Task "${id}" verificationContract`,
				MAX_CONTRACT_LENGTH,
			);
			let lightweightSubtasks: boolean | undefined;
			if (item.lightweightSubtasks !== undefined) {
				if (typeof item.lightweightSubtasks !== "boolean")
					fail(`Task "${id}" lightweightSubtasks must be boolean.`);
				lightweightSubtasks = item.lightweightSubtasks;
			}
			let subtasks: GoalTask[] | undefined;
			if (item.subtasks !== undefined) {
				if (!Array.isArray(item.subtasks) || item.subtasks.length === 0)
					fail(`Task "${id}" subtasks must be a non-empty array.`);
				subtasks = walk(item.subtasks, depth + 1);
			}
			if (lightweightSubtasks === true && subtasks === undefined) {
				fail(
					`Task "${id}" cannot enable lightweightSubtasks without subtasks.`,
				);
			}
			if (
				status === "pending" &&
				(completedAt !== undefined ||
					skippedAt !== undefined ||
					evidence !== undefined ||
					skipReason !== undefined)
			) {
				fail(
					`Pending task "${id}" cannot contain completion or skip progress.`,
				);
			}
			if (
				status === "complete" &&
				(skippedAt !== undefined || skipReason !== undefined)
			) {
				fail(`Complete task "${id}" cannot contain skip progress.`);
			}
			if (
				status === "complete" &&
				verificationContract !== undefined &&
				evidence === undefined
			) {
				fail(
					`Complete task "${id}" requires evidence for its verification contract.`,
				);
			}
			if (status === "skipped" && skipReason === undefined) {
				fail(`Skipped task "${id}" requires an explicit reason.`);
			}
			if (
				status === "skipped" &&
				(completedAt !== undefined || evidence !== undefined)
			) {
				fail(`Skipped task "${id}" cannot contain completion progress.`);
			}
			const task: GoalTask = { id, title, status };
			if (completedAt !== undefined) task.completedAt = completedAt;
			if (skippedAt !== undefined) task.skippedAt = skippedAt;
			if (evidence !== undefined) task.evidence = evidence;
			if (skipReason !== undefined) task.skipReason = skipReason;
			if (verificationContract !== undefined)
				task.verificationContract = verificationContract;
			if (lightweightSubtasks !== undefined)
				task.lightweightSubtasks = lightweightSubtasks;
			if (subtasks !== undefined) task.subtasks = subtasks;
			output.push(task);
		}
		return output;
	}

	return { tasks: walk(value, 0), count };
}

function validateTaskList(value: unknown, label: string): GoalTaskList {
	if (!isRecord(value)) fail(`${label} must be an object.`);
	assertExactKeys(value, TASK_LIST_KEYS, "taskList");
	const tasks = validateTaskTree(value.tasks, `${label}.tasks`);
	if (tasks.count === 0) fail(`${label}.tasks must not be empty.`);
	if (typeof value.blockCompletion !== "boolean")
		fail(`${label}.blockCompletion must be boolean.`);
	const proposedAt = boundedString(
		value.proposedAt,
		`${label}.proposedAt`,
		MAX_TIMESTAMP_LENGTH,
	);
	return {
		tasks: tasks.tasks,
		blockCompletion: value.blockCompletion,
		proposedAt,
	};
}

function validateReceipt(
	value: unknown,
	expectedSessionId: string,
): NativeCompletionReceipt {
	if (!isRecord(value)) fail("receipt must be an object.");
	assertExactKeys(value, RECEIPT_KEYS, "receipt");
	const criteriaHash = validateHash(value.criteriaHash, "receipt.criteriaHash");
	const sessionId = validateSessionId(
		value.sessionId,
		expectedSessionId.length === 0,
	);
	if (sessionId !== expectedSessionId)
		fail("receipt.sessionId does not belong to this session.");
	const root = boundedString(value.root, "receipt.root", MAX_ROOT_LENGTH);
	const commandHash = boundedString(
		value.commandHash,
		"receipt.commandHash",
		MAX_RECEIPT_HASH_LENGTH,
	);
	const workspaceHash = boundedString(
		value.workspaceHash,
		"receipt.workspaceHash",
		MAX_RECEIPT_HASH_LENGTH,
	);
	if (value.status !== "passed") fail("receipt.status must be passed.");
	return {
		criteriaHash,
		sessionId,
		root,
		commandHash,
		status: "passed",
		workspaceHash,
	};
}

function validateNativeGoal(
	value: unknown,
	expectedSessionId: string,
): NativeGoal {
	if (!isRecord(value)) fail("Native goal must be an object.");
	assertExactKeys(value, NATIVE_GOAL_KEYS, "Native goal");
	const id = exactIdentifier(value.id, "Goal id", MAX_ID_LENGTH);
	const objective = boundedString(
		value.objective,
		"Goal objective",
		MAX_OBJECTIVE_LENGTH,
	);
	const status = value.status;
	if (
		status !== "active" &&
		status !== "paused" &&
		status !== "blocked" &&
		status !== "budget_limited" &&
		status !== "complete"
	) {
		fail(`Goal "${id}" has an invalid status.`);
	}
	if (typeof value.autoContinue !== "boolean")
		fail(`Goal "${id}" autoContinue must be boolean.`);
	if (!isRecord(value.usage)) fail(`Goal "${id}" usage must be an object.`);
	assertExactKeys(
		value.usage,
		["tokensUsed", "activeSeconds"],
		`Goal "${id}" usage`,
	);
	const tokensUsed = safeInteger(
		value.usage.tokensUsed,
		`Goal "${id}" usage.tokensUsed`,
		0,
	);
	const activeSeconds = safeInteger(
		value.usage.activeSeconds,
		`Goal "${id}" usage.activeSeconds`,
		0,
	);
	if (typeof value.sisyphus !== "boolean")
		fail(`Goal "${id}" sisyphus must be boolean.`);
	const createdAt = boundedString(
		value.createdAt,
		`Goal "${id}" createdAt`,
		MAX_TIMESTAMP_LENGTH,
	);
	const updatedAt = boundedString(
		value.updatedAt,
		`Goal "${id}" updatedAt`,
		MAX_TIMESTAMP_LENGTH,
	);
	const pauseReason = optionalString(
		value,
		"pauseReason",
		`Goal "${id}" pauseReason`,
		MAX_EVIDENCE_LENGTH,
	);
	const tokenBudget = optionalSafeInteger(
		value,
		"tokenBudget",
		`Goal "${id}" tokenBudget`,
		1,
	);
	const verificationContract = boundedString(
		value.verificationContract,
		`Goal "${id}" verificationContract`,
		MAX_CONTRACT_LENGTH,
	);
	const scopeFiles = validateScopeFiles(
		value.scopeFiles,
		`Goal "${id}" scopeFiles`,
	);
	if (typeof value.approved !== "boolean")
		fail(`Goal "${id}" approved must be boolean.`);
	const approvedCommandHash = optionalString(
		value,
		"approvedCommandHash",
		"approvedCommandHash",
		MAX_RECEIPT_HASH_LENGTH,
	);
	const approvedRoot = optionalString(
		value,
		"approvedRoot",
		"approvedRoot",
		MAX_ROOT_LENGTH,
	);
	if (value.approved && (!approvedCommandHash || !approvedRoot))
		fail("Approved goals require the approved workspace and verifier command.");
	const maxRuns = safeInteger(
		value.maxRuns,
		`Goal "${id}" maxRuns`,
		1,
		MAX_RUNS,
	);
	const runsUsed = safeInteger(
		value.runsUsed,
		`Goal "${id}" runsUsed`,
		0,
		maxRuns,
	);
	const reviewAttempts = safeInteger(
		value.reviewAttempts,
		`Goal "${id}" reviewAttempts`,
		0,
		MAX_REVIEW_ATTEMPTS,
	);
	if (typeof value.usageKnown !== "boolean")
		fail(`Goal "${id}" usageKnown must be boolean.`);
	if (
		value.pendingReviewUsage !== undefined &&
		value.pendingReviewUsage !== true
	)
		fail("pendingReviewUsage must be true when present.");
	if (status === "complete" && value.pendingReviewUsage === true)
		fail("Completed goals cannot retain unaccounted review usage.");
	const reviewChildId = optionalString(
		value,
		"reviewChildId",
		"reviewChildId",
		MAX_ID_LENGTH,
	);
	const taskList =
		value.taskList === undefined
			? undefined
			: validateTaskList(value.taskList, `Goal "${id}" taskList`);
	const receipt =
		value.receipt === undefined
			? undefined
			: validateReceipt(value.receipt, expectedSessionId);
	const goal: NativeGoal = {
		id,
		objective,
		status,
		autoContinue: value.autoContinue,
		usage: { tokensUsed, activeSeconds },
		sisyphus: value.sisyphus,
		createdAt,
		updatedAt,
		verificationContract,
		criteriaHash: validateHash(value.criteriaHash, `Goal "${id}" criteriaHash`),
		scopeFiles,
		approved: value.approved,
		maxRuns,
		runsUsed,
		reviewAttempts,
		usageKnown: value.usageKnown,
	};
	if (approvedCommandHash !== undefined)
		goal.approvedCommandHash = approvedCommandHash;
	if (approvedRoot !== undefined) goal.approvedRoot = approvedRoot;
	if (pauseReason !== undefined) goal.pauseReason = pauseReason;
	if (tokenBudget !== undefined) goal.tokenBudget = tokenBudget;
	if (taskList !== undefined) goal.taskList = taskList;
	if (receipt !== undefined) goal.receipt = receipt;
	if (value.pendingReviewUsage === true) goal.pendingReviewUsage = true;
	if (reviewChildId !== undefined) goal.reviewChildId = reviewChildId;
	if (goal.criteriaHash !== criteriaHashForGoal(goal))
		fail(`Goal "${id}" criteriaHash does not match its criteria.`);
	if (status === "active" && !goal.approved)
		fail(`Active goal "${id}" must be approved.`);
	if (status === "complete" && (!goal.approved || receipt === undefined))
		fail(`Complete goal "${id}" must be approved and have a receipt.`);
	if (status !== "complete" && receipt !== undefined)
		fail(`Only complete goal "${id}" may contain a receipt.`);
	if (status === "budget_limited" && tokenBudget === undefined)
		fail(`Budget-limited goal "${id}" must have a token budget.`);
	if (tokenBudget !== undefined && !goal.usageKnown && status === "active")
		fail(`Active capped goal "${id}" cannot have unknown usage.`);
	if (
		tokenBudget !== undefined &&
		goal.usageKnown &&
		tokensUsed >= tokenBudget &&
		status !== "budget_limited" &&
		status !== "complete"
	) {
		fail(
			`Goal "${id}" has exhausted its token budget without a budget-limited status.`,
		);
	}
	if (
		receipt !== undefined &&
		(receipt.commandHash !== goal.approvedCommandHash ||
			receipt.root !== goal.approvedRoot)
	)
		fail(
			"Completion receipt must match the approved workspace and verifier command.",
		);
	if (receipt !== undefined && receipt.criteriaHash !== goal.criteriaHash)
		fail(`Goal "${id}" receipt criteriaHash does not match its criteria.`);
	return goal;
}

function jsonByteLength(value: unknown, label: string): number {
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "serialization failed";
		fail(`${label} cannot be serialized: ${message}.`);
	}
	if (encoded === undefined) fail(`${label} cannot be serialized.`);
	return new TextEncoder().encode(encoded).byteLength;
}

function assertSnapshotSize(snapshot: NativeSnapshot): void {
	const bytes = jsonByteLength(snapshot, "Native snapshot");
	if (bytes > MAX_SNAPSHOT_BYTES)
		fail(`Native snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes.`);
}

function parseSnapshot(
	value: unknown,
	expectedSessionId: string,
	normalizeActive: boolean,
): NativeSnapshot {
	if (!isRecord(value)) fail("Native state entry data must be an object.");
	assertExactKeys(value, SNAPSHOT_KEYS, "Native snapshot");
	if (value.version !== 1) fail("Native snapshot version must be 1.");
	const sessionId = validateSessionId(
		value.sessionId,
		expectedSessionId.length === 0,
	);
	if (sessionId !== expectedSessionId)
		fail("Native snapshot belongs to a different session.");
	if (!Array.isArray(value.goals))
		fail("Native snapshot goals must be an array.");
	if (value.goals.length > MAX_GOALS)
		fail(`Native snapshot cannot contain more than ${MAX_GOALS} goals.`);
	const goals: NativeGoal[] = [];
	const ids = new Set<string>();
	for (const rawGoal of value.goals) {
		const goal = validateNativeGoal(rawGoal, sessionId);
		if (ids.has(goal.id)) fail(`Duplicate goal id "${goal.id}".`);
		ids.add(goal.id);
		goals.push(goal);
	}
	const focusedGoalId =
		value.focusedGoalId === null
			? null
			: exactIdentifier(value.focusedGoalId, "focusedGoalId", MAX_ID_LENGTH);
	if (focusedGoalId !== null && !ids.has(focusedGoalId))
		fail("focusedGoalId does not refer to a stored goal.");
	const generation = safeInteger(
		value.generation,
		"Native snapshot generation",
		0,
	);
	if (typeof value.expanded !== "boolean")
		fail("Native snapshot expanded must be boolean.");
	const snapshot: NativeSnapshot = {
		version: 1,
		sessionId,
		goals,
		focusedGoalId,
		generation,
		expanded: value.expanded,
	};
	assertSnapshotSize(snapshot);
	if (normalizeActive) {
		for (const goal of snapshot.goals) {
			if (goal.status === "active") {
				goal.status = "paused";
				goal.pauseReason = goal.pauseReason ?? RESTORE_PAUSE_REASON;
			}
			if (goal.pendingReviewUsage) goal.usageKnown = false;
		}
		assertSnapshotSize(snapshot);
	}
	return snapshot;
}

function buildSnapshot(state: MutableState): NativeSnapshot {
	const snapshot: NativeSnapshot = {
		version: 1,
		sessionId: state.sessionId,
		goals: [...state.goals.values()].map(cloneNativeGoal),
		focusedGoalId: state.focusedGoalId,
		generation: state.generation,
		expanded: state.expanded,
	};
	assertSnapshotSize(snapshot);
	return snapshot;
}

function cloneState(state: MutableState): MutableState {
	const goals = new Map<string, NativeGoal>();
	for (const [id, goal] of state.goals) goals.set(id, cloneNativeGoal(goal));
	return {
		sessionId: state.sessionId,
		goals,
		focusedGoalId: state.focusedGoalId,
		generation: state.generation,
		expanded: state.expanded,
	};
}

function makeInitialState(sessionId: string): MutableState {
	return {
		sessionId,
		goals: new Map(),
		focusedGoalId: null,
		generation: 0,
		expanded: false,
	};
}

function cloneGoalTaskList(
	tasks: GoalTask[] | undefined,
	proposedAt: string,
	blockCompletion = false,
): GoalTaskList | undefined {
	if (tasks === undefined || tasks.length === 0) return undefined;
	return { tasks: tasks.map(cloneTask), blockCompletion, proposedAt };
}

function tokenMatches(
	left: GoalOperationToken,
	right: GoalOperationToken,
): boolean {
	return (
		left.goalId === right.goalId &&
		left.generation === right.generation &&
		left.criteriaHash === right.criteriaHash
	);
}

function tokenShape(value: unknown): value is GoalOperationToken {
	if (!isRecord(value)) return false;
	return (
		typeof value.goalId === "string" &&
		value.goalId.length > 0 &&
		typeof value.generation === "number" &&
		Number.isSafeInteger(value.generation) &&
		value.generation >= 0 &&
		typeof value.criteriaHash === "string" &&
		HASH_PATTERN.test(value.criteriaHash)
	);
}

function normalizeProgressText(
	value: string | undefined,
	label: string,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") fail(`${label} must be a string.`);
	const trimmed = value.trim();
	if (trimmed.length === 0) fail(`${label} must not be empty.`);
	if (trimmed.length > MAX_EVIDENCE_LENGTH)
		fail(`${label} exceeds its ${MAX_EVIDENCE_LENGTH}-character bound.`);
	return trimmed;
}

function findTask(
	tasks: readonly GoalTask[],
	id: string,
): GoalTask | undefined {
	for (const task of tasks) {
		if (task.id === id) return task;
		if (task.subtasks !== undefined) {
			const found = findTask(task.subtasks, id);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

function hasPendingDescendant(task: GoalTask): GoalTask | undefined {
	if (task.subtasks === undefined || task.lightweightSubtasks === true)
		return undefined;
	for (const child of task.subtasks) {
		if (child.status === "pending") return child;
		const nested = hasPendingDescendant(child);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

function skipTaskTree(
	task: GoalTask,
	timestamp: string,
	reason: string,
): GoalTask {
	if (task.status === "complete") return cloneTask(task);
	const result: GoalTask = {
		id: task.id,
		title: task.title,
		status: "skipped",
		skippedAt: timestamp,
		skipReason: reason,
	};
	if (task.verificationContract !== undefined)
		result.verificationContract = task.verificationContract;
	if (task.lightweightSubtasks !== undefined)
		result.lightweightSubtasks = task.lightweightSubtasks;
	if (task.subtasks !== undefined)
		result.subtasks = task.subtasks.map((child) =>
			skipTaskTree(child, timestamp, reason),
		);
	return result;
}

function updateTaskTree(
	tasks: readonly GoalTask[],
	id: string,
	update: (task: GoalTask) => GoalTask,
): { found: boolean; tasks: GoalTask[] } {
	let found = false;
	const result: GoalTask[] = [];
	for (const task of tasks) {
		if (task.id === id) {
			found = true;
			result.push(update(task));
			continue;
		}
		if (task.subtasks !== undefined) {
			const nested = updateTaskTree(task.subtasks, id, update);
			if (nested.found) {
				found = true;
				result.push({ ...cloneTask(task), subtasks: nested.tasks });
				continue;
			}
		}
		result.push(cloneTask(task));
	}
	return { found, tasks: result };
}

export class SessionGoalStore {
	private readonly appendEntry: AppendState;
	private readonly now: () => number;
	private readonly makeId: () => string;
	private sessionId = "";
	private goals = new Map<string, NativeGoal>();
	private focusedGoalId: string | null = null;
	private generation = 0;
	private expanded = false;
	private pendingOperation: PendingOperation | undefined;

	constructor(
		append: AppendState,
		now: () => number = () => Date.now(),
		id: () => string = randomUUID,
	) {
		if (typeof append !== "function") fail("append must be a function.");
		if (typeof now !== "function") fail("now must be a function.");
		if (typeof id !== "function") fail("id must be a function.");
		this.appendEntry = append;
		this.now = now;
		this.makeId = id;
	}

	restore(entries: readonly unknown[], sessionId: string): void {
		if (!Array.isArray(entries)) fail("entries must be an array.");
		const owner = validateSessionId(sessionId);
		let restored: NativeSnapshot | undefined;
		for (const entry of entries) {
			if (
				!isRecord(entry) ||
				entry.type !== "custom" ||
				entry.customType !== NATIVE_STATE_ENTRY
			)
				continue;
			if (!("data" in entry)) fail("Native state entry is missing data.");
			if (!isRecord(entry.data))
				fail("Native state entry data must be an object.");
			const entrySessionId = validateSessionId(entry.data.sessionId);
			if (entrySessionId !== owner) continue;
			restored = parseSnapshot(entry.data, owner, true);
		}
		const next = restored ?? makeInitialState(owner);
		this.sessionId = next.sessionId;
		this.goals =
			next.goals instanceof Map
				? new Map(
						[...next.goals.entries()].map(([id, goal]) => [
							id,
							cloneNativeGoal(goal),
						]),
					)
				: new Map(next.goals.map((goal) => [goal.id, cloneNativeGoal(goal)]));
		this.focusedGoalId = next.focusedGoalId;
		this.generation = next.generation;
		this.expanded = next.expanded;
		this.pendingOperation = undefined;
	}

	snapshot(): NativeSnapshot {
		return cloneSnapshot(buildSnapshot(this.currentState()));
	}

	focused(): NativeGoal | undefined {
		if (this.focusedGoalId === null) return undefined;
		const goal = this.goals.get(this.focusedGoalId);
		return goal === undefined ? undefined : cloneNativeGoal(goal);
	}

	get(id: string): NativeGoal | undefined {
		if (typeof id !== "string") return undefined;
		const goal = this.goals.get(id);
		return goal === undefined ? undefined : cloneNativeGoal(goal);
	}

	propose(input: NativeGoalProposal): NativeGoal {
		if (this.goals.size >= MAX_GOALS)
			fail(`A session cannot contain more than ${MAX_GOALS} goals.`);
		const prepared = this.prepareProposal(input);
		const id = exactIdentifier(this.makeId(), "Goal id", MAX_ID_LENGTH);
		if (this.goals.has(id)) fail(`Duplicate goal id "${id}".`);
		const timestamp = this.timestamp();
		const goal = this.makeGoal(id, prepared, timestamp);
		const next = this.cloneCurrentState();
		next.goals.set(id, goal);
		next.focusedGoalId = id;
		this.commit(next);
		return cloneNativeGoal(goal);
	}

	approve(id: string, verifierCommandHash: string, root: string): void {
		const goal = this.requireGoal(id);
		const approvedHash = boundedString(
			verifierCommandHash,
			"verifier command hash",
			MAX_RECEIPT_HASH_LENGTH,
		);
		const approvedRoot = boundedString(root, "approved root", MAX_ROOT_LENGTH);
		if (goal.status === "complete" || goal.status === "budget_limited")
			fail(`Goal "${id}" cannot be approved in status ${goal.status}.`);
		if (
			goal.approved &&
			goal.status === "paused" &&
			goal.approvedCommandHash === approvedHash &&
			goal.approvedRoot === approvedRoot
		)
			return;
		const next = this.cloneCurrentState();
		const updated = this.requireGoalFrom(next, id);
		updated.approved = true;
		if (
			updated.approvedCommandHash !== approvedHash ||
			updated.approvedRoot !== approvedRoot
		)
			updated.reviewAttempts = 0;
		updated.approvedCommandHash = approvedHash;
		updated.approvedRoot = approvedRoot;
		updated.status = "paused";
		delete updated.pauseReason;
		delete updated.receipt;
		updated.updatedAt = this.timestamp();
		this.commit(next);
	}

	focus(id: string | null): void {
		if (id !== null) {
			const goal = this.goals.get(id);
			if (goal === undefined) fail(`Goal "${id}" does not exist.`);
		}
		const next = this.cloneCurrentState();
		next.focusedGoalId = id;
		this.commit(next);
	}

	pause(reason: string): void {
		const target = this.requireFocusedGoal();
		if (target.status === "complete")
			fail(`Goal "${target.id}" is already complete.`);
		const pauseReason = normalizeProgressText(reason, "pause reason");
		if (pauseReason === undefined) fail("pause reason must not be empty.");
		const next = this.cloneCurrentState();
		const goal = this.requireFocusedGoalFrom(next);
		goal.status = "paused";
		goal.pauseReason = pauseReason;
		goal.updatedAt = this.timestamp();
		this.commit(next);
	}

	resume(): void {
		const target = this.requireFocusedGoal();
		if (target.status === "budget_limited")
			fail("Budget-limited goals cannot be resumed.");
		if (target.status !== "paused") fail(`Goal "${target.id}" is not paused.`);
		if (!target.approved)
			fail(`Goal "${target.id}" must be approved before it can resume.`);
		if (target.reviewAttempts >= MAX_REVIEW_ATTEMPTS)
			fail(
				"Review allowance exhausted; revise and re-approve the criteria before resuming.",
			);
		if (target.tokenBudget !== undefined && !target.usageKnown)
			fail("A capped goal with unknown usage cannot be resumed.");
		if (
			target.tokenBudget !== undefined &&
			target.usage.tokensUsed >= target.tokenBudget
		)
			fail("A goal whose token budget is exhausted cannot be resumed.");
		const next = this.cloneCurrentState();
		const goal = this.requireFocusedGoalFrom(next);
		goal.status = "active";
		goal.runsUsed = 0;
		delete goal.pauseReason;
		goal.updatedAt = this.timestamp();
		this.commit(next);
	}

	revise(input: NativeGoalProposal): void {
		const existing = this.requireFocusedGoal();
		const prepared = this.prepareProposal(input);
		if (existing.runsUsed > prepared.maxRuns)
			fail(
				`Revised maxRuns cannot be lower than runsUsed for goal "${existing.id}".`,
			);
		if (
			prepared.tokenBudget !== undefined &&
			existing.usage.tokensUsed >= prepared.tokenBudget
		)
			fail(
				`Revised tokenBudget must exceed the ${existing.usage.tokensUsed} tokens already used by goal "${existing.id}", or be removed.`,
			);
		const timestamp = this.timestamp();
		const next = this.cloneCurrentState();
		const goal = this.requireFocusedGoalFrom(next);
		goal.objective = prepared.objective;
		goal.verificationContract = prepared.verificationContract;
		goal.scopeFiles = [...prepared.scopeFiles];
		goal.sisyphus = prepared.sisyphus;
		goal.maxRuns = prepared.maxRuns;
		if (prepared.tokenBudget === undefined) delete goal.tokenBudget;
		else goal.tokenBudget = prepared.tokenBudget;
		if (prepared.tasks === undefined) delete goal.taskList;
		else goal.taskList = cloneGoalTaskList(prepared.tasks, timestamp);
		goal.criteriaHash = criteriaHashForGoal(goal);
		goal.status = "paused";
		goal.approved = false;
		goal.reviewAttempts = 0;
		delete goal.receipt;
		delete goal.pauseReason;
		goal.updatedAt = timestamp;
		this.commit(next);
	}

	replaceTasks(tasks: GoalTask[]): void {
		this.requireFocusedGoal();
		const validated = validateTaskTree(tasks, "tasks");
		const timestamp = this.timestamp();
		const next = this.cloneCurrentState();
		const goal = this.requireFocusedGoalFrom(next);
		goal.taskList =
			validated.count === 0
				? undefined
				: {
						tasks: validated.tasks,
						blockCompletion: goal.taskList?.blockCompletion ?? false,
						proposedAt: timestamp,
					};
		goal.criteriaHash = criteriaHashForGoal(goal);
		goal.status = "paused";
		goal.approved = false;
		goal.reviewAttempts = 0;
		delete goal.receipt;
		delete goal.pauseReason;
		goal.updatedAt = timestamp;
		this.commit(next);
	}

	updateTask(
		id: string,
		status: "complete" | "skipped" | "pending",
		evidence?: string,
		reason?: string,
	): void {
		if (status !== "complete" && status !== "skipped" && status !== "pending")
			fail("Task status must be complete, skipped, or pending.");
		const target = this.requireFocusedGoal();
		if (target.status === "complete" || target.status === "budget_limited")
			fail(
				`Goal "${target.id}" cannot update tasks in status ${target.status}.`,
			);
		if (target.taskList === undefined)
			fail(`Goal "${target.id}" has no task list.`);
		const task = findTask(target.taskList.tasks, id);
		if (task === undefined) fail(`Task "${id}" not found.`);
		const checkedEvidence = normalizeProgressText(evidence, "task evidence");
		const checkedReason = normalizeProgressText(reason, "skip reason");
		const timestamp = this.timestamp();
		let update: (current: GoalTask) => GoalTask;
		if (status === "complete") {
			if (task.status === "complete") fail(`Task "${id}" is already complete.`);
			if (task.status === "skipped") fail(`Task "${id}" was already skipped.`);
			if (
				task.verificationContract !== undefined &&
				checkedEvidence === undefined
			) {
				fail(`Task "${id}" requires evidence for its verification contract.`);
			}
			const pending = hasPendingDescendant(task);
			if (pending !== undefined)
				fail(`Task "${id}" has pending subtask "${pending.id}".`);
			update = (current) => {
				const nextTask: GoalTask = {
					id: current.id,
					title: current.title,
					status: "complete",
					completedAt: timestamp,
				};
				if (checkedEvidence !== undefined) nextTask.evidence = checkedEvidence;
				if (current.verificationContract !== undefined)
					nextTask.verificationContract = current.verificationContract;
				if (current.lightweightSubtasks !== undefined)
					nextTask.lightweightSubtasks = current.lightweightSubtasks;
				if (current.subtasks !== undefined)
					nextTask.subtasks = current.subtasks.map(cloneTask);
				return nextTask;
			};
		} else if (status === "skipped") {
			if (task.status === "complete") fail(`Task "${id}" is already complete.`);
			if (checkedReason === undefined)
				fail("status=skipped requires an explicit reason.");
			update = (current) => skipTaskTree(current, timestamp, checkedReason!);
		} else {
			if (task.status !== "skipped")
				fail(`Only skipped task "${id}" can be reopened.`);
			update = (current) => {
				const nextTask: GoalTask = {
					id: current.id,
					title: current.title,
					status: "pending",
				};
				if (current.verificationContract !== undefined)
					nextTask.verificationContract = current.verificationContract;
				if (current.lightweightSubtasks !== undefined)
					nextTask.lightweightSubtasks = current.lightweightSubtasks;
				if (current.subtasks !== undefined)
					nextTask.subtasks = current.subtasks.map(cloneTask);
				return nextTask;
			};
		}
		const next = this.cloneCurrentState();
		const goal = this.requireFocusedGoalFrom(next);
		const currentList = goal.taskList!;
		const changed = updateTaskTree(currentList.tasks, id, update);
		if (!changed.found) fail(`Task "${id}" not found.`);
		currentList.tasks = changed.tasks;
		goal.updatedAt = timestamp;
		this.commit(next);
	}

	charge(tokens: number | undefined, ownerId?: string): void {
		const target =
			ownerId === undefined
				? this.requireFocusedGoal()
				: this.requireGoal(ownerId);
		if (
			ownerId === undefined &&
			target.status !== "active" &&
			target.status !== "complete"
		)
			fail(`Goal "${target.id}" is not chargeable in status ${target.status}.`);
		if (tokens !== undefined) safeInteger(tokens, "tokens", 0);
		const next = this.cloneCurrentState();
		const goal = this.requireGoalFrom(next, target.id);
		if (tokens === undefined) {
			goal.usageKnown = false;
			if (goal.status !== "complete" && goal.tokenBudget !== undefined) {
				goal.status = "paused";
				goal.pauseReason = UNKNOWN_USAGE_REASON;
			}
		} else {
			if (goal.usage.tokensUsed > Number.MAX_SAFE_INTEGER - tokens)
				fail("Token usage exceeds the safe integer bound.");
			goal.usage.tokensUsed += tokens;
			if (
				goal.status !== "complete" &&
				goal.tokenBudget !== undefined &&
				goal.usageKnown &&
				goal.usage.tokensUsed >= goal.tokenBudget
			) {
				goal.status = "budget_limited";
				goal.pauseReason = TOKEN_BUDGET_REASON;
			}
		}
		delete goal.pendingReviewUsage;
		goal.updatedAt = this.timestamp();
		const preserveLiveReview =
			this.pendingOperation?.kind === "review" &&
			this.pendingOperation.token.goalId === target.id &&
			goal.status === "active" &&
			this.isCurrent(this.pendingOperation.token);
		this.commit(next, !preserveLiveReview);
	}

	claimContinuation(): GoalOperationToken | undefined {
		const target = this.requireFocusedGoal();
		if (
			this.pendingOperation !== undefined &&
			this.isCurrent(this.pendingOperation.token)
		)
			fail("An operation is already in flight.");
		if (!target.approved || target.status !== "active") return undefined;
		if (
			target.tokenBudget !== undefined &&
			target.usageKnown &&
			target.usage.tokensUsed >= target.tokenBudget
		) {
			this.transitionFocusedStatus("budget_limited", TOKEN_BUDGET_REASON);
			return undefined;
		}
		if (target.runsUsed >= target.maxRuns) {
			this.transitionFocusedStatus("paused", RUNS_EXHAUSTED_REASON);
			return undefined;
		}
		const next = this.cloneCurrentState();
		const goal = this.requireFocusedGoalFrom(next);
		goal.runsUsed += 1;
		goal.updatedAt = this.timestamp();
		this.commit(next);
		const token: GoalOperationToken = {
			goalId: goal.id,
			generation: this.generation,
			criteriaHash: goal.criteriaHash,
		};
		this.pendingOperation = { token, kind: "continuation" };
		return { ...token };
	}

	isCurrent(token: GoalOperationToken): boolean {
		if (
			!tokenShape(token) ||
			this.pendingOperation === undefined ||
			!tokenMatches(token, this.pendingOperation.token)
		)
			return false;
		if (
			token.generation !== this.generation ||
			this.focusedGoalId !== token.goalId
		)
			return false;
		const goal = this.goals.get(token.goalId);
		return (
			goal !== undefined &&
			goal.status === "active" &&
			goal.approved &&
			goal.criteriaHash === token.criteriaHash
		);
	}

	consumeContinuation(token: GoalOperationToken): void {
		if (
			this.pendingOperation?.kind !== "continuation" ||
			!this.isCurrent(token)
		) {
			fail("Continuation token is stale or is not the current continuation.");
		}
		this.pendingOperation = undefined;
	}

	beginReview(): GoalOperationToken {
		const target = this.requireFocusedGoal();
		if (
			this.pendingOperation !== undefined &&
			this.isCurrent(this.pendingOperation.token)
		)
			fail("An operation is already in flight.");
		if (target.reviewAttempts >= MAX_REVIEW_ATTEMPTS)
			fail("Review attempt allowance exhausted.");
		if (!target.approved || target.status !== "active")
			fail(`Goal "${target.id}" must be approved and active before review.`);
		const next = this.cloneCurrentState();
		const goal = this.requireFocusedGoalFrom(next);
		goal.reviewAttempts += 1;
		goal.pendingReviewUsage = true;
		delete goal.reviewChildId;
		goal.updatedAt = this.timestamp();
		this.commit(next);
		const token: GoalOperationToken = {
			goalId: goal.id,
			generation: this.generation,
			criteriaHash: goal.criteriaHash,
		};
		this.pendingOperation = { token, kind: "review" };
		return { ...token };
	}

	recordReviewChild(token: GoalOperationToken, id: string): void {
		const goal = this.requireOperation(token, "review");
		const childId = exactIdentifier(id, "review child id", MAX_ID_LENGTH);
		const next = this.cloneCurrentState();
		this.requireGoalFrom(next, goal.id).reviewChildId = childId;
		this.commit(next, false);
	}

	complete(token: GoalOperationToken, receipt: NativeCompletionReceipt): void {
		const goal = this.requireOperation(token, "review");
		if (!goal.approved || goal.status !== "active")
			fail(`Goal "${goal.id}" is not eligible for completion.`);
		if (!isRecord(receipt)) fail("receipt must be an object.");
		assertExactKeys(receipt, RECEIPT_KEYS, "receipt");
		const checked = validateReceipt(receipt, this.sessionId);
		if (
			checked.commandHash !== goal.approvedCommandHash ||
			checked.root !== goal.approvedRoot
		)
			fail(
				"Completion receipt does not match the approved workspace and verifier command.",
			);
		if (
			checked.criteriaHash !== goal.criteriaHash ||
			token.criteriaHash !== goal.criteriaHash
		)
			fail(
				"Completion receipt criteriaHash does not match the current criteria.",
			);
		const next = this.cloneCurrentState();
		const updated = this.requireGoalFrom(next, goal.id);
		updated.status = "complete";
		delete updated.pendingReviewUsage;
		updated.receipt = checked;
		delete updated.pauseReason;
		updated.updatedAt = this.timestamp();
		this.commit(next);
	}

	failedReview(token: GoalOperationToken, reason: string): void {
		const goal = this.requireOperation(token, "review");
		const checkedReason = normalizeProgressText(
			reason,
			"review failure reason",
		);
		if (checkedReason === undefined)
			fail("review failure reason must not be empty.");
		const next = this.cloneCurrentState();
		const updated = this.requireGoalFrom(next, goal.id);
		delete updated.pendingReviewUsage;
		if (updated.reviewAttempts >= MAX_REVIEW_ATTEMPTS) {
			updated.status = "paused";
			updated.pauseReason = checkedReason;
		}
		updated.updatedAt = this.timestamp();
		this.commit(next);
	}

	clearFocused(): void {
		const goal = this.requireFocusedGoal();
		const next = this.cloneCurrentState();
		next.goals.delete(goal.id);
		next.focusedGoalId = null;
		this.commit(next);
	}

	toggleExpanded(): void {
		const next = this.cloneCurrentState();
		next.expanded = !next.expanded;
		this.commit(next, false);
	}

	private currentState(): MutableState {
		return {
			sessionId: this.sessionId,
			goals: this.goals,
			focusedGoalId: this.focusedGoalId,
			generation: this.generation,
			expanded: this.expanded,
		};
	}

	private cloneCurrentState(): MutableState {
		return cloneState(this.currentState());
	}

	private timestamp(): string {
		const value = this.now();
		if (typeof value !== "number" || !Number.isFinite(value))
			fail("now must return a finite number.");
		try {
			return new Date(value).toISOString();
		} catch {
			fail("now returned an invalid date.");
		}
	}

	private prepareProposal(input: NativeGoalProposal): PreparedProposal {
		if (!isRecord(input)) fail("proposal must be an object.");
		assertExactKeys(input, PROPOSAL_KEYS, "Goal proposal");
		const objective = boundedString(
			input.objective,
			"objective",
			MAX_OBJECTIVE_LENGTH,
		);
		const verificationContract = boundedString(
			input.verificationContract,
			"verificationContract",
			MAX_CONTRACT_LENGTH,
		);
		const scopeFiles = validateScopeFiles(input.scopeFiles);
		const tasks =
			input.tasks === undefined
				? undefined
				: validateTaskTree(input.tasks, "tasks").tasks;
		const tokenBudget =
			input.tokenBudget === undefined
				? undefined
				: safeInteger(input.tokenBudget, "tokenBudget", 1);
		const maxRuns =
			input.maxRuns === undefined
				? DEFAULT_MAX_RUNS
				: safeInteger(input.maxRuns, "maxRuns", 1, MAX_RUNS);
		if (input.sisyphus !== undefined && typeof input.sisyphus !== "boolean")
			fail("sisyphus must be boolean.");
		return {
			objective,
			verificationContract,
			scopeFiles,
			tasks,
			tokenBudget,
			maxRuns,
			sisyphus: input.sisyphus === true,
		};
	}

	private makeGoal(
		id: string,
		prepared: PreparedProposal,
		timestamp: string,
	): NativeGoal {
		const taskList = cloneGoalTaskList(prepared.tasks, timestamp);
		const goal: NativeGoal = {
			id,
			objective: prepared.objective,
			status: "paused",
			autoContinue: true,
			usage: { tokensUsed: 0, activeSeconds: 0 },
			sisyphus: prepared.sisyphus,
			createdAt: timestamp,
			updatedAt: timestamp,
			verificationContract: prepared.verificationContract,
			taskList,
			criteriaHash: "",
			scopeFiles: [...prepared.scopeFiles],
			approved: false,
			maxRuns: prepared.maxRuns,
			runsUsed: 0,
			reviewAttempts: 0,
			usageKnown: true,
		};
		if (prepared.tokenBudget !== undefined)
			goal.tokenBudget = prepared.tokenBudget;
		goal.criteriaHash = criteriaHashForGoal(goal);
		return goal;
	}

	private commit(next: MutableState, invalidate = true): void {
		if (invalidate) {
			if (this.generation === Number.MAX_SAFE_INTEGER)
				fail("Operation generation exhausted.");
			next.generation = this.generation + 1;
		} else {
			next.generation = this.generation;
		}
		const snapshot = buildSnapshot(next);
		// Validate the generated schema as well as its serialized size before append.
		parseSnapshot(snapshot, snapshot.sessionId, false);
		this.appendEntry(NATIVE_STATE_ENTRY, cloneSnapshot(snapshot));
		this.sessionId = next.sessionId;
		this.goals = new Map(next.goals);
		this.focusedGoalId = next.focusedGoalId;
		this.generation = next.generation;
		this.expanded = next.expanded;
		if (invalidate) this.pendingOperation = undefined;
	}

	private requireGoal(id: string): NativeGoal {
		if (typeof id !== "string" || id.length === 0)
			fail("Goal id must be a non-empty string.");
		const goal = this.goals.get(id);
		if (goal === undefined) fail(`Goal "${id}" does not exist.`);
		return goal;
	}

	private requireGoalFrom(state: MutableState, id: string): NativeGoal {
		const goal = state.goals.get(id);
		if (goal === undefined) fail(`Goal "${id}" does not exist.`);
		return goal;
	}

	private requireFocusedGoal(): NativeGoal {
		if (this.focusedGoalId === null) fail("No goal is focused.");
		return this.requireGoal(this.focusedGoalId);
	}

	private requireFocusedGoalFrom(state: MutableState): NativeGoal {
		if (state.focusedGoalId === null) fail("No goal is focused.");
		return this.requireGoalFrom(state, state.focusedGoalId);
	}

	private transitionFocusedStatus(
		status: "paused" | "budget_limited",
		reason: string,
	): void {
		const next = this.cloneCurrentState();
		const goal = this.requireFocusedGoalFrom(next);
		goal.status = status;
		goal.pauseReason = reason;
		goal.updatedAt = this.timestamp();
		this.commit(next);
	}

	private requireOperation(
		token: GoalOperationToken,
		kind: OperationKind,
	): NativeGoal {
		if (!this.isCurrent(token) || this.pendingOperation?.kind !== kind)
			fail("Operation token is stale or belongs to a different operation.");
		return this.requireGoal(token.goalId);
	}
}
