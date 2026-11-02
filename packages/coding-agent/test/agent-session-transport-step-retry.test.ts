import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model, TextContent, ThinkingContent, ToolCall } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { type CustomMessage, convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

const RESET = "ECONNRESET: socket hang up";
const STALL = "Provider stream stalled while waiting for the next event";
const REDIRECT_TYPE = "transport-step-redirect";
type RetryEnd = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
type ResponseContent = TextContent | ThinkingContent | ToolCall;

function argonModel(provider = "google-antigravity"): Model {
	return buildModel({
		provider,
		id: "gemini-4-argon",
		name: "Argon",
		api: "google-gemini-cli",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

function assistant(model: Model, content: ResponseContent[], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		stopReason: errorMessage ? "error" : content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		...(errorMessage ? { errorMessage } : {}),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

// Only the provider boundary is scripted: Agent still consumes the stream,
// executes tools, builds their results, and dispatches the continuation.
function response(model: Model, content: ResponseContent[], errorMessage?: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message = assistant(model, content, errorMessage);
		stream.push({ type: "start", partial: message });
		for (const [contentIndex, block] of content.entries()) {
			if (block.type === "thinking") {
				stream.push({ type: "thinking_start", contentIndex, partial: message });
				stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial: message });
				stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: message });
			} else if (block.type === "text") {
				stream.push({ type: "text_start", contentIndex, partial: message });
				stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
				stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
			} else {
				stream.push({ type: "toolcall_start", contentIndex, partial: message });
				stream.push({
					type: "toolcall_delta",
					contentIndex,
					delta: JSON.stringify(block.arguments),
					partial: message,
				});
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: message });
			}
		}
		if (errorMessage) stream.push({ type: "error", reason: "error", error: message });
		else stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	});
	return stream;
}

function thinkingFailure(model: Model, error = RESET): AssistantMessageEventStream {
	return response(model, [{ type: "thinking", thinking: "Considering the next research action." }], error);
}

function redirects(session: AgentSession): CustomMessage[] {
	return session.agent.state.messages.filter(
		(message): message is CustomMessage => message.role === "custom" && message.customType === REDIRECT_TYPE,
	);
}

function contextText(context: Context): string {
	return context.messages
		.flatMap(message => {
			const content = message.content;
			return typeof content === "string"
				? [content]
				: content.flatMap(block => (block.type === "text" ? [block.text] : []));
		})
		.join("\n");
}

