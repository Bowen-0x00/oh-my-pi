import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const FLASH_FIRST_EVENT_TIMEOUT_MS = 60_000;
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const antigravityModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (Antigravity)",
	api: "google-gemini-cli",
	provider: "google-antigravity",
	baseUrl: ANTIGRAVITY_DAILY_ENDPOINT,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

// This file exercises endpoint failover; pinning the client version keeps the
// manifest lookup off the injected fetch, which only models CCA endpoints.
const savedAntigravityVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
beforeEach(() => {
	process.env.PI_AI_ANTIGRAVITY_VERSION = "2.19.1";
});

afterEach(() => {
	vi.useRealTimers();
	if (savedAntigravityVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
	else process.env.PI_AI_ANTIGRAVITY_VERSION = savedAntigravityVersion;
});

function endpointFromInput(input: Parameters<FetchImpl>[0]): string {
	const url = input instanceof Request ? input.url : input.toString();
	return url.startsWith(ANTIGRAVITY_SANDBOX_ENDPOINT) ? ANTIGRAVITY_SANDBOX_ENDPOINT : ANTIGRAVITY_DAILY_ENDPOINT;
}

function responseWithUrl(response: Response, endpoint: string): Response {
	Object.defineProperty(response, "url", { value: `${endpoint}/v1internal:streamGenerateContent?alt=sse` });
	return response;
}

test("Antigravity Flash fails over when headers arrive without a first SSE event", async () => {
	const requestedEndpoints: string[] = [];
	let dailyBodyCancelled = false;
	const dailyBodyReadStarted = Promise.withResolvers<void>();
	const dailyBodyStall = Promise.withResolvers<void>();
	vi.useFakeTimers();

	const fetchMock: FetchImpl = async input => {
		const endpoint = endpointFromInput(input);
		requestedEndpoints.push(endpoint);
		if (endpoint === ANTIGRAVITY_SANDBOX_ENDPOINT) {
			const body = `data: ${JSON.stringify({
				response: {
					candidates: [{ content: { parts: [{ text: "Recovered after stall." }] }, finishReason: "STOP" }],
				},
			})}\n\n`;
			return responseWithUrl(
				new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
				endpoint,
			);
		}

		return responseWithUrl(
			new Response(
				new ReadableStream({
					pull() {
						dailyBodyReadStarted.resolve();
						return dailyBodyStall.promise;
					},
					cancel() {
						dailyBodyStall.resolve();
						dailyBodyCancelled = true;
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
			endpoint,
		);
	};

	const stream = streamGoogleGeminiCli(antigravityModel, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		antigravityEndpointMode: "auto",
		fetch: fetchMock,
	});
	const resultPromise = stream.result();
	await dailyBodyReadStarted.promise;
	expect(vi.getTimerCount()).toBeGreaterThan(0);
	vi.advanceTimersByTime(FLASH_FIRST_EVENT_TIMEOUT_MS * 2);
	const result = await resultPromise;

	expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT]);
	expect(dailyBodyCancelled).toBe(true);
	expect(result.stopReason).toBe("stop");
	expect(result.content).toEqual([{ type: "text", text: "Recovered after stall." }]);
});

test("Antigravity fails over when the first endpoint never returns response headers", async () => {
	vi.useFakeTimers();
	const requestedEndpoints: string[] = [];
	const fetchMock: FetchImpl = async (input, init) => {
		const endpoint = endpointFromInput(input);
		requestedEndpoints.push(endpoint);
		if (endpoint === ANTIGRAVITY_SANDBOX_ENDPOINT) {
			return responseWithUrl(
				new Response(
					`data: ${JSON.stringify({
						response: {
							candidates: [{ content: { parts: [{ text: "Recovered." }] }, finishReason: "STOP" }],
						},
					})}\n\n`,
				),
				endpoint,
			);
		}
		const { promise, reject } = Promise.withResolvers<Response>();
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		vi.advanceTimersByTime(50);
		return promise;
	};

	const result = await streamGoogleGeminiCli(antigravityModel, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		antigravityEndpointMode: "auto",
		streamFirstEventTimeoutMs: 50,
		fetch: fetchMock,
	}).result();

	expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT]);
	expect(result.stopReason).toBe("stop");
	expect(result.content).toEqual([{ type: "text", text: "Recovered." }]);
});

test("a pinned endpoint reports a retryable timeout instead of losing the watchdog reason", async () => {
	vi.useFakeTimers();
	const fetchMock: FetchImpl = async (_input, init) => {
		const { promise, reject } = Promise.withResolvers<Response>();
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		vi.advanceTimersByTime(50);
		return promise;
	};
	const result = await streamGoogleGeminiCli(antigravityModel, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		antigravityEndpointMode: "production",
		streamFirstEventTimeoutMs: 50,
		fetch: fetchMock,
	}).result();

	expect(result.stopReason).toBe("error");
	expect(AIError.is(result.errorId ?? 0, AIError.Flag.Timeout)).toBe(true);
	expect(AIError.retriable(result.errorId ?? 0)).toBe(true);
});

