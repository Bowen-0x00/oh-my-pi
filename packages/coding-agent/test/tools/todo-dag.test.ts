import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TodoTracker, type TodoTrackerHost } from "@oh-my-pi/pi-coding-agent/session/todo-tracker";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	getLatestTodoDagRemovedCountFromEntries,
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	nextActionableTask,
	phasesToMarkdown,
	TodoTool,
} from "@oh-my-pi/pi-coding-agent/tools";
import { analyzeTodoDag } from "@oh-my-pi/pi-coding-agent/tools/todo-dag";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { type TodoPhase, todoToolRenderer } from "@oh-my-pi/pi-tui/tools/todo";

function createDagSession(
	initialPhases: TodoPhase[] = [],
	dag = true,
): {
	session: ToolSession;
	getRemovedCount: () => number;
} {
	let phases = initialPhases;
	let removedCount = 0;
	const session: ToolSession = {
		cwd: "/tmp/test-dag",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "todo.dag": dag }),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
			if (next.length === 0) removedCount = 0;
		},
		getTodoDagRemovedCount: () => removedCount,
		setTodoDagRemovedCount: count => {
			removedCount = count;
		},
	};
	return { session, getRemovedCount: () => removedCount };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

beforeAll(async () => {
	await initTheme();
});

describe("TodoTool DAG mode gating", () => {
	it("preserves legacy linear behavior and schema when todo.dag is false", async () => {
		const { session } = createDagSession([], false);
		const tool = new TodoTool(session);

		expect(tool.description).not.toContain("DAG mode is active");
		const res = await tool.execute("c1", {
			op: "init",
			list: [{ phase: "Work", items: ["first", "second"] }],
		});
		expect(res.isError).toBeUndefined();
		expect(res.details?.dag).toBeUndefined();
		expect(res.details?.phases[0]?.tasks).toEqual([
			{ content: "first", status: "in_progress" },
			{ content: "second", status: "pending" },
		]);
	});

	it("switches description, schema, and behavior dynamically when todo.dag is true", async () => {
		const { session } = createDagSession([], true);
		const tool = new TodoTool(session);

		expect(tool.description).toContain("DAG mode is active");
		const res = await tool.execute("c1", {
			op: "init",
			nodes: [
				{ id: "t1", content: "Inspect parser", phase: "Explore" },
				{ id: "t2", content: "Fix parser bug", phase: "Build", deps: ["t1"] },
			],
		});
		expect(res.isError).toBeUndefined();
		expect(res.details?.dag).toBe(true);
		expect(res.details?.readyIds).toEqual(["t1"]);
	});
});

describe("TodoTool DAG topological scheduling and prerequisite enforcement", () => {
	it("surfaces unlocked tasks topologically after each completion so the agent chooses next", async () => {
		const { session } = createDagSession([], true);
		const tool = new TodoTool(session);

		const initRes = await tool.execute("init", {
			op: "init",
			nodes: [
				{ id: "t1", content: "Inspect schema", phase: "Explore" },
				{ id: "t2", content: "Update backend validator", phase: "Implement", deps: ["t1"] },
				{ id: "t3", content: "Update client form", phase: "Implement", deps: ["t1"] },
				{ id: "t4", content: "Run end-to-end tests", phase: "Verify", deps: ["t2", "t3"] },
			],
		});
		expect(initRes.isError).toBeUndefined();
		expect(initRes.details?.readyIds).toEqual(["t1"]);
		expect(textOf(initRes)).toContain("Ready to start — all prerequisites satisfied (1):");
		expect(textOf(initRes)).toContain("[t1] Inspect schema");
		expect(textOf(initRes)).toContain("Blocked by unmet prerequisites (3):");
		expect(textOf(initRes)).toContain("[t4] Run end-to-end tests (Verify) <- blocked by: t2 [pending], t3 [pending]");

		// Blocked task cannot be started or completed before prerequisites settle.
		const blockedStart = await tool.execute("s-blocked", { op: "start", id: "t2" });
		expect(blockedStart.isError).toBe(true);
		expect(textOf(blockedStart)).toContain("blocked by unmet prerequisites: t1");

		const blockedDone = await tool.execute("d-blocked", { op: "done", id: "t4" });
		expect(blockedDone.isError).toBe(true);
		expect(textOf(blockedDone)).toContain("blocked by unmet prerequisites");

		// Start and finish t1 -> both t2 and t3 become ready without auto-starting either.
		const startT1 = await tool.execute("s1", { op: "start", id: "t1" });
		expect(startT1.isError).toBeUndefined();
		const doneT1 = await tool.execute("d1", { op: "done", id: "t1" });
		expect(doneT1.isError).toBeUndefined();
		expect(doneT1.details?.readyIds).toEqual(["t2", "t3"]);
		const doneT1Text = textOf(doneT1);
		expect(doneT1Text).toContain("Ready to start — all prerequisites satisfied (2):");
		expect(doneT1Text).toContain("[t2] Update backend validator");
		expect(doneT1Text).toContain("[t3] Update client form");
		expect(doneT1Text).toContain("Choose which ready task(s) to execute");

		// Agent chooses to run both t2 and t3 concurrently.
		const startParallel = await tool.execute("s23", { op: "start", ids: ["t2", "t3"] });
		expect(startParallel.isError).toBeUndefined();
		const activeIds = startParallel.details?.phases
			.flatMap(p => p.tasks)
			.filter(t => t.status === "in_progress")
			.map(t => t.id);
		expect(activeIds).toEqual(["t2", "t3"]);

		// Completing t2 alone keeps t4 blocked on t3.
		const doneT2 = await tool.execute("d2", { op: "done", id: "t2" });
		expect(doneT2.isError).toBeUndefined();
		expect(doneT2.details?.readyIds).toEqual([]);
		expect(textOf(doneT2)).toContain("[t4] Run end-to-end tests (Verify) <- blocked by: t3 [in_progress]");

		// Completing t3 unlocks t4.
		const doneT3 = await tool.execute("d3", { op: "done", id: "t3" });
		expect(doneT3.isError).toBeUndefined();
		expect(doneT3.details?.readyIds).toEqual(["t4"]);
	});
});

