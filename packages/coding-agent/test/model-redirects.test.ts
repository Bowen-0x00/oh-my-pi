import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { resolveModelRedirect } from "@oh-my-pi/pi-coding-agent/config/model-redirects";
import { validateModelRedirects } from "@oh-my-pi/pi-coding-agent/config/model-redirects-schema";
import { cfgModelRedirects } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function model(provider: string, id: string, metadata: Partial<Model> = {}): Model {
	return { provider, id, ...metadata } as Model;
}

const source = model("source", "model");
const target = model("target", "org/model:high", {
	baseUrl: "https://target.invalid/v1",
	contextWindow: 321_000,
	maxTokens: 12_345,
	reasoning: true,
});
const otherTarget = model("target", "other");

function registry(models: Model[] = [target, otherTarget]) {
	return {
		find: vi.fn((provider: string, id: string) =>
			models.find(model => model.provider === provider && model.id === id),
		),
		hasConfiguredAuth: vi.fn((_model: Model) => true),
		getApiKey: vi.fn(() => {
			throw new Error("Redirect configuration must not resolve credentials");
		}),
	};
}

function commandHarness(settings = Settings.isolated()) {
	const modelRegistry = registry();
	const output = vi.fn();
	const notifyConfigChanged = vi.fn();
	const abort = vi.fn();
	const setModel = vi.fn();
	const session = { modelRegistry, isStreaming: true, abort, setModel } as unknown as AgentSession;
	const runtime = { settings, session, output, notifyConfigChanged } as unknown as SlashCommandRuntime;
	return { settings, modelRegistry, output, notifyConfigChanged, abort, setModel, session, runtime };
}

afterEach(() => vi.restoreAllMocks());

describe("exact model redirects", () => {
	it("does nothing when unset or when only a different source spelling is configured", () => {
		const lookup = registry();
		expect(resolveModelRedirect(source, {}, lookup)).toBeUndefined();
		expect(resolveModelRedirect(source, { "SOURCE/model": "target/other" }, lookup)).toBeUndefined();
		expect(resolveModelRedirect(source, { "source/mod": "target/other" }, lookup)).toBeUndefined();
		expect(lookup.find).not.toHaveBeenCalled();
		expect(lookup.getApiKey).not.toHaveBeenCalled();
	});

	it("returns the catalog object with all metadata and follows exactly one hop", () => {
		const lookup = registry();
		const resolved = resolveModelRedirect(
			source,
			{ "source/model": "target/org/model:high", "target/org/model:high": "target/other" },
			lookup,
		);
		expect(resolved).toBe(target);
		expect(lookup.find.mock.calls).toEqual([["target", "org/model:high"]]);
		expect(lookup.getApiKey).not.toHaveBeenCalled();
	});

	it("preserves literal colon and slash suffixes in the source as well", () => {
		const lookup = registry();
		expect(resolveModelRedirect(target, { "target/org/model:high": "target/other" }, lookup)).toBe(otherTarget);
		expect(lookup.find.mock.calls).toEqual([["target", "other"]]);
	});

	it("fails closed for missing, non-chat, or alias-resolved targets", () => {
		expect(() => resolveModelRedirect(source, { "source/model": "target/missing" }, registry())).toThrow("not found");
		const embedding = model("target", "embedding", { kind: "embedding" });
		expect(() => resolveModelRedirect(source, { "source/model": "target/embedding" }, registry([embedding]))).toThrow(
			"not a chat model",
		);
		const aliases = { find: vi.fn(() => target) };
		expect(() => resolveModelRedirect(source, { "source/model": "target/org/model" }, aliases)).toThrow("not found");
	});

	it("rejects malformed mappings and self redirects without requiring a live source catalog", () => {
		for (const invalid of [
			[],
			"source/model",
			{ "source/model": 123 },
			{ "source/model": "target/" },
			{ "source/": "target/other" },
			{ "@smol": "target/other" },
			{ "source/*": "target/other" },
			{ "source/model": "target/{one,two}" },
			{ "source/model": "target/has space" },
			{ "source/model": "source/model" },
		]) {
			expect(() => validateModelRedirects(invalid)).toThrow();
		}
	});
});

