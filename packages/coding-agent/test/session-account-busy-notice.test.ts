import { afterEach, describe, expect, it, vi } from "bun:test";
import { registerCustomApi, streamSimple, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "../src/config/settings";
import {
	createSettingsAwareStreamFn,
	withAccountBusyNotice,
	withAuthRetryNotice,
} from "../src/session/settings-stream-fn";
import { runPrintMode } from "../src/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "../src/session/agent-session";

const SOURCE = "session-account-busy-notice";
const API = "session-account-busy-notice" as Api;
const model = {
	id: "notice-test",
	name: "Notice test",
	api: API,
	provider: "notice-provider",
	contextWindow: 10000,
	maxTokens: 100,
} as Model<Api>;
const context: Context = { systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function complete(): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: API,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
	return stream;
}

describe("session account-busy notices", () => {
	afterEach(() => {
		unregisterCustomApis(SOURCE);
		vi.restoreAllMocks();
	});

	for (const reason of ["all-busy", "pinned"] as const) {
		it(`delivers a visible ${reason} warning and keeps the caller hook without blocking dispatch`, async () => {
			const notices: Array<{ level: string; message: string }> = [];
			const callerEvents: string[] = [];
			const sent: string[] = [];
			const notify = (level: "info" | "warning" | "error", message: string) => notices.push({ level, message });
			registerCustomApi(
				API,
				(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
					sent.push(String(options?.apiKey));
					return complete();
				},
				SOURCE,
			);
			const wrapped = createSettingsAwareStreamFn(Settings.isolated(), streamSimple, { notify });
			// The side boundary adds this same session notice hook before passing through settings.
			const sideHook = withAccountBusyNotice(info => {
				callerEvents.push(`${info.provider}/${info.credentialId}`);
				throw new Error("caller notice hook failed");
			}, notify);
			const stream = await wrapped(model, context, {
				apiKey: () => ({ apiKey: "occupied-key", credentialId: 17, accountBusy: true, accountBusyReason: reason }),
				onAccountBusy: sideHook,
			});
			expect((await stream.result()).stopReason).toBe("stop");
			expect(sent).toEqual(["occupied-key"]);
			expect(callerEvents).toEqual(["notice-provider/17"]);
			expect(notices).toHaveLength(1);
			expect(notices[0]?.level).toBe("warning");
			expect(notices[0]?.message).toContain("without waiting");
			if (reason === "pinned") {
				expect(notices[0]?.message).toContain("the selected account is busy");
				expect(notices[0]?.message).not.toContain("all eligible");
			} else {
				expect(notices[0]?.message).toContain("all eligible automatic-routing accounts are busy");
			}
		});
	}

	it("does not issue an account warning for static keys", async () => {
		const notices: string[] = [];
		registerCustomApi(API, complete, SOURCE);
		const wrapped = createSettingsAwareStreamFn(Settings.isolated(), streamSimple, {
			notify: (_level, message) => notices.push(message),
		});
		const stream = await wrapped(model, context, { apiKey: "static-key" });
		await stream.result();
		expect(notices).toEqual([]);
	});

	it("warns and switches through 403 accounts without exposing recoverable assistant errors", async () => {
		const notices: Array<{ level: string; message: string }> = [];
		const sent: string[] = [];
		const retrySteps: boolean[] = [];
		const callerStatuses: Array<number | undefined> = [];
		const notify = (level: "info" | "warning" | "error", message: string) => notices.push({ level, message });
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				const key = String(options?.apiKey);
				sent.push(key);
				if (key === "allowed") return complete();
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (key === "denied-throw") {
						stream.fail(new ProviderHttpError("Access denied", 403));
					} else {
						complete()
							.result()
							.then(message => {
								stream.push({ type: "start", partial: message });
								stream.push({
									type: "error",
									reason: "error",
									error: {
										...message,
										content: [],
										stopReason: "error",
										errorStatus: 403,
										errorMessage: "Access denied",
									},
								});
							});
					}
				});
				return stream;
			},
			SOURCE,
		);
		const keys = ["denied-throw", "denied-event", "allowed"];
		const wrapped = createSettingsAwareStreamFn(Settings.isolated(), streamSimple, { notify });
		const stream = await wrapped(model, context, {
			apiKey: ctx => {
				retrySteps.push(ctx.lastChance);
				return keys[retrySteps.length - 1];
			},
			onAuthRetry: withAuthRetryNotice(info => {
				callerStatuses.push(info.status);
				throw new Error("observer failed");
			}, notify),
		});
		const eventTypes: string[] = [];
		for await (const event of stream) eventTypes.push(event.type);

		expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
		expect(sent).toEqual(keys);
		expect(retrySteps).toEqual([false, true, true]);
		expect(eventTypes).not.toContain("error");
		expect(callerStatuses).toEqual([403, 403]);
		expect(notices.map(notice => notice.level)).toEqual(["warning", "warning"]);
		expect(notices.every(notice => notice.message.includes("403"))).toBe(true);
		expect(notices.some(notice => keys.some(key => notice.message.includes(key)))).toBe(false);
	});

	it("preserves a terminal 403 when no eligible sibling remains", async () => {
		const notices: Array<{ level: string; message: string }> = [];
		const sent: string[] = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				sent.push(String(options?.apiKey));
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => stream.fail(new ProviderHttpError("Access denied", 403)));
				return stream;
			},
			SOURCE,
		);
		const wrapped = createSettingsAwareStreamFn(Settings.isolated(), streamSimple, {
			notify: (level, message) => notices.push({ level, message }),
		});
		const stream = await wrapped(model, context, {
			apiKey: ctx => (ctx.error === undefined ? "only-account" : undefined),
		});
		await expect(stream.result()).rejects.toMatchObject({ status: 403 });
		expect(sent).toEqual(["only-account"]);
		expect(notices.map(notice => notice.level)).toEqual(["warning"]);
		expect(notices[0]?.message).toContain("no usable next account");
	});

	for (const mode of ["text", "json"] as const) {
		it(`makes busy notices visible in ${mode} print mode without polluting answer output`, async () => {
			const stdout: string[] = [];
			const stderr: string[] = [];
			vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
				stdout.push(String(args[0]));
				const callback = args[args.length - 1];
				if (typeof callback === "function") callback();
				return true;
			});
			vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
				stderr.push(String(chunk));
				return true;
			});
			let subscriber: ((event: AgentSessionEvent) => void) | undefined;
			let final: AssistantMessage | undefined;
			const settings = Settings.isolated();
			const wrapped = createSettingsAwareStreamFn(settings, streamSimple, {
				notify: (level, message) => subscriber?.({ type: "notice", level, message, source: "provider-request" }),
			});
			registerCustomApi(API, complete, SOURCE);
			const session = {
				settings,
				state: { messages: [] },
				sessionManager: {
					getHeader: () => undefined,
					buildSessionContext: () => ({ messages: [] }),
					getEntries: () => [],
					onPersistenceError: () => () => {},
					onPersistenceNotice: () => () => {},
				},
				extensionRunner: undefined,
				subscribe: (listener: (event: AgentSessionEvent) => void) => {
					subscriber = listener;
					return () => {};
				},
				prompt: async () => {
					const stream = await wrapped(model, context, {
						apiKey: () => ({ apiKey: "occupied-key", accountBusy: true, accountBusyReason: "all-busy" }),
					});
					final = await stream.result();
					subscriber?.({ type: "message_end", message: final });
				},
				getLastAssistantMessage: () => final,
				disableStopTimeTodoReminders: () => {},
				prepareForHeadlessAdvisorDrain: () => {},
				setTextOutputCommitted: () => {},
				waitForIdle: async () => {},
				waitForAdvisorCatchup: async () => {},
				dispose: async () => {},
			} as unknown as AgentSession;
			expect(await runPrintMode(session, { mode, initialMessage: "hello" })).toBe(0);
			if (mode === "text") {
				expect(stdout.join("")).toBe("ok\n");
				expect(stderr.join("")).toContain("accounts are busy");
			} else {
				const events = stdout
					.join("")
					.trim()
					.split("\n")
					.map(line => JSON.parse(line));
				expect(events).toContainEqual(
					expect.objectContaining({ type: "notice", level: "warning", source: "provider-request" }),
				);
				expect(stderr.join("")).not.toContain("accounts are busy");
			}
		});
	}
});
