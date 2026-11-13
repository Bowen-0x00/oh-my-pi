import { type } from "@oh-my-pi/omptype";
import { isRecord } from "@oh-my-pi/pi-utils";
import { isClosedTodo, type TodoItem, type TodoOperation, type TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

export const DEFAULT_DAG_PHASE = "Tasks";

const DagNodeInput = type({
	"id?": type("string").describe("optional short node ID (e.g. t1); auto-assigned if omitted"),
	content: type("string").describe("concise 5-10 word task label"),
	"phase?": type("string").describe("phase group name (default: Tasks)"),
	"deps?": type("string[]").describe("prerequisite task IDs or contents that must finish first"),
});

export const todoDagSchema = type({
	op: type('"init" | "start" | "done" | "rm" | "drop" | "append" | "insert" | "update" | "view"'),
	"nodes?": DagNodeInput.array().describe("dependency DAG nodes for init"),
	"list?": type({ phase: "string", items: type("string").array().atLeastLength(1) })
		.array()
		.describe("phases for flat/sequential init"),
	"id?": type("string").describe("target task ID (e.g. t1) for start/done/update/drop/rm or custom ID for insert"),
	"ids?": type("string[]").describe("multiple task IDs for parallel start or batch done"),
	"task?": type("string").describe("task ID or verbatim content (or label fallback for insert)"),
	"content?": type("string").describe("task label for insert or replacement text for update"),
	"phase?": type("string").describe("target phase name"),
	"items?": type("string[]").describe("task labels for flat init or append"),
	"deps?": type("string[]").describe(
		"prerequisite task IDs/contents for insert/append, or full deps replacement for update",
	),
	"after?": type("string[]").describe("prerequisite task IDs/contents that must finish before the inserted task"),
	"before?": type("string[]").describe("existing task IDs/contents that must wait for the inserted task"),
	"blocks?": type("string[]").describe("alias for before"),
	"addDeps?": type("string[]").describe("prerequisite task IDs/contents to add in update"),
	"removeDeps?": type("string[]").describe("prerequisite task IDs/contents to remove in update"),
	"reason?": type("string").describe(
		"substantive justification required for insert, append (active DAG), update, drop, and rm",
	),
});

export type TodoDagParams = typeof todoDagSchema.infer;

export interface DagNodeRecord {
	id: string;
	task: TodoItem;
	phase: TodoPhase;
	orderIndex: number;
}

export interface TodoDagAnalysis {
	nodes: Map<string, DagNodeRecord>;
	orderedIds: string[];
	layerById: Map<string, number>;
	dependentsById: Map<string, string[]>;
	unmetDepsById: Map<string, TodoItem[]>;
	readyIds: string[];
	activeIds: string[];
	blockedIds: string[];
	completedCount: number;
	abandonedCount: number;
	openCount: number;
	totalCount: number;
	cycleError?: string;
	missingDepErrors: string[];
}

const TRIVIAL_REASONS: Record<string, true> = {
	na: true,
	"n a": true,
	none: true,
	nil: true,
	null: true,
	skip: true,
	skipped: true,
	done: true,
	ok: true,
	okay: true,
	yes: true,
	no: true,
	test: true,
	delete: true,
	deleted: true,
	remove: true,
	removed: true,
	drop: true,
	dropped: true,
	abandon: true,
	abandoned: true,
	cleanup: true,
	"clean up": true,
	"not needed": true,
	unnecessary: true,
	finish: true,
	finished: true,
	complete: true,
	completed: true,
	whatever: true,
	because: true,
	update: true,
	insert: true,
	add: true,
	modify: true,
	fix: true,
};

const NON_ASCII_RE = /[^\x00-\x7F]/;

/** Clone a single TodoItem, omitting undefined optional properties so legacy snapshots stay byte-identical. */
export function cloneTodoItem(task: TodoItem): TodoItem {
	const cloned: TodoItem = { content: task.content, status: task.status };
	if (task.id !== undefined) cloned.id = task.id;
	if (task.deps !== undefined) cloned.deps = [...task.deps];
	if (task.details !== undefined) cloned.details = task.details;
	if (task.notes !== undefined) cloned.notes = [...task.notes];
	if (task.reason !== undefined) cloned.reason = task.reason;
	return cloned;
}

/** Clone TodoPhase[], preserving all optional DAG/metadata fields when defined. */
export function cloneTodoPhases(phases: readonly TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(cloneTodoItem),
	}));
}

/** Whether any task in the list carries explicit DAG metadata. */
export function hasDagMetadata(phases: readonly TodoPhase[]): boolean {
	return phases.some(phase => phase.tasks.some(task => task.id !== undefined || task.deps !== undefined));
}

function validateTaskIdFormat(id: string): string | undefined {
	const trimmed = id.trim();
	if (!trimmed) return "Task ID cannot be empty";
	if (trimmed !== id) return `Task ID "${id}" must not have leading or trailing whitespace`;
	if (/[\s,]/.test(trimmed)) return `Task ID "${id}" must not contain whitespace or commas`;
	return undefined;
}

function allocateNextDagId(phases: readonly TodoPhase[], reserved: Set<string>): string {
	let maxNum = 0;
	const checkId = (id: string | undefined) => {
		if (!id) return;
		const match = /^t(\d+)$/.exec(id);
		if (match) {
			const n = Number.parseInt(match[1], 10);
			if (n > maxNum) maxNum = n;
		}
	};
	for (const phase of phases) {
		for (const task of phase.tasks) {
			checkId(task.id);
		}
	}
	for (const id of reserved) {
		checkId(id);
	}
	let candidate = `t${maxNum + 1}`;
	while (reserved.has(candidate)) {
		maxNum++;
		candidate = `t${maxNum + 1}`;
	}
	reserved.add(candidate);
	return candidate;
}