describe("/redirect", () => {
	it("adds, replaces and removes one global mapping while retaining others", async () => {
		const h = commandHarness();
		cfgModelRedirects.set(h.settings, { "keep/model": "target/other" });
		await executeAcpBuiltinSlashCommand("/redirect source/model target/org/model:high", h.runtime);
		expect(h.settings.getGlobalSettings().modelRedirects).toEqual({
			"keep/model": "target/other",
			"source/model": "target/org/model:high",
		});
		await executeAcpBuiltinSlashCommand("/redirect source/model target/other", h.runtime);
		expect(cfgModelRedirects.get(h.settings)["source/model"]).toBe("target/other");
		await executeAcpBuiltinSlashCommand("/redirect off source/model", h.runtime);
		expect(h.settings.getGlobalSettings().modelRedirects).toEqual({ "keep/model": "target/other" });
		expect(h.notifyConfigChanged).toHaveBeenCalledTimes(3);
		expect(h.modelRegistry.find.mock.calls).toEqual([
			["target", "org/model:high"],
			["target", "other"],
		]);
		expect(h.modelRegistry.hasConfiguredAuth.mock.calls).toEqual([[target], [otherTarget]]);
		expect(h.modelRegistry.getApiKey).not.toHaveBeenCalled();
		expect(h.abort).not.toHaveBeenCalled();
		expect(h.setModel).not.toHaveBeenCalled();
	});

	it("lists effective mappings and leaves both listing and missing removal unchanged", async () => {
		const h = commandHarness();
		cfgModelRedirects.set(h.settings, { "keep/model": "target/other" });
		const before = h.settings.getGlobalSettings();
		await executeAcpBuiltinSlashCommand("/redirect", h.runtime);
		expect(h.output.mock.calls[0]?.[0]).toContain("keep/model → target/other");
		await executeAcpBuiltinSlashCommand("/redirect off source/model", h.runtime);
		expect(h.settings.getGlobalSettings()).toEqual(before);
		expect(h.notifyConfigChanged).not.toHaveBeenCalled();
		expect(h.modelRegistry.find).not.toHaveBeenCalled();
	});

	it("rejects invalid selectors, unknown targets, aliases and non-chat targets before any write", async () => {
		const h = commandHarness();
		cfgModelRedirects.set(h.settings, { "keep/model": "target/other" });
		const before = h.settings.getGlobalSettings();
		const flush = vi.spyOn(h.settings, "flush");
		for (const args of [
			"@smol target/other",
			"source/* target/other",
			"source/model target/missing",
			"source/model target/org/model",
			"source/model source/model",
			"off source/",
			"source/model target/other extra",
		]) {
			expect(await executeAcpBuiltinSlashCommand(`/redirect ${args}`, h.runtime)).toEqual({
				consumed: true,
				failed: true,
			});
			expect(h.settings.getGlobalSettings()).toEqual(before);
		}
		h.modelRegistry.find.mockReturnValue(model("target", "embedding", { kind: "embedding" }));
		expect(await executeAcpBuiltinSlashCommand("/redirect source/model target/embedding", h.runtime)).toEqual({
			consumed: true,
			failed: true,
		});
		expect(h.settings.getGlobalSettings()).toEqual(before);
		expect(flush).not.toHaveBeenCalled();
		expect(h.notifyConfigChanged).not.toHaveBeenCalled();
	});

	it("rejects an unauthenticated target without authenticating the source or changing mappings", async () => {
		const h = commandHarness();
		cfgModelRedirects.set(h.settings, { "keep/model": "target/other" });
		const before = h.settings.getGlobalSettings();
		h.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
		const flush = vi.spyOn(h.settings, "flush");
		expect(await executeAcpBuiltinSlashCommand("/redirect source/model target/other", h.runtime)).toEqual({
			consumed: true,
			failed: true,
		});
		expect(h.settings.getGlobalSettings()).toEqual(before);
		expect(h.modelRegistry.hasConfiguredAuth.mock.calls).toEqual([[otherTarget]]);
		expect(h.modelRegistry.getApiKey).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
		expect(h.notifyConfigChanged).not.toHaveBeenCalled();
	});

	it("does not announce or notify success until persistence completes", async () => {
		const h = commandHarness();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		vi.spyOn(h.settings, "flush").mockImplementation(async () => {
			entered.resolve();
			await gate.promise;
		});
		const pending = executeAcpBuiltinSlashCommand("/redirect source/model target/other", h.runtime);
		await entered.promise;
		expect(h.output).not.toHaveBeenCalled();
		expect(h.notifyConfigChanged).not.toHaveBeenCalled();
		gate.resolve();
		await pending;
		expect(h.output).toHaveBeenCalledTimes(1);
		expect(h.notifyConfigChanged).toHaveBeenCalledTimes(1);
	});

	it("reports persistence failures instead of success", async () => {
		const h = commandHarness();
		vi.spyOn(h.settings, "flush").mockRejectedValue(new Error("disk full"));
		expect(await executeAcpBuiltinSlashCommand("/redirect source/model target/other", h.runtime)).toEqual({
			consumed: true,
			failed: true,
		});
		expect(h.output.mock.calls[0]?.[0]).toContain("disk full");
		expect(h.notifyConfigChanged).not.toHaveBeenCalled();
	});

	it("persists only global mappings and reports higher-precedence effective redirects", async () => {
		const h = commandHarness(Settings.isolated({ modelRedirects: { "source/model": "target/org/model:high" } }));
		await executeAcpBuiltinSlashCommand("/redirect source/model target/other", h.runtime);
		expect(h.settings.getGlobalSettings().modelRedirects).toEqual({ "source/model": "target/other" });
		expect(cfgModelRedirects.get(h.settings)["source/model"]).toBe("target/org/model:high");
		expect(h.output.mock.calls[0]?.[0]).toContain("target/org/model:high");
		await executeAcpBuiltinSlashCommand("/redirect off source/model", h.runtime);
		expect(h.settings.getGlobalSettings().modelRedirects).toEqual({});
		expect(h.output.mock.calls[1]?.[0]).toContain("target/org/model:high");
	});

	it("allows TUI updates while streaming without stopping or switching the active model", async () => {
		const h = commandHarness();
		const setText = vi.fn();
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const ctx = {
			settings: h.settings,
			session: h.session,
			editor: { setText },
			showStatus,
			showWarning,
		} as unknown as InteractiveModeContext;
		expect(await executeBuiltinSlashCommand("/redirect source/model target/other", { ctx })).toBe(true);
		expect(cfgModelRedirects.get(h.settings)["source/model"]).toBe("target/other");
		expect(showStatus).toHaveBeenCalledTimes(1);
		expect(showWarning).not.toHaveBeenCalled();
		expect(setText).toHaveBeenCalledWith("");
		expect(h.abort).not.toHaveBeenCalled();
		expect(h.setModel).not.toHaveBeenCalled();
		expect(h.modelRegistry.getApiKey).not.toHaveBeenCalled();
	});
});
