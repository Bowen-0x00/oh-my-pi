import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { VALUELESS_FLAGS } from "@oh-my-pi/pi-coding-agent/cli/flag-tables";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgTodoDag } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

describe("CLI --todo-dag flag parsing and restart persistence", () => {
	let tempRoot = "";

	afterEach(async () => {
		if (tempRoot) await removeWithRetries(tempRoot);
		tempRoot = "";
	});

	it("parses --todo-dag and --no-todo-dag as valueless launch flags and rejects combining them", () => {
		expect(VALUELESS_FLAGS.has("--todo-dag")).toBe(true);
		expect(VALUELESS_FLAGS.has("--no-todo-dag")).toBe(true);

		expect(parseArgs(["--todo-dag"]).todoDag).toBe(true);
		expect(parseArgs(["--no-todo-dag"]).noTodoDag).toBe(true);
		expect(() => parseArgs(["--todo-dag", "--no-todo-dag"])).toThrow(
			"--no-todo-dag cannot be combined with --todo-dag",
		);
	});

	it("persists --todo-dag across restarts even when subsequent launches omit the flag", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-todo-dag-persist-"));
		const agentDir = path.join(tempRoot, "agent");
		const cwd = path.join(tempRoot, "project");
		await fs.mkdir(cwd, { recursive: true });

		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);

		try {
			// Launch 1: default without --todo-dag -> todo.dag is false.
			const initialSettings = await Settings.loadIsolated({ cwd, agentDir });
			expect(cfgTodoDag.get(initialSettings)).toBe(false);

			// Launch 2: started with --todo-dag -> persists todo.dag = true.
			await buildSessionOptions(
				parseArgs(["--todo-dag"]),
				[],
				SessionManager.inMemory(),
				modelRegistry,
				initialSettings,
			);
			await initialSettings.flush();
			initialSettings.cancelPendingSaves();

			// Launch 3 (fresh process/restart): no --todo-dag passed -> recognizes prior --todo-dag launch!
			const restartedSettings = await Settings.loadIsolated({ cwd, agentDir });
			expect(cfgTodoDag.get(restartedSettings)).toBe(true);

			// Launch 4: started with --no-todo-dag -> reverts todo.dag = false persistently.
			await buildSessionOptions(
				parseArgs(["--no-todo-dag"]),
				[],
				SessionManager.inMemory(),
				modelRegistry,
				restartedSettings,
			);
			await restartedSettings.flush();
			restartedSettings.cancelPendingSaves();

			const finalSettings = await Settings.loadIsolated({ cwd, agentDir });
			expect(cfgTodoDag.get(finalSettings)).toBe(false);
			finalSettings.cancelPendingSaves();
		} finally {
			authStorage.close();
		}
	});
});