/**
 * Upgrade legacy ID-less phases into a valid DAG when DAG mode is enabled mid-session.
 * Preserves existing IDs/deps if already present.
 */
export function normalizePhasesForDag(phases: TodoPhase[]): TodoPhase[] {
	if (phases.length === 0) return phases;
	const reserved = new Set<string>();
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.id) reserved.add(task.id);
		}
	}
	let previousId: string | undefined;
	const hadAnyIds = hasDagMetadata(phases);
	return phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(rawTask => {
			const task = cloneTodoItem(rawTask);
			if (!task.id) {
				task.id = allocateNextDagId(phases, reserved);
			}
			if (task.deps === undefined) {
				// Legacy sequential plans imply previous task order when upgraded mid-session.
				task.deps = !hadAnyIds && previousId ? [previousId] : [];
			}
			previousId = task.id;
			return task;
		}),
	}));
}

/** Validate that a mutation reason is substantive and not an evasion placeholder. */
export function validateDagReason(reason: unknown, op: string): string | undefined {
	if (typeof reason !== "string" || reason.trim().length === 0) {
		return `Operation "${op}" requires a substantive "reason" explaining why the DAG is being modified.`;
	}
	const trimmed = reason.trim();
	const normalized = trimmed
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized || TRIVIAL_REASONS[normalized]) {
		return `Operation "${op}" requires a specific, substantive "reason" (got "${trimmed}"). Explain the concrete technical or scope justification.`;
	}
	const compact = trimmed.replace(/\s+/g, "");
	if (NON_ASCII_RE.test(trimmed)) {
		if ([...compact].length < 5) {
			return `Reason for "${op}" is too short ("${trimmed}"). Provide a concrete justification.`;
		}
		return undefined;
	}
	const words = normalized.split(" ").filter(Boolean);
	if (compact.length < 8 || words.length < 2) {
		return `Reason for "${op}" is too brief ("${trimmed}"). Explain why in at least a short phrase.`;
	}
	return undefined;
}

function findCyclePath(nodes: Map<string, DagNodeRecord>, remainingIds: Set<string>): string[] {
	const state = new Map<string, 0 | 1 | 2>();
	const stack: string[] = [];

	const dfs = (id: string): string[] | undefined => {
		state.set(id, 1);
		stack.push(id);
		const record = nodes.get(id);
		for (const dep of record?.task.deps ?? []) {
			if (!remainingIds.has(dep)) continue;
			const st = state.get(dep) ?? 0;
			if (st === 1) {
				const start = stack.indexOf(dep);
				return [...stack.slice(start), dep];
			}
			if (st === 0) {
				const found = dfs(dep);
				if (found) return found;
			}
		}
		stack.pop();
		state.set(id, 2);
		return undefined;
	};

	for (const id of remainingIds) {
		if ((state.get(id) ?? 0) === 0) {
			const found = dfs(id);
			if (found) return found;
		}
	}
	return [...remainingIds];
}

/** Run deterministic Kahn topological sort, layer assignment, and prerequisite readiness checks. */
export function analyzeTodoDag(phases: readonly TodoPhase[]): TodoDagAnalysis {
	const nodes = new Map<string, DagNodeRecord>();
	const dependentsById = new Map<string, string[]>();
	const missingDepErrors: string[] = [];
	let orderIndex = 0;

	for (const phase of phases) {
		for (const task of phase.tasks) {
			const id = task.id ?? `__anon_${orderIndex}`;
			if (!nodes.has(id)) {
				nodes.set(id, { id, task, phase, orderIndex });
				dependentsById.set(id, []);
			}
			orderIndex++;
		}
	}

	const inDegree = new Map<string, number>();
	for (const [id, record] of nodes) {
		const seenDeps = new Set<string>();
		let deg = 0;
		for (const depId of record.task.deps ?? []) {
			if (seenDeps.has(depId)) continue;
			seenDeps.add(depId);
			if (depId === id) {
				missingDepErrors.push(`Task ${id} cannot depend on itself`);
				continue;
			}
			if (!nodes.has(depId)) {
				missingDepErrors.push(`Task ${id} references unknown prerequisite "${depId}"`);
				continue;
			}
			dependentsById.get(depId)!.push(id);
			deg++;
		}
		inDegree.set(id, deg);
	}

	// Deterministic Kahn topological sort ordered by declaration orderIndex.
	const queue: DagNodeRecord[] = [];
	for (const [id, deg] of inDegree) {
		if (deg === 0) queue.push(nodes.get(id)!);
	}
	queue.sort((a, b) => a.orderIndex - b.orderIndex);

	const orderedIds: string[] = [];
	const layerById = new Map<string, number>();

	while (queue.length > 0) {
		const current = queue.shift()!;
		orderedIds.push(current.id);
		let maxParentLayer = -1;
		for (const depId of current.task.deps ?? []) {
			const parentLayer = layerById.get(depId);
			if (parentLayer !== undefined && parentLayer > maxParentLayer) {
				maxParentLayer = parentLayer;
			}
		}
		layerById.set(current.id, maxParentLayer + 1);

		let added = false;
		for (const dependentId of dependentsById.get(current.id) ?? []) {
			const nextDeg = (inDegree.get(dependentId) ?? 0) - 1;
			inDegree.set(dependentId, nextDeg);
			if (nextDeg === 0) {
				queue.push(nodes.get(dependentId)!);
				added = true;
			}
		}
		if (added) queue.sort((a, b) => a.orderIndex - b.orderIndex);
	}

	let cycleError: string | undefined;
	if (orderedIds.length < nodes.size) {
		const visited = new Set(orderedIds);
		const remaining = new Set<string>();
		for (const id of nodes.keys()) {
			if (!visited.has(id)) remaining.add(id);
		}
		const cyclePath = findCyclePath(nodes, remaining);
		cycleError = `Cycle detected in todo DAG: ${cyclePath.join(" -> ")}`;
	}

	const unmetDepsById = new Map<string, TodoItem[]>();
	const readyIds: string[] = [];
	const activeIds: string[] = [];
	const blockedIds: string[] = [];
	let completedCount = 0;
	let abandonedCount = 0;
	let openCount = 0;

	const evalOrder = orderedIds.length === nodes.size ? orderedIds : [...nodes.keys()];
	for (const id of evalOrder) {
		const { task } = nodes.get(id)!;
		if (task.status === "completed") {
			completedCount++;
			continue;
		}
		if (task.status === "abandoned") {
			abandonedCount++;
			continue;
		}
		openCount++;
		const unmet: TodoItem[] = [];
		for (const depId of task.deps ?? []) {
			const dep = nodes.get(depId)?.task;
			if (dep && !isClosedTodo(dep)) {
				unmet.push(dep);
			}
		}
		unmetDepsById.set(id, unmet);
		if (task.status === "in_progress") {
			activeIds.push(id);
		} else if (unmet.length === 0) {
			readyIds.push(id);
		} else {
			blockedIds.push(id);
		}
	}

	return {
		nodes,
		orderedIds,
		layerById,
		dependentsById,
		unmetDepsById,
		readyIds,
		activeIds,
		blockedIds,
		completedCount,
		abandonedCount,
		openCount,
		totalCount: nodes.size,
		cycleError,
		missingDepErrors,
	};
}