describe("TodoTool DAG dynamic edits and anti-cheat guardrails", () => {
	it("splices an inserted prerequisite between two nodes and demotes an in_progress successor", async () => {
		const { session } = createDagSession([], true);
		const tool = new TodoTool(session);

		await tool.execute("init", {
			op: "init",
			nodes: [
				{ id: "t1", content: "Read config parser", phase: "Explore" },
				{ id: "t2", content: "Refactor settings loader", phase: "Build", deps: ["t1"] },
			],
		});
		await tool.execute("s1", { op: "start", id: "t1" });
		await tool.execute("d1", { op: "done", id: "t1" });
		await tool.execute("s2", { op: "start", id: "t2" });

		// Discover a missing intermediate step before t2 while t2 is already in_progress.
		const insertRes = await tool.execute("ins", {
			op: "insert",
			content: "Migrate legacy YAML schema",
			after: ["t1"],
			before: ["t2"],
			reason: "Discovered unmigrated YAML keys required before Refactor settings loader",
		});
		expect(insertRes.isError).toBeUndefined();

		const tasks = insertRes.details?.phases.flatMap(p => p.tasks) ?? [];
		const inserted = tasks.find(t => t.content === "Migrate legacy YAML schema");
		const t2 = tasks.find(t => t.id === "t2");
		expect(inserted?.id).toBe("t3");
		expect(inserted?.deps).toEqual(["t1"]);
		expect(t2?.deps).toEqual(["t3"]);
		// t2 had an unmet prerequisite inserted before it, so it demotes back to pending.
		expect(t2?.status).toBe("pending");
		expect(insertRes.details?.readyIds).toEqual(["t3"]);
	});

	it("rejects cycles on insert and update without corrupting existing DAG state", async () => {
		const { session } = createDagSession([], true);
		const tool = new TodoTool(session);
		await tool.execute("init", {
			op: "init",
			nodes: [
				{ id: "t1", content: "Step one" },
				{ id: "t2", content: "Step two", deps: ["t1"] },
			],
		});

		const cycleInsert = await tool.execute("ins-cycle", {
			op: "insert",
			content: "Cycle node",
			after: ["t2"],
			before: ["t1"],
			reason: "Testing cycle prevention across existing edges",
		});
		expect(cycleInsert.isError).toBe(true);
		expect(textOf(cycleInsert)).toContain("Cycle detected");

		const cycleUpdate = await tool.execute("upd-cycle", {
			op: "update",
			id: "t1",
			addDeps: ["t2"],
			reason: "Testing cycle prevention in update",
		});
		expect(cycleUpdate.isError).toBe(true);
		expect(textOf(cycleUpdate)).toContain("Cycle detected");
		expect(session.getTodoPhases?.()?.[0]?.tasks.map(t => t.id)).toEqual(["t1", "t2"]);
	});

	it("bridges dependencies on rm and unblocks dependents on drop when given valid reasons", async () => {
		const { session, getRemovedCount } = createDagSession([], true);
		const tool = new TodoTool(session);
		await tool.execute("init", {
			op: "init",
			nodes: [
				{ id: "t1", content: "Audit routes" },
				{ id: "t2", content: "Add legacy shim", deps: ["t1"] },
				{ id: "t3", content: "Update integration test", deps: ["t2"] },
				{ id: "t4", content: "Verify optional cache", deps: ["t1"] },
			],
		});
		await tool.execute("s1", { op: "start", id: "t1" });
		await tool.execute("d1", { op: "done", id: "t1" });

		const rmRes = await tool.execute("rm2", {
			op: "rm",
			id: "t2",
			reason: "Legacy shim is unnecessary because all callers already use v2 routes",
		});
		expect(rmRes.isError).toBeUndefined();
		expect(getRemovedCount()).toBe(1);
		const t3 = rmRes.details?.phases.flatMap(p => p.tasks).find(t => t.id === "t3");
		// Transitive bridging: t1 -> t2 -> t3 becomes t1 -> t3 (which is already ready since t1 is done!).
		expect(t3?.deps).toEqual(["t1"]);
		expect(rmRes.details?.readyIds).toContain("t3");

		// Complete t3 so completed (2) >= abandoned + removed (2) before dropping t4.
		await tool.execute("s3", { op: "start", id: "t3" });
		await tool.execute("d3", { op: "done", id: "t3" });

		const dropRes = await tool.execute("drop4", {
			op: "drop",
			id: "t4",
			reason: "Cache layer is disabled in this repository configuration",
		});
		expect(dropRes.isError).toBeUndefined();
		const t4 = dropRes.details?.phases.flatMap(p => p.tasks).find(t => t.id === "t4");
		expect(t4?.status).toBe("abandoned");
		expect(t4?.reason).toBe("Cache layer is disabled in this repository configuration");
	});

	it("blocks missing/trivial reasons, bulk deletion, re-init overwrites, and deleting all nodes to fake completion", async () => {
		const { session } = createDagSession([], true);
		const tool = new TodoTool(session);
		await tool.execute("init", {
			op: "init",
			nodes: [
				{ id: "t1", content: "Implement core parser" },
				{ id: "t2", content: "Add validation rules", deps: ["t1"] },
				{ id: "t3", content: "Write regression suite", deps: ["t2"] },
			],
		});

		// 1. Re-init while open tasks exist is blocked.
		const reinit = await tool.execute("reinit", {
			op: "init",
			nodes: [{ id: "x1", content: "Trivial replacement" }],
		});
		expect(reinit.isError).toBe(true);
		expect(textOf(reinit)).toContain("Cannot re-initialize an active DAG");

		// 2. Bulk rm/drop without specific target is blocked.
		const bulkRm = await tool.execute("bulk-rm", {
			op: "rm",
			reason: "Clear everything out of the list",
		});
		expect(bulkRm.isError).toBe(true);
		expect(textOf(bulkRm)).toContain("bulk removal is not allowed");

		const bulkDrop = await tool.execute("bulk-drop", {
			op: "drop",
			reason: "Abandon all tasks at once",
		});
		expect(bulkDrop.isError).toBe(true);
		expect(textOf(bulkDrop)).toContain("bulk drop is not allowed");

		// 3. Trivial or missing reason is rejected.
		const noReason = await tool.execute("no-reason", { op: "rm", id: "t3" });
		expect(noReason.isError).toBe(true);
		expect(textOf(noReason)).toContain('requires a substantive "reason"');

		const trivialReason = await tool.execute("trivial-reason", { op: "drop", id: "t3", reason: "skip" });
		expect(trivialReason.isError).toBe(true);
		expect(textOf(trivialReason)).toContain('requires a specific, substantive "reason"');

		// 4. Cannot remove/drop most/all nodes without completing tasks.
		const rm1 = await tool.execute("rm-t3", {
			op: "rm",
			id: "t3",
			reason: "Consolidating regression checks into validation step",
		});
		expect(rm1.isError).toBeUndefined();

		const rm2 = await tool.execute("rm-t2", {
			op: "rm",
			id: "t2",
			reason: "Trying to delete second open task with zero completed",
		});
		expect(rm2.isError).toBe(true);
		expect(textOf(rm2)).toContain("without completing any tasks");

		// Even if t1 is completed (1 completed), cannot drop t2 when removed(1)+abandoned(1) > completed(1).
		await tool.execute("s1", { op: "start", id: "t1" });
		await tool.execute("d1", { op: "done", id: "t1" });
		const dropLast = await tool.execute("drop-t2", {
			op: "drop",
			id: "t2",
			reason: "Attempting to close out DAG by dropping remaining work",
		});
		expect(dropLast.isError).toBe(true);
		expect(textOf(dropLast)).toContain(
			"closing out the DAG would leave 2 dropped/removed task(s) vs only 1 completed",
		);

		// 5. Completed tasks cannot be dropped or removed.
		const rmDone = await tool.execute("rm-done", {
			op: "rm",
			id: "t1",
			reason: "Trying to remove already completed work",
		});
		expect(rmDone.isError).toBe(true);
		expect(textOf(rmDone)).toContain("Cannot rm already completed task t1");
	});
});

