import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgModelRedirects } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const selector = (model: Model) => `${model.provider}/${model.id}`;
const source = getBundledModel("google-antigravity", "gemini-4-argon")!;
const target = getBundledModel("openai", "gpt-4o-mini")!;
const alternate = getBundledModel("anthropic", "claude-sonnet-4-5")!;

// Exercise the real session admission and per-step request boundary, not a model-picker copy.
describe("explicit session model redirects", () => {
	let directory: TempDir;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		await initTheme();
		directory = TempDir.createSync("@pi-model-redirect-");
		auth = await AuthStorage.create(directory.join("auth.db"));
		auth.keys.setRuntime(target.provider, "target-test-key");
		auth.keys.setRuntime(alternate.provider, "alternate-test-key");
		registry = new ModelRegistry(auth, directory.join("models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		auth.close();
		directory.removeSync();
	});

	function makeSession(settings: Settings, requests: string[], tools: AgentTool[] = []): AgentSession {
		const mock = createMockModel();
		const agent = new Agent({
			initialState: { model: source, systemPrompt: ["Test"], tools, messages: [] },
			getApiKey: model => `${model.provider}-test-key`,
			streamFn: (model, context, options) => {
				requests.push(selector(model));
				mock.push(
					tools.length > 0 && requests.length === 1
						? { content: [{ type: "toolCall", id: "reroute-call", name: "reroute", arguments: {} }] }
						: { content: ["The requested work is complete."] },
				);
				return mock.stream(model, context, options);
			},
		});
		session = new AgentSession({
			agent,
			settings,
			modelRegistry: registry,
			sessionManager: SessionManager.inMemory(),
		});
		return session;
	}

	const settingsFor = (redirects: Record<string, string> = {}) =>
		Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			modelRedirects: redirects,
		});

	it("does not resolve source credentials or request it when explicitly redirected", async () => {
		const requests: string[] = [];
		const settings = settingsFor({ [selector(source)]: selector(target) });
		const keyRequests: string[] = [];
		const original = registry.getApiKey.bind(registry);
		const keys = spyOn(registry, "getApiKey").mockImplementation((model, ...args) => {
			keyRequests.push(selector(model));
			if (model.provider === source.provider) throw new Error("Original provider must not be contacted");
			return original(model, ...args);
		});
		try {
			await makeSession(settings, requests).prompt("Continue the long task");
			await session!.waitForIdle();
			expect(requests).toEqual([selector(target)]);
			expect(keyRequests).toEqual([selector(target)]);
			expect(session!.model?.provider).toBe(target.provider);
			expect(session!.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		} finally {
			keys.mockRestore();
		}
	});

	it("keeps the original selection through live retargeting and restores it when the redirect is removed", async () => {
		auth.keys.setRuntime(source.provider, "source-test-key");
		const requests: string[] = [];
		const settings = settingsFor();
		const current = makeSession(settings, requests);
		await current.prompt("Normal request");
		cfgModelRedirects.override(settings, { [selector(source)]: selector(target) });
		await current.prompt("Redirected request");
		cfgModelRedirects.override(settings, {
			[selector(source)]: selector(alternate),
			[selector(alternate)]: selector(target),
		});
		await current.prompt("Retargeted request");
		cfgModelRedirects.override(settings, {});
		await current.prompt("Original route restored");
		expect(requests).toEqual([selector(source), selector(target), selector(alternate), selector(source)]);
	});

	it("applies an explicit route at the next tool-loop request without restarting the agent", async () => {
		auth.keys.setRuntime(source.provider, "source-test-key");
		const requests: string[] = [];
		const settings = settingsFor();
		const tool: AgentTool = {
			name: "reroute",
			label: "Reroute",
			description: "Apply the operator's next route",
			parameters: type({}),
			async execute() {
				cfgModelRedirects.override(settings, { [selector(source)]: selector(target) });
				return { content: [{ type: "text", text: "Route updated" }] };
			},
		};
		await makeSession(settings, requests, [tool]).prompt("Continue after updating the route");
		await session!.waitForIdle();
		expect(requests).toEqual([selector(source), selector(target)]);
		expect(session!.model?.provider).toBe(target.provider);
	});

	it("rejects an unavailable target without sending the request to the original provider", async () => {
		auth.keys.setRuntime(source.provider, "source-test-key");
		const requests: string[] = [];
		const settings = settingsFor({ [selector(source)]: "missing-provider/missing-model" });
		await expect(makeSession(settings, requests).prompt("Do not bypass the redirect")).rejects.toThrow(/redirect/i);
		expect(requests).toEqual([]);
	});

	it("rejects a target without credentials instead of falling back to the original provider", async () => {
		auth.keys.setRuntime(source.provider, "source-test-key");
		const requests: string[] = [];
		const unconfigured = getBundledModel("xai-oauth", "grok-4.7")!;
		if (!unconfigured) throw new Error("Expected unconfigured target fixture");
		const settings = settingsFor({ [selector(source)]: selector(unconfigured) });
		await expect(makeSession(settings, requests).prompt("Do not bypass the redirect")).rejects.toThrow(/credential/);
		expect(requests).toEqual([]);
	});

	it("restores the source selection from a redirected transcript so cold resume can honor a removed route", async () => {
		const requests: string[] = [];
		const settings = settingsFor({ [selector(source)]: selector(target) });
		const current = makeSession(settings, requests);
		current.sessionManager.appendModelChange(selector(source));
		await current.prompt("Use the redirect");
		const context = current.sessionManager.buildSessionContext();
		expect(getRestorableSessionModels(context.models, current.sessionManager.getLastModelChangeRole())).toEqual([
			selector(source),
		]);
		const changes = current.sessionManager.getBranch().filter(entry => entry.type === "model_change");
		expect(changes.at(-1)).toMatchObject({ model: selector(target), redirectedFrom: selector(source) });
	});
});