/** Validate graph structural invariants (unique IDs/contents, valid deps, acyclic, no closed->open deps). */
function validateAndNormalizeDagState(phases: TodoPhase[], errors: string[]): void {
	const seenIds = new Set<string>();
	const seenContents = new Set<string>();
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (!task.id) {
				errors.push(`Task "${task.content}" is missing a DAG id`);
				continue;
			}
			const idErr = validateTaskIdFormat(task.id);
			if (idErr) errors.push(idErr);
			if (seenIds.has(task.id)) {
				errors.push(`Duplicate task ID "${task.id}"`);
			}
			seenIds.add(task.id);
			if (!task.content.trim()) {
				errors.push(`Task ${task.id} has empty content`);
			}
			if (seenContents.has(task.content)) {
				errors.push(`Duplicate task content "${task.content}"`);
			}
			seenContents.add(task.content);
			// Deduplicate deps while preserving order.
			if (task.deps) {
				task.deps = [...new Set(task.deps)];
			} else {
				task.deps = [];
			}
		}
	}
	if (errors.length > 0) return;

	const analysis = analyzeTodoDag(phases);
	if (analysis.missingDepErrors.length > 0) {
		errors.push(...analysis.missingDepErrors);
		return;
	}
	if (analysis.cycleError) {
		errors.push(analysis.cycleError);
		return;
	}

	// Enforce prerequisite invariants on status:
	// 1) A closed task cannot depend on an open task.
	// 2) An in_progress task whose prerequisite became open (e.g. via insert before) demotes to pending.
	for (const id of analysis.orderedIds) {
		const { task } = analysis.nodes.get(id)!;
		const unmet = (task.deps ?? [])
			.map(depId => analysis.nodes.get(depId)?.task)
			.filter((dep): dep is TodoItem => dep !== undefined && !isClosedTodo(dep));
		if (unmet.length === 0) continue;
		if (isClosedTodo(task)) {
			errors.push(
				`Closed task ${id} ("${task.content}") cannot depend on open prerequisite(s): ${unmet.map(d => d.id).join(", ")}`,
			);
			return;
		}
		if (task.status === "in_progress") {
			task.status = "pending";
		}
	}
}

function resolveRef(
	phases: readonly TodoPhase[],
	ref: string,
): { id: string; task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.id === ref) {
				return { id: task.id, task, phase };
			}
		}
	}
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content === ref) {
				return { id: task.id ?? ref, task, phase };
			}
		}
	}
	return undefined;
}

function resolveRefList(
	phases: readonly TodoPhase[],
	refs: readonly string[] | undefined,
	fieldName: string,
	errors: string[],
): string[] {
	if (!refs || refs.length === 0) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const hit = resolveRef(phases, ref);
		if (!hit) {
			errors.push(`Unknown task "${ref}" in ${fieldName}`);
			continue;
		}
		if (!seen.has(hit.id)) {
			seen.add(hit.id);
			out.push(hit.id);
		}
	}
	return out;
}

function findOrCreatePhase(phases: TodoPhase[], name: string): TodoPhase {
	let phase = phases.find(candidate => candidate.name === name);
	if (!phase) {
		phase = { name, tasks: [] };
		phases.push(phase);
	}
	return phase;
}

function inferDagOp(args: Record<string, unknown>, hasExistingPhases: boolean): TodoOperation | undefined {
	if (Array.isArray(args.nodes) && args.nodes.length > 0) return "init";
	if (Array.isArray(args.list) && args.list.length > 0) return "init";
	if (Array.isArray(args.items) && args.items.length > 0) {
		if (!hasExistingPhases) return "init";
		return "append";
	}
	if ((typeof args.content === "string" && args.content) || Array.isArray(args.after) || Array.isArray(args.before)) {
		if (hasExistingPhases && typeof args.id !== "string") return "insert";
	}
	return undefined;
}