describe("TodoTracker, Markdown, and TUI integration for DAG todos", () => {
	it("preserves DAG ids, deps, and removedCount across branch rehydration and eager/reminder prompts", async () => {
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"todo.dag": true,
			"todo.eager": "preferred",
			"todo.reminders": true,
		});
		const scheduled: string[] = [];
		const host: TodoTrackerHost = {
			agent: { state: { messages: [] }, appendMessage: () => {} } as unknown as TodoTrackerHost["agent"],
			sessionManager,
			settings,
			model: () => undefined,
			agentKind: () => "main",
			emitSessionEvent: async () => {},
			scheduleAgentContinue: opts => {
				scheduled.push(opts.source);
			},
			promptGeneration: () => 1,
			hasPendingAsyncWake: () => false,
			getActiveToolNames: () => ["todo", "read"],
			getEnabledToolNames: () => ["todo", "read"],
			toolRegistry: () => new Map(),
			planModeEnabled: () => false,
			prewalkWillHandoff: () => false,
			consumeLastServedToolChoiceLabel: () => undefined,
		};

		const tracker = new TodoTracker(host);
		const prelude = tracker.createEagerTodoPrelude("Implement feature X");
		const preludeContent =
			prelude?.message && "content" in prelude.message && typeof prelude.message.content === "string"
				? prelude.message.content
				: "";
		expect(preludeContent).toContain("nodes: [{ id?, content, phase?, deps? }]");

		const phases: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ id: "t1", content: "First step", status: "completed", deps: [] },
					{ id: "t2", content: "Ready branch", status: "pending", deps: ["t1"] },
					{ id: "t3", content: "Blocked branch", status: "pending", deps: ["t2"] },
				],
			},
		];
		tracker.setPhases(phases);
		tracker.setDagRemovedCount(1);
		expect(tracker.phases).toEqual(phases);
		expect(nextActionableTask(tracker.phases)?.id).toBe("t2");

		// Persist a todo toolResult entry and rehydrate into a fresh tracker.
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "todo",
			content: [{ type: "text", text: "ok" }],
			details: { op: "rm", phases, storage: "memory", dag: true, removedCount: 2 },
			isError: false,
			timestamp: Date.now(),
		});
		const branch = sessionManager.getBranch();
		expect(getLatestTodoPhasesFromEntries(branch)).toEqual(phases);
		expect(getLatestTodoDagRemovedCountFromEntries(branch)).toBe(2);

		const rehydrated = new TodoTracker(host);
		rehydrated.syncFromBranch();
		expect(rehydrated.phases).toEqual(phases);
		expect(rehydrated.dagRemovedCount).toBe(2);

		const reminded = await rehydrated.checkCompletion({
			role: "assistant",
			content: [{ type: "text", text: "Done for now." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		expect(reminded).toBe(true);
		expect(scheduled).toEqual(["todo-reminder"]);
		const reminderMsg = sessionManager.getBranch().at(-1);
		expect(reminderMsg?.type).toBe("message");
		if (reminderMsg?.type === "message" && reminderMsg.message.role === "developer") {
			const rawContent = reminderMsg.message.content;
			const text =
				typeof rawContent === "string" ? rawContent : (rawContent.find(c => c.type === "text")?.text ?? "");
			expect(text).toContain("[t2] Ready branch (ready)");
			expect(text).toContain("[t3] Blocked branch (blocked by t2)");
		}
	});

	it("round-trips DAG ids and deps through Markdown and renders blocked dependency hints in TUI", () => {
		const phases: TodoPhase[] = [
			{
				name: "Build",
				tasks: [
					{ id: "t1", content: "Write parser", status: "in_progress", deps: [] },
					{ id: "t2", content: "Run tests", status: "pending", deps: ["t1"] },
				],
			},
		];
		const md = phasesToMarkdown(phases);
		expect(md).toBe("# Build\n- [/] [t1] Write parser\n- [ ] [t2] Run tests (deps: t1)\n");
		const parsed = markdownToPhases(md);
		expect(parsed.errors).toEqual([]);
		expect(parsed.phases).toEqual(phases);

		const rendered = Bun.stripANSI(
			todoToolRenderer
				.renderResult(
					{
						content: [{ type: "text", text: "ok" }],
						details: { op: "init", phases, storage: "memory", dag: true },
					},
					{ expanded: true, isPartial: false },
					theme,
				)
				.render(120)
				.join("\n"),
		);
		expect(rendered).toContain("[t1] Write parser");
		expect(rendered).toContain("[t2] Run tests (needs t1)");
		expect(analyzeTodoDag(phases).blockedIds).toEqual(["t2"]);
	});
});