test("metadata-only SSE events cannot disarm the first-output deadline", async () => {
	vi.useFakeTimers();
	const metadataRead = Promise.withResolvers<void>();
	const stalledBody = Promise.withResolvers<void>();
	const requestedEndpoints: string[] = [];
	let dailyBodyCancelled = false;
	const fetchMock: FetchImpl = async input => {
		const endpoint = endpointFromInput(input);
		requestedEndpoints.push(endpoint);
		if (endpoint === ANTIGRAVITY_SANDBOX_ENDPOINT) {
			return responseWithUrl(
				new Response(
					`data: ${JSON.stringify({
						response: {
							candidates: [{ content: { parts: [{ text: "Recovered." }] }, finishReason: "STOP" }],
						},
					})}\n\n`,
				),
				endpoint,
			);
		}
		let sentMetadata = false;
		return new Response(
			new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						if (!sentMetadata) {
							sentMetadata = true;
							controller.enqueue(
								new TextEncoder().encode(
									`data: ${JSON.stringify({ response: { responseId: "metadata-only" } })}\n\n`,
								),
							);
							return;
						}
						metadataRead.resolve();
						return stalledBody.promise;
					},
					cancel() {
						dailyBodyCancelled = true;
						stalledBody.resolve();
					},
				},
				{ highWaterMark: 0 },
			),
		);
	};
	const resultPromise = streamGoogleGeminiCli(antigravityModel, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		antigravityEndpointMode: "auto",
		streamFirstEventTimeoutMs: 50,
		fetch: fetchMock,
	}).result();
	await metadataRead.promise;
	vi.advanceTimersByTime(100);
	const result = await resultPromise;

	expect(dailyBodyCancelled).toBe(true);
	expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT]);
	expect(result.stopReason).toBe("stop");
	expect(result.content).toEqual([{ type: "text", text: "Recovered." }]);
});

test("caller cancellation is not converted into a timeout or endpoint failover", async () => {
	vi.useFakeTimers();
	const caller = new AbortController();
	const requestedEndpoints: string[] = [];
	const fetchMock: FetchImpl = async (input, init) => {
		requestedEndpoints.push(endpointFromInput(input));
		const { promise, reject } = Promise.withResolvers<Response>();
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
		caller.abort(new DOMException("Cancelled by caller", "AbortError"));
		vi.advanceTimersByTime(50);
		return promise;
	};
	const result = await streamGoogleGeminiCli(antigravityModel, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		antigravityEndpointMode: "auto",
		streamFirstEventTimeoutMs: 50,
		signal: caller.signal,
		fetch: fetchMock,
	}).result();

	expect(result.stopReason).toBe("aborted");
	expect(AIError.is(result.errorId ?? 0, AIError.Flag.Timeout)).toBe(false);
	expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
});

test("disabling the first-output deadline through env does not substitute the idle deadline", async () => {
	vi.useFakeTimers();
	const previous = process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
	process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "0";
	try {
		const result = await streamGoogleGeminiCli(antigravityModel, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			antigravityEndpointMode: "production",
			streamIdleTimeoutMs: 50,
			fetch: async () => {
				let sentMetadata = false;
				return new Response(
					new ReadableStream<Uint8Array>(
						{
							pull(controller) {
								const response = sentMetadata
									? {
											candidates: [
												{ content: { parts: [{ text: "Delayed output." }] }, finishReason: "STOP" },
											],
										}
									: { responseId: "metadata-only" };
								if (sentMetadata) vi.advanceTimersByTime(100);
								controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response })}\n\n`));
								if (sentMetadata) controller.close();
								sentMetadata = true;
							},
						},
						{ highWaterMark: 0 },
					),
				);
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Delayed output." }]);
	} finally {
		if (previous === undefined) delete process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
		else process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = previous;
	}
});

test("metadata after model output cannot hide an idle stall or replay committed output", async () => {
	vi.useFakeTimers();
	const stalledRead = Promise.withResolvers<void>();
	const stalledBody = Promise.withResolvers<void>();
	const requestedEndpoints: string[] = [];
	const resultPromise = streamGoogleGeminiCli(antigravityModel, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		antigravityEndpointMode: "auto",
		streamFirstEventTimeoutMs: 500,
		streamIdleTimeoutMs: 50,
		fetch: async input => {
			requestedEndpoints.push(endpointFromInput(input));
			let part = 0;
			return new Response(
				new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							if (part === 2) {
								stalledRead.resolve();
								return stalledBody.promise;
							}
							const response =
								part === 0
									? { candidates: [{ content: { parts: [{ text: "Committed output." }] } }] }
									: { responseId: "metadata-only" };
							if (part === 1) vi.advanceTimersByTime(40);
							part++;
							controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response })}\n\n`));
						},
						cancel() {
							stalledBody.resolve();
						},
					},
					{ highWaterMark: 0 },
				),
			);
		},
	}).result();
	await stalledRead.promise;
	vi.advanceTimersByTime(20);
	const result = await resultPromise;

	expect(result.stopReason).toBe("error");
	expect(AIError.is(result.errorId ?? 0, AIError.Flag.Timeout)).toBe(true);
	expect(result.content).toEqual([{ type: "text", text: "Committed output." }]);
	expect(requestedEndpoints).toEqual([ANTIGRAVITY_DAILY_ENDPOINT]);
});