export function resolveDagTodoParams(raw: unknown, hasExistingPhases: boolean): TodoDagParams | string {
	const direct = todoDagSchema(raw);
	if (!(direct instanceof type.errors)) return direct;
	if (isRecord(raw) && raw.op === undefined) {
		const inferred = inferDagOp(raw, hasExistingPhases);
		if (inferred) {
			const repaired = todoDagSchema({ ...raw, op: inferred });
			if (!(repaired instanceof type.errors)) return repaired;
		}
	}
	return `Invalid todo arguments: ${direct.summary}`;
}

function initDagPhases(previousPhases: TodoPhase[], entry: TodoDagParams, errors: string[]): TodoPhase[] {
	const prevAnalysis = analyzeTodoDag(previousPhases);
	if (prevAnalysis.openCount > 0) {
		errors.push(
			"Cannot re-initialize an active DAG while open tasks remain. Use insert, update, drop, or rm with a valid reason to modify the existing graph.",
		);
		return previousPhases;
	}

	const rawNodes: Array<{ id?: string; content: string; phase: string; deps: string[] }> = [];
	if (entry.nodes && entry.nodes.length > 0) {
		for (const node of entry.nodes) {
			rawNodes.push({
				id: node.id,
				content: node.content,
				phase: node.phase || DEFAULT_DAG_PHASE,
				deps: node.deps ? [...node.deps] : [],
			});
		}
	} else if (entry.list && entry.list.length > 0) {
		for (const group of entry.list) {
			const phaseName = group.phase || DEFAULT_DAG_PHASE;
			for (const content of group.items) {
				rawNodes.push({ content, phase: phaseName, deps: [] });
			}
		}
	} else if (entry.items && entry.items.length > 0) {
		const phaseName = entry.phase || DEFAULT_DAG_PHASE;
		for (const content of entry.items) {
			rawNodes.push({ content, phase: phaseName, deps: [] });
		}
	} else {
		errors.push("Missing nodes, list, or items for init operation");
		return previousPhases;
	}

	const phases: TodoPhase[] = [];
	const seenPhases = new Set<string>();
	const reservedIds = new Set<string>();
	const idByContent = new Map<string, string>();
	const declaredIds = new Set<string>();

	if (entry.list && entry.list.length > 0 && !entry.nodes?.length) {
		for (const group of entry.list) {
			const phaseName = group.phase || DEFAULT_DAG_PHASE;
			if (seenPhases.has(phaseName)) {
				errors.push(`Duplicate phase "${phaseName}" in init list`);
			}
			seenPhases.add(phaseName);
		}
	}

	for (const node of rawNodes) {
		if (node.id !== undefined) {
			const fmtErr = validateTaskIdFormat(node.id);
			if (fmtErr) errors.push(fmtErr);
			if (reservedIds.has(node.id)) errors.push(`Duplicate task ID "${node.id}" in init`);
			reservedIds.add(node.id);
			declaredIds.add(node.id);
		}
		if (idByContent.has(node.content)) {
			errors.push(`Duplicate task "${node.content}" in init`);
		} else {
			idByContent.set(node.content, node.id ?? "");
		}
	}
	if (errors.length > 0) return previousPhases;

	// Assign auto-IDs for nodes without explicit IDs.
	for (const node of rawNodes) {
		if (!node.id) {
			node.id = allocateNextDagId(phases, reservedIds);
		}
		idByContent.set(node.content, node.id);
		declaredIds.add(node.id);
	}

	for (const node of rawNodes) {
		const resolvedDeps: string[] = [];
		for (const depRef of node.deps) {
			if (declaredIds.has(depRef)) {
				resolvedDeps.push(depRef);
			} else if (idByContent.has(depRef)) {
				resolvedDeps.push(idByContent.get(depRef)!);
			} else {
				errors.push(`Task ${node.id} references unknown prerequisite "${depRef}"`);
			}
		}
		const phase = findOrCreatePhase(phases, node.phase);
		phase.tasks.push({
			id: node.id,
			content: node.content,
			status: "pending",
			deps: [...new Set(resolvedDeps)],
		});
	}
	if (errors.length > 0) return previousPhases;

	validateAndNormalizeDagState(phases, errors);
	return errors.length > 0 ? previousPhases : phases;
}