describe("AgentSession transport next-step recovery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-transport-step-retry-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		for (const provider of ["google-antigravity", "google-gemini-cli"]) {
			authStorage.keys.setRuntime(provider, "isolated-test-key");
		}
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(
		model: Model,
		streamFn: StreamFn,
		maxRetries = 2,
		tools: AgentTool[] = [],
		history: AgentMessage[] = [],
	): AgentSession {
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const agent = new Agent({
			getApiKey: () => "isolated-test-key",
			initialState: { model, systemPrompt: ["Test"], tools },
			convertToLlm,
			streamFn,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": true,
			"retry.baseDelayMs": 0,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": maxRetries,
			"retry.modelFallback": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		for (const message of history) {
			if (message.role === "user" || message.role === "assistant") {
				sessionManager.appendMessage(message);
				agent.appendMessage(message);
			}
		}
		sessions.push(session);
		return session;
	}

	it("recovers repeated Argon transport failures into one real tool action without losing history or duplicating the redirect", async () => {
		const model = argonModel();
		const inputPath = path.join(tempDir.path(), "research-observations.txt");
		await Bun.write(inputPath, "7\n11\n");
		const executed: string[] = [];
		const parameters = type({ path: "string" });
		const tool: AgentTool<typeof parameters> = {
			name: "sum_observations",
			label: "Sum observations",
			description: "Read and sum the isolated observation file",
			parameters,
			execute: async (id, args) => {
				executed.push(id);
				const values = (await Bun.file(args.path).text()).trim().split("\n").map(Number);
				const sum = values.reduce((total, value) => total + value, 0);
				return { content: [{ type: "text", text: String(sum) }] };
			},
		};
		const history: AgentMessage[] = [
			{ role: "user", content: "Retain the Argon research protocol and all earlier observations.", timestamp: 1 },
			assistant(model, [
				{ type: "text", text: "The protocol requires summing both observations before proceeding." },
			]),
		];
		const contexts: Context[] = [];
		const requestedModels: Model[] = [];
		const retryEnds: RetryEnd[] = [];
		const session = createSession(
			model,
			(requestedModel, context) => {
				requestedModels.push(requestedModel);
				contexts.push({ ...context, messages: [...context.messages] });
				const call = contexts.length;
				if (call === 1) return thinkingFailure(requestedModel, RESET);
				if (call === 2) {
					return response(
						requestedModel,
						[
							{ type: "thinking", thinking: "Considering the next research action." },
							{ type: "text", text: " \n\t" },
						],
						STALL,
					);
				}
				if (call === 3) {
					expect(redirects(session)).toHaveLength(1);
					return thinkingFailure(requestedModel, RESET);
				}
				if (call === 4) {
					const notices = redirects(session);
					expect(notices).toHaveLength(1);
					expect(context.messages).toContainEqual(convertToLlm([notices[0]])[0]);
					return response(requestedModel, [
						{ type: "toolCall", id: "research-step", name: tool.name, arguments: { path: inputPath } },
					]);
				}
				expect(call).toBe(5);
				const result = context.messages.find(
					message => message.role === "toolResult" && message.toolCallId === "research-step",
				);
				if (result?.role !== "toolResult" || result.isError)
					throw new Error("Expected a real successful tool result");
				const value = result.content.find(block => block.type === "text");
				if (value?.type !== "text") throw new Error("Missing computed observation sum");
				return response(requestedModel, [{ type: "text", text: `Observation total: ${Number(value.text)}.` }]);
			},
			3,
			[tool],
			history,
		);
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});
		mockSchedulerWaitWithClock();

		await session.prompt("Proceed with the research protocol.");
		await session.waitForIdle();

		expect(contexts).toHaveLength(5);
		expect(contexts.slice(0, 2).every(context => !contextText(context).includes(REDIRECT_TYPE))).toBe(true);
		expect(contexts[2].messages).toContainEqual(convertToLlm([redirects(session)[0]])[0]);
		for (const context of contexts) expect(context.messages.slice(0, history.length)).toEqual(convertToLlm(history));
		for (const requestedModel of requestedModels) expect(requestedModel).toBe(model);
		expect(session.model).toBe(model);
		expect(executed).toEqual(["research-step"]);
		expect(redirects(session)).toHaveLength(1);
		expect(redirects(session)[0]).toMatchObject({ display: false, attribution: "agent" });
		expect(
			session.sessionManager
				.getBranch()
				.filter(entry => entry.type === "custom_message" && entry.customType === REDIRECT_TYPE),
		).toHaveLength(1);
		expect(session.agent.state.messages.slice(0, history.length)).toEqual(history);
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			provider: model.provider,
			model: model.id,
			api: model.api,
			stopReason: "stop",
			content: [{ type: "text", text: "Observation total: 18." }],
		});
		expect(retryEnds).toContainEqual(expect.objectContaining({ success: true, attempt: 3 }));
	});

	it("respects zero/one retry budgets and leaves another provider's repeated failures unchanged", async () => {
		mockSchedulerWaitWithClock();
		for (const { provider, budget } of [
			{ provider: "google-antigravity", budget: 0 },
			{ provider: "google-antigravity", budget: 1 },
			{ provider: "google-gemini-cli", budget: 2 },
		]) {
			let calls = 0;
			const model = argonModel(provider);
			const session = createSession(
				model,
				requestedModel => {
					calls++;
					return thinkingFailure(requestedModel);
				},
				budget,
			);
			await session.prompt("Continue the research.");
			await session.waitForIdle();
			expect(calls).toBe(budget + 1);
			expect(redirects(session)).toHaveLength(0);
			expect(session.isRetrying).toBe(false);
			expect(session.agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
		}
	});

	it("preserves committed text and interrupted tool evidence instead of redirecting or replaying them", async () => {
		mockSchedulerWaitWithClock();
		for (const output of ["text", "buffered-text", "tool"] as const) {
			const executed: string[] = [];
			const tool: AgentTool = {
				name: "record_observation",
				label: "Record observation",
				description: "Record an isolated invocation",
				parameters: type({}),
				execute: async id => {
					executed.push(id);
					return { content: [{ type: "text", text: "recorded" }] };
				},
			};
			const emitted: ResponseContent =
				output !== "tool"
					? { type: "text", text: "Committed research finding." }
					: { type: "toolCall", id: "interrupted-observation", name: tool.name, arguments: {} };
			const contexts: Context[] = [];
			const session = createSession(
				argonModel(),
				(model, context) => {
					contexts.push({ ...context, messages: [...context.messages] });
					if (contexts.length === 1) return thinkingFailure(model);
					if (contexts.length === 2) {
						session.setTextOutputCommitted(output !== "buffered-text");
						return response(model, [emitted], STALL);
					}
					expect(contexts.length).toBe(3);
					return response(model, [{ type: "text", text: "Continued after the preserved output." }]);
				},
				2,
				[tool],
			);
			await session.prompt("Continue without replaying prior output.");
			await session.waitForIdle();
			expect(contexts).toHaveLength(3);
			expect(redirects(session)).toHaveLength(0);
			expect(executed).toHaveLength(0);
			const preserved = contexts[2].messages.filter(
				message =>
					message.role === "assistant" &&
					message.content.some(block =>
						output === "text"
							? block.type === "text" && block.text === "Committed research finding."
							: block.type === "toolCall" && block.id === "interrupted-observation",
					),
			);
			expect(preserved).toHaveLength(output === "buffered-text" ? 0 : 1);
			if (output === "tool") {
				expect(contexts[2].messages).toContainEqual(
					expect.objectContaining({
						role: "toolResult",
						toolCallId: "interrupted-observation",
						details: expect.objectContaining({ executed: false }),
					}),
				);
			} else if (output === "text") expect(contextText(contexts[2])).toContain("Committed research finding.");
			expect(session.agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
		}
	});

	it("does not inject or dispatch another request when the second retry is cancelled", async () => {
		let calls = 0;
		const session = createSession(
			argonModel(),
			model => {
				calls++;
				return thinkingFailure(model, calls === 1 ? RESET : STALL);
			},
			3,
		);
		const cancelled = Promise.withResolvers<void>();
		const retryEnds: RetryEnd[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEnds.push(event);
			if (event.type === "auto_retry_start" && event.attempt === 2) {
				void session.abort().then(cancelled.resolve, cancelled.reject);
			}
		});
		mockSchedulerWaitWithClock();
		await session.prompt("Stop if the next retry is cancelled.");
		await cancelled.promise;
		await session.waitForIdle();
		expect(calls).toBe(2);
		expect(redirects(session)).toHaveLength(0);
		expect(session.isRetrying).toBe(false);
		expect(retryEnds).toContainEqual(expect.objectContaining({ success: false }));
	});
});