function insertDagNode(phases: TodoPhase[], entry: TodoDagParams, errors: string[]): TodoPhase[] {
	const reasonErr = validateDagReason(entry.reason, "insert");
	if (reasonErr) {
		errors.push(reasonErr);
		return phases;
	}
	const content = (entry.content ?? entry.task ?? "").trim();
	if (!content) {
		errors.push("Missing content for insert operation");
		return phases;
	}
	for (const phase of phases) {
		if (phase.tasks.some(t => t.content === content)) {
			errors.push(`Task "${content}" already exists`);
			return phases;
		}
	}

	const afterRefs = [...(entry.deps ?? []), ...(entry.after ?? [])];
	const beforeRefs = [...(entry.before ?? []), ...(entry.blocks ?? [])];
	const afterIds = resolveRefList(phases, afterRefs, "after/deps", errors);
	const beforeIds = resolveRefList(phases, beforeRefs, "before/blocks", errors);
	if (errors.length > 0) return phases;

	const afterSet = new Set(afterIds);
	for (const bId of beforeIds) {
		if (afterSet.has(bId)) {
			errors.push(`Task "${bId}" cannot be in both after/deps and before/blocks (would create a cycle)`);
		}
		const b = resolveRef(phases, bId)!;
		if (isClosedTodo(b.task)) {
			errors.push(`Cannot insert prerequisite before already closed task ${bId} ("${b.task.content}")`);
		}
	}
	if (errors.length > 0) return phases;

	if (entry.phase === "") {
		errors.push("Phase name cannot be empty");
		return phases;
	}

	const reserved = new Set<string>();
	for (const phase of phases) {
		for (const t of phase.tasks) {
			if (t.id) reserved.add(t.id);
		}
	}
	let newId = entry.id;
	if (newId !== undefined) {
		const fmtErr = validateTaskIdFormat(newId);
		if (fmtErr) errors.push(fmtErr);
		if (reserved.has(newId)) errors.push(`Task ID "${newId}" already exists`);
		if (errors.length > 0) return phases;
	} else {
		newId = allocateNextDagId(phases, reserved);
	}

	// Determine target phase: explicit > before[0]'s phase > after[0]'s phase > active/last phase > default.
	let targetPhaseName = entry.phase;
	if (!targetPhaseName && beforeIds.length > 0) {
		targetPhaseName = resolveRef(phases, beforeIds[0])?.phase.name;
	}
	if (!targetPhaseName && afterIds.length > 0) {
		targetPhaseName = resolveRef(phases, afterIds[0])?.phase.name;
	}
	if (!targetPhaseName) {
		const activePhase = phases.find(p => p.tasks.some(t => t.status === "in_progress" || t.status === "pending"));
		targetPhaseName = activePhase?.name ?? phases.at(-1)?.name ?? DEFAULT_DAG_PHASE;
	}

	// Splice edges on `before` targets: if `b` previously depended on an `after` node,
	// rewire `after -> b` into `after -> newId -> b`.
	for (const bId of beforeIds) {
		const b = resolveRef(phases, bId)!.task;
		const existingDeps = b.deps ?? [];
		const nextDeps = existingDeps.filter(dep => !afterSet.has(dep));
		if (!nextDeps.includes(newId)) nextDeps.push(newId);
		b.deps = nextDeps;
		if (b.status === "in_progress") {
			b.status = "pending";
		}
	}

	const newTask: TodoItem = {
		id: newId,
		content,
		status: "pending",
		deps: afterIds,
	};

	const targetPhase = findOrCreatePhase(phases, targetPhaseName);
	// Place at a natural position within targetPhase: before earliest `beforeId` or after latest `afterId`.
	let insertIdx = targetPhase.tasks.length;
	const beforeSet = new Set(beforeIds);
	const earliestBeforeIdx = targetPhase.tasks.findIndex(t => t.id && beforeSet.has(t.id));
	if (earliestBeforeIdx !== -1) {
		insertIdx = earliestBeforeIdx;
	} else if (afterIds.length > 0) {
		let latestAfterIdx = -1;
		for (let i = 0; i < targetPhase.tasks.length; i++) {
			const tid = targetPhase.tasks[i].id;
			if (tid && afterSet.has(tid)) latestAfterIdx = i;
		}
		if (latestAfterIdx !== -1) insertIdx = latestAfterIdx + 1;
	}
	targetPhase.tasks.splice(insertIdx, 0, newTask);

	validateAndNormalizeDagState(phases, errors);
	return phases;
}

function appendDagNodes(phases: TodoPhase[], entry: TodoDagParams, errors: string[]): TodoPhase[] {
	if (entry.phase === "") {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}
	if (phases.some(p => p.tasks.length > 0)) {
		const reasonErr = validateDagReason(entry.reason, "append");
		if (reasonErr) {
			errors.push(reasonErr);
			return phases;
		}
	}

	const seen = new Set<string>();
	for (const content of entry.items) {
		const trimmed = content.trim();
		if (!trimmed) {
			errors.push("Task content cannot be empty");
			continue;
		}
		if (seen.has(trimmed) || phases.some(p => p.tasks.some(t => t.content === trimmed))) {
			errors.push(`Task "${trimmed}" already exists`);
		}
		seen.add(trimmed);
	}
	if (errors.length > 0) return phases;

	const afterRefs = [...(entry.deps ?? []), ...(entry.after ?? [])];
	const beforeRefs = [...(entry.before ?? []), ...(entry.blocks ?? [])];
	const afterIds = resolveRefList(phases, afterRefs, "after/deps", errors);
	const beforeIds = resolveRefList(phases, beforeRefs, "before/blocks", errors);
	if (errors.length > 0) return phases;

	for (const bId of beforeIds) {
		const b = resolveRef(phases, bId)!;
		if (isClosedTodo(b.task)) {
			errors.push(`Cannot append prerequisite before already closed task ${bId} ("${b.task.content}")`);
		}
	}
	if (errors.length > 0) return phases;

	const targetPhaseName =
		entry.phase ??
		phases.find(p => p.tasks.some(t => t.status === "in_progress" || t.status === "pending"))?.name ??
		phases.at(-1)?.name ??
		DEFAULT_DAG_PHASE;
	const targetPhase = findOrCreatePhase(phases, targetPhaseName);

	const reserved = new Set<string>();
	for (const phase of phases) {
		for (const t of phase.tasks) {
			if (t.id) reserved.add(t.id);
		}
	}

	const createdIds: string[] = [];
	for (const rawContent of entry.items) {
		const newId = allocateNextDagId(phases, reserved);
		createdIds.push(newId);
		targetPhase.tasks.push({
			id: newId,
			content: rawContent.trim(),
			status: "pending",
			deps: [...afterIds],
		});
	}

	const afterSet = new Set(afterIds);
	for (const bId of beforeIds) {
		const b = resolveRef(phases, bId)!.task;
		const nextDeps = (b.deps ?? []).filter(dep => !afterSet.has(dep));
		for (const cid of createdIds) {
			if (!nextDeps.includes(cid)) nextDeps.push(cid);
		}
		b.deps = nextDeps;
		if (b.status === "in_progress") b.status = "pending";
	}

	validateAndNormalizeDagState(phases, errors);
	return phases;
}

function updateDagNode(phases: TodoPhase[], entry: TodoDagParams, errors: string[]): TodoPhase[] {
	const reasonErr = validateDagReason(entry.reason, "update");
	if (reasonErr) {
		errors.push(reasonErr);
		return phases;
	}
	const ref = entry.id ?? entry.task;
	if (!ref) {
		errors.push("Missing task id or task content for update operation");
		return phases;
	}
	const hit = resolveRef(phases, ref);
	if (!hit) {
		errors.push(`Task "${ref}" not found`);
		return phases;
	}

	const hasContentUpdate = entry.content !== undefined;
	const hasPhaseUpdate = entry.phase !== undefined;
	const hasDepsReplace = entry.deps !== undefined;
	const hasDepsDelta = (entry.addDeps?.length ?? 0) > 0 || (entry.removeDeps?.length ?? 0) > 0;
	if (!hasContentUpdate && !hasPhaseUpdate && !hasDepsReplace && !hasDepsDelta) {
		errors.push("update requires at least one of content, phase, deps, addDeps, or removeDeps");
		return phases;
	}
	if (hasDepsReplace && hasDepsDelta) {
		errors.push("Cannot combine deps with addDeps/removeDeps in a single update");
		return phases;
	}

	if (hasContentUpdate) {
		const nextContent = entry.content!.trim();
		if (!nextContent) {
			errors.push("Task content cannot be empty");
			return phases;
		}
		if (
			nextContent !== hit.task.content &&
			phases.some(p => p.tasks.some(t => t !== hit.task && t.content === nextContent))
		) {
			errors.push(`Task "${nextContent}" already exists`);
			return phases;
		}
		hit.task.content = nextContent;
	}

	if (hasPhaseUpdate) {
		if (!entry.phase) {
			errors.push("Phase name cannot be empty");
			return phases;
		}
		if (entry.phase !== hit.phase.name) {
			hit.phase.tasks = hit.phase.tasks.filter(t => t !== hit.task);
			const dest = findOrCreatePhase(phases, entry.phase);
			dest.tasks.push(hit.task);
		}
	}

	if (hasDepsReplace) {
		const nextDeps = resolveRefList(phases, entry.deps, "deps", errors);
		if (errors.length > 0) return phases;
		hit.task.deps = nextDeps;
	} else if (hasDepsDelta) {
		const addIds = resolveRefList(phases, entry.addDeps, "addDeps", errors);
		const removeIds = new Set(resolveRefList(phases, entry.removeDeps, "removeDeps", errors));
		if (errors.length > 0) return phases;
		const nextDeps = (hit.task.deps ?? []).filter(dep => !removeIds.has(dep));
		for (const addId of addIds) {
			if (!nextDeps.includes(addId)) nextDeps.push(addId);
		}
		hit.task.deps = nextDeps;
	}

	validateAndNormalizeDagState(phases, errors);
	return phases;
}

function collectTargetRefs(entry: TodoDagParams): string[] {
	const refs: string[] = [];
	if (entry.id) refs.push(entry.id);
	if (entry.ids) refs.push(...entry.ids);
	if (entry.task && entry.task !== entry.id) refs.push(entry.task);
	return [...new Set(refs)];
}

function startDagTasks(phases: TodoPhase[], entry: TodoDagParams, errors: string[]): TodoPhase[] {
	const refs = collectTargetRefs(entry);
	if (refs.length === 0) {
		errors.push("Missing task id or task content for start operation");
		return phases;
	}
	const analysis = analyzeTodoDag(phases);
	const targets: DagNodeRecord[] = [];
	for (const ref of refs) {
		const hit = resolveRef(phases, ref);
		if (!hit) {
			errors.push(`Task "${ref}" not found`);
			continue;
		}
		const record = analysis.nodes.get(hit.id)!;
		if (isClosedTodo(record.task)) {
			errors.push(`Cannot start already closed task ${record.id} ("${record.task.content}")`);
			continue;
		}
		const unmet = analysis.unmetDepsById.get(record.id) ?? [];
		if (unmet.length > 0) {
			const unmetStr = unmet.map(d => `${d.id} "${d.content}" [${d.status}]`).join(", ");
			errors.push(
				`Cannot start ${record.id} ("${record.task.content}"): blocked by unmet prerequisites: ${unmetStr}`,
			);
			continue;
		}
		targets.push(record);
	}
	if (errors.length > 0) return phases;
	for (const target of targets) {
		target.task.status = "in_progress";
	}
	return phases;
}

function doneDagTasks(phases: TodoPhase[], entry: TodoDagParams, errors: string[]): TodoPhase[] {
	const refs = collectTargetRefs(entry);
	if (refs.length === 0) {
		errors.push("Missing task id or task content for done operation (must specify exact task in DAG mode)");
		return phases;
	}
	const analysis = analyzeTodoDag(phases);
	const targets: DagNodeRecord[] = [];
	for (const ref of refs) {
		const hit = resolveRef(phases, ref);
		if (!hit) {
			errors.push(`Task "${ref}" not found`);
			continue;
		}
		const record = analysis.nodes.get(hit.id)!;
		if (record.task.status === "abandoned") {
			errors.push(`Cannot mark dropped task ${record.id} ("${record.task.content}") as completed`);
			continue;
		}
		const unmet = analysis.unmetDepsById.get(record.id) ?? [];
		if (unmet.length > 0) {
			const unmetStr = unmet.map(d => `${d.id} "${d.content}" [${d.status}]`).join(", ");
			errors.push(
				`Cannot complete ${record.id} ("${record.task.content}"): blocked by unmet prerequisites: ${unmetStr}`,
			);
			continue;
		}
		targets.push(record);
	}
	if (errors.length > 0) return phases;
	for (const target of targets) {
		target.task.status = "completed";
	}
	return phases;
}

function checkAntiEvasionForRemoval(
	phases: TodoPhase[],
	target: { id: string; task: TodoItem },
	op: "rm" | "drop",
	removedCount: number,
	errors: string[],
): boolean {
	if (target.task.status === "completed") {
		errors.push(`Cannot ${op} already completed task ${target.id} ("${target.task.content}")`);
		return false;
	}
	if (op === "drop" && target.task.status === "abandoned") {
		errors.push(`Task ${target.id} ("${target.task.content}") is already dropped`);
		return false;
	}
	const analysis = analyzeTodoDag(phases);
	if (op === "rm" && analysis.totalCount <= 1) {
		errors.push("Cannot remove the last remaining task from the DAG.");
		return false;
	}
	if (!isClosedTodo(target.task)) {
		const openAfter = analysis.openCount - 1;
		const settledWithoutCompletionAfter = analysis.abandonedCount + removedCount + 1;
		if (openAfter === 0 && analysis.completedCount === 0) {
			errors.push(
				`Cannot ${op} the final open task ${target.id} when no tasks have been completed. Complete the work or explain why the task is blocked.`,
			);
			return false;
		}
		if (openAfter === 0 && settledWithoutCompletionAfter > analysis.completedCount) {
			errors.push(
				`Cannot ${op} ${target.id}: closing out the DAG would leave ${settledWithoutCompletionAfter} dropped/removed task(s) vs only ${analysis.completedCount} completed. Finish the remaining tasks instead of pruning them.`,
			);
			return false;
		}
		if (
			analysis.completedCount === 0 &&
			settledWithoutCompletionAfter > Math.max(1, Math.floor((analysis.totalCount + removedCount) / 2))
		) {
			errors.push(
				`Cannot ${op} ${target.id}: too many open tasks removed/dropped (${settledWithoutCompletionAfter}) without completing any tasks.`,
			);
			return false;
		}
	}
	return true;
}

function dropDagTask(phases: TodoPhase[], entry: TodoDagParams, removedCount: number, errors: string[]): TodoPhase[] {
	const reasonErr = validateDagReason(entry.reason, "drop");
	if (reasonErr) {
		errors.push(reasonErr);
		return phases;
	}
	const ref = entry.id ?? entry.task;
	if (!ref) {
		errors.push("drop in DAG mode requires a specific task id or content (bulk drop is not allowed)");
		return phases;
	}
	const hit = resolveRef(phases, ref);
	if (!hit) {
		errors.push(`Task "${ref}" not found`);
		return phases;
	}
	if (!checkAntiEvasionForRemoval(phases, hit, "drop", removedCount, errors)) {
		return phases;
	}
	hit.task.status = "abandoned";
	hit.task.reason = entry.reason!.trim();
	return phases;
}

function removeDagTask(
	phases: TodoPhase[],
	entry: TodoDagParams,
	removedCount: number,
	errors: string[],
): { phases: TodoPhase[]; removedDelta: number } {
	const reasonErr = validateDagReason(entry.reason, "rm");
	if (reasonErr) {
		errors.push(reasonErr);
		return { phases, removedDelta: 0 };
	}
	const ref = entry.id ?? entry.task;
	if (!ref) {
		errors.push("rm in DAG mode requires a specific task id or content (bulk removal is not allowed)");
		return { phases, removedDelta: 0 };
	}
	const hit = resolveRef(phases, ref);
	if (!hit) {
		errors.push(`Task "${ref}" not found`);
		return { phases, removedDelta: 0 };
	}
	if (!checkAntiEvasionForRemoval(phases, hit, "rm", removedCount, errors)) {
		return { phases, removedDelta: 0 };
	}

	// Bridge deleted node's prerequisites onto its dependents so transitive ordering survives.
	const inheritedDeps = hit.task.deps ?? [];
	for (const phase of phases) {
		for (const candidate of phase.tasks) {
			if (candidate === hit.task || !candidate.deps?.includes(hit.id)) continue;
			const nextDeps: string[] = [];
			for (const dep of candidate.deps) {
				if (dep === hit.id) {
					for (const inherited of inheritedDeps) {
						if (inherited !== candidate.id && !nextDeps.includes(inherited)) {
							nextDeps.push(inherited);
						}
					}
				} else if (!nextDeps.includes(dep)) {
					nextDeps.push(dep);
				}
			}
			candidate.deps = nextDeps;
		}
	}

	hit.phase.tasks = hit.phase.tasks.filter(candidate => candidate !== hit.task);
	const nonEmptyPhases = phases.filter(phase => phase.tasks.length > 0);
	validateAndNormalizeDagState(nonEmptyPhases, errors);
	return { phases: nonEmptyPhases, removedDelta: errors.length === 0 ? 1 : 0 };
}

export function applyDagParams(
	previousPhases: TodoPhase[],
	params: TodoDagParams,
	removedCount: number,
): { phases: TodoPhase[]; errors: string[]; removedCount: number } {
	const errors: string[] = [];
	const working = normalizePhasesForDag(cloneTodoPhases(previousPhases));
	let nextPhases = working;
	let nextRemovedCount = removedCount;

	switch (params.op) {
		case "init": {
			nextPhases = initDagPhases(working, params, errors);
			if (errors.length === 0) nextRemovedCount = 0;
			break;
		}
		case "insert": {
			nextPhases = insertDagNode(working, params, errors);
			break;
		}
		case "append": {
			nextPhases = appendDagNodes(working, params, errors);
			break;
		}
		case "update": {
			nextPhases = updateDagNode(working, params, errors);
			break;
		}
		case "start": {
			nextPhases = startDagTasks(working, params, errors);
			break;
		}
		case "done": {
			nextPhases = doneDagTasks(working, params, errors);
			break;
		}
		case "drop": {
			nextPhases = dropDagTask(working, params, removedCount, errors);
			break;
		}
		case "rm": {
			const res = removeDagTask(working, params, removedCount, errors);
			nextPhases = res.phases;
			nextRemovedCount = removedCount + res.removedDelta;
			break;
		}
		case "view": {
			break;
		}
	}

	return {
		phases: errors.length > 0 ? previousPhases : nextPhases,
		errors,
		removedCount: errors.length > 0 ? removedCount : nextRemovedCount,
	};
}

/** Format topological schedule, unlocked ready frontier, and unmet prerequisites for the agent. */
export function formatDagSummary(
	phases: readonly TodoPhase[],
	errors: readonly string[],
	readOnly = false,
	actionNote?: string,
): string {
	const normalized = normalizePhasesForDag(cloneTodoPhases(phases));
	const analysis = analyzeTodoDag(normalized);
	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (actionNote && errors.length === 0) lines.push(actionNote);

	if (analysis.totalCount === 0) {
		if (errors.length > 0) return lines.join("\n");
		return readOnly ? "Todo DAG is empty." : "Todo DAG cleared.";
	}

	const closed = analysis.completedCount + analysis.abandonedCount;
	lines.push(
		`Overall (DAG): ${closed}/${analysis.totalCount} done (${analysis.completedCount} completed, ${analysis.abandonedCount} dropped), ${analysis.activeIds.length} in_progress, ${analysis.readyIds.length} ready, ${analysis.blockedIds.length} blocked.`,
	);

	if (analysis.openCount === 0) {
		lines.push("Remaining items: none.");
	} else {
		if (analysis.activeIds.length > 0) {
			lines.push(`In progress (${analysis.activeIds.length}):`);
			for (const id of analysis.activeIds) {
				const rec = analysis.nodes.get(id)!;
				const depsTag = rec.task.deps?.length ? ` (after: ${rec.task.deps.join(", ")})` : "";
				lines.push(`  - [${id}] ${rec.task.content} (${rec.phase.name})${depsTag}`);
			}
		}

		if (analysis.readyIds.length > 0) {
			lines.push(`Ready to start — all prerequisites satisfied (${analysis.readyIds.length}):`);
			for (const id of analysis.readyIds) {
				const rec = analysis.nodes.get(id)!;
				const depsTag = rec.task.deps?.length ? ` [after: ${rec.task.deps.join(", ")}]` : " [root]";
				lines.push(`  - [${id}] ${rec.task.content} (${rec.phase.name})${depsTag}`);
			}
			lines.push('Choose which ready task(s) to execute and call `todo` with `op: "start"` and `id` (or `ids`).');
		} else if (analysis.activeIds.length > 0) {
			lines.push("Ready to start: none (downstream tasks are waiting on the in-progress task(s) above).");
		}

		if (analysis.blockedIds.length > 0) {
			lines.push(`Blocked by unmet prerequisites (${analysis.blockedIds.length}):`);
			for (const id of analysis.blockedIds) {
				const rec = analysis.nodes.get(id)!;
				const unmet = analysis.unmetDepsById.get(id) ?? [];
				const unmetText = unmet.map(d => `${d.id} [${d.status}]`).join(", ");
				lines.push(`  - [${id}] ${rec.task.content} (${rec.phase.name}) <- blocked by: ${unmetText}`);
			}
		}
	}

	// Render topological waves so the agent sees the full dependency structure.
	const maxLayer = Math.max(0, ...analysis.layerById.values());
	lines.push("Topological layers:");
	for (let layer = 0; layer <= maxLayer; layer++) {
		const idsInLayer = analysis.orderedIds.filter(id => analysis.layerById.get(id) === layer);
		if (idsInLayer.length === 0) continue;
		lines.push(`  Layer ${layer + 1}:`);
		for (const id of idsInLayer) {
			const rec = analysis.nodes.get(id)!;
			const t = rec.task;
			const checkbox =
				t.status === "completed"
					? "[X]"
					: t.status === "in_progress"
						? "[/]"
						: t.status === "abandoned"
							? "[-]"
							: (analysis.unmetDepsById.get(id)?.length ?? 0) === 0
								? "[ ]"
								: "[!]";
			const depsStr = t.deps?.length ? ` deps:[${t.deps.join(",")}]` : "";
			const reasonStr = t.reason ? ` reason:"${t.reason}"` : "";
			const statusTag =
				t.status === "in_progress"
					? " (in_progress)"
					: t.status === "abandoned"
						? " (dropped)"
						: t.status === "pending" && (analysis.unmetDepsById.get(id)?.length ?? 0) === 0
							? " (ready)"
							: t.status === "pending"
								? " (blocked)"
								: "";
			lines.push(`    - ${checkbox} [${id}] ${t.content} (${rec.phase.name})${statusTag}${depsStr}${reasonStr}`);
		}
	}

	return lines.join("\n");
}
