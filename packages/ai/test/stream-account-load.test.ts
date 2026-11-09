import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "../src/api-registry";
import {
	type ApiKeyResolution,
	type ApiKeyResolveContext,
	resolveApiKeyOnce,
	seedApiKeyResolver,
} from "../src/auth-retry";
import { AccountLoadCoordinator, accountLoadCoordinator } from "../src/auth/account-load";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import * as oauth from "../src/registry/oauth";
import { streamSimple } from "../src/stream";
import type { AccountBusyInfo, Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

const SOURCE = "stream-account-load-test";
const API = "stream-account-load-test" as Api;
const PROVIDER = "google-antigravity";
const model: Model<Api> = {
	id: "gemini-3-flash",
	name: "Account load lifecycle",
	api: API,
	provider: PROVIDER,
	contextWindow: 10000,
	maxTokens: 100,
} as Model<Api>;
const context: Context = { systemPrompt: [], messages: [{ role: "user", content: "hello", timestamp: 1 }] };

interface Attempt {
	stream: AssistantMessageEventStream;
	key: string | undefined;
}

function finish(attempt: Attempt): void {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: API,
		provider: PROVIDER,
		model: model.id,
		timestamp: 1,
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	attempt.stream.push({ type: "done", reason: "stop", message });
}

describe("live resolver account reservations", () => {
	let root = "";
	let auth: AuthStorage;
	let coordinator: AccountLoadCoordinator;
	let attempts: Attempt[];
	let awaiting: Array<(attempt: Attempt) => void>;
	const controllers: AbortController[] = [];

	function nextAttempt(): Promise<Attempt> {
		const attempt = attempts.shift();
		if (attempt) return Promise.resolve(attempt);
		const { promise, resolve } = Promise.withResolvers<Attempt>();
		awaiting.push(resolve);
		return promise;
	}

	function request(session: string, notices: AccountBusyInfo[] = []) {
		const controller = new AbortController();
		controllers.push(controller);
		const stream = streamSimple(model, context, {
			apiKey: auth.keys.resolver(PROVIDER, { sessionId: session, modelId: model.id }),
			signal: controller.signal,
			onAccountBusy: info => notices.push(info),
		});
		return { stream, controller };
	}

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stream-account-load-"));
		coordinator = new AccountLoadCoordinator(path.join(root, "requests"));
		// Only replace the root, not the OS-lock implementation or the selector.
		vi.spyOn(accountLoadCoordinator, "create").mockImplementation(provider => coordinator.create(provider));
		vi.spyOn(accountLoadCoordinator, "reserve").mockImplementation((provider, id, key, allowBusy) =>
			coordinator.reserve(provider, id, key, allowBusy),
		);
		auth = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(root, "agent.db")), {
			usageProviderResolver: () => undefined,
		});
		vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { apiKey: credential.access, newCredentials: credential } : null;
		});
		await auth.credentials.set(
			PROVIDER,
			["a", "b"].map(id => ({
				type: "oauth" as const,
				access: `access-${id}`,
				refresh: `refresh-${id}`,
				expires: Date.now() + 3600000,
				projectId: "shared-project",
				email: `${id}@example.test`,
			})),
		);
		attempts = [];
		awaiting = [];
		registerCustomApi(
			API,
			(_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
				const stream = new AssistantMessageEventStream();
				const attempt = { stream, key: typeof options?.apiKey === "string" ? options.apiKey : undefined };
				const waiter = awaiting.shift();
				if (waiter) waiter(attempt);
				else attempts.push(attempt);
				options?.signal?.addEventListener("abort", () => stream.fail(options.signal?.reason), { once: true });
				return stream;
			},
			SOURCE,
		);
	});

	afterEach(async () => {
		for (const controller of controllers.splice(0)) controller.abort();
		unregisterCustomApis(SOURCE);
		auth.close();
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("routes concurrent requests to distinct accounts, then sends on a shared account when all are busy", async () => {
		const notices: AccountBusyInfo[] = [];
		const first = request("first", notices);
		const second = request("second", notices);
		const a = await nextAttempt();
		const b = await nextAttempt();
		expect(a.key).not.toBe(b.key);
		expect(notices).toEqual([]);
		const third = {
			stream: streamSimple(model, context, {
				apiKey: auth.keys.resolver(PROVIDER, { sessionId: "third", modelId: model.id }),
				onAccountBusy: async info => {
					notices.push(info);
					throw new Error("notice observer failed");
				},
			}),
		};
		const c = await nextAttempt();
		expect([a.key, b.key]).toContain(c.key);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.reason).toBe("all-busy");
		finish(a);
		finish(b);
		await Promise.all([first.stream.result(), second.stream.result()]);
		// The shared request keeps its own marker after both original holders finish.
		const fourthNotices: AccountBusyInfo[] = [];
		const fourth = request("fourth", fourthNotices);
		const d = await nextAttempt();
		expect(d.key).not.toBe(c.key);
		expect(fourthNotices).toEqual([]);
		finish(c);
		finish(d);
		await Promise.all([third.stream.result(), fourth.stream.result()]);
	});

	it("reselects a preflight-seeded credential under the live request lease", async () => {
		const resolver = auth.keys.resolver(PROVIDER, { sessionId: "seeded", modelId: model.id });
		let seed: ApiKeyResolution;
		await resolveApiKeyOnce(resolver, undefined, resolved => {
			seed = resolved;
		});
		const first = streamSimple(model, context, { apiKey: seedApiKeyResolver(seed, resolver) });
		const a = await nextAttempt();
		const notices: AccountBusyInfo[] = [];
		const second = streamSimple(model, context, {
			apiKey: seedApiKeyResolver(seed, resolver),
			onAccountBusy: info => notices.push(info),
		});
		const b = await nextAttempt();
		expect(b.key).not.toBe(a.key);
		expect(notices).toEqual([]);
		finish(a);
		finish(b);
		await Promise.all([first.result(), second.result()]);
	});

	it("keeps an explicit pin and reports only the pinned account as busy", async () => {
		const account = auth.oauth.accounts(PROVIDER)[0]!;
		expect(auth.sessions.pin(PROVIDER, "pinned-one", account.credentialId)).toBe(true);
		expect(auth.sessions.pin(PROVIDER, "pinned-two", account.credentialId)).toBe(true);
		const one = request("pinned-one");
		const a = await nextAttempt();
		const notices: AccountBusyInfo[] = [];
		const two = request("pinned-two", notices);
		const b = await nextAttempt();
		expect(b.key).toBe(a.key);
		expect(notices[0]?.reason).toBe("pinned");
		finish(a);
		finish(b);
		await Promise.all([one.stream.result(), two.stream.result()]);
	});

	for (const terminal of ["done", "error", "cancel"] as const) {
		it(`releases the account before the ${terminal} result settles`, async () => {
			await auth.credentials.set(PROVIDER, [auth.credentials.list(PROVIDER)[0]!.credential]);
			const active = request("active");
			const attempt = await nextAttempt();
			if (terminal === "done") finish(attempt);
			else if (terminal === "error") attempt.stream.fail(new Error("upstream disconnected"));
			else active.controller.abort(new Error("canceled"));
			await active.stream.result().catch(() => undefined);
			const notices: AccountBusyInfo[] = [];
			const next = request("next", notices);
			finish(await nextAttempt());
			await next.stream.result();
			expect(notices).toEqual([]);
		});
	}

	it("shares one live request id across initial resolution and auth retry, but never gives probes an id", async () => {
		const resolver = auth.keys.resolver(PROVIDER, { sessionId: "retry", modelId: model.id });
		const contexts: ApiKeyResolveContext[] = [];
		const observed = (ctx: ApiKeyResolveContext) => {
			contexts.push(ctx);
			return resolver(ctx);
		};
		await resolveApiKeyOnce(observed);
		expect(contexts[0]?.accountRequestId).toBeUndefined();
		const stream = streamSimple(model, context, { apiKey: observed });
		const initial = await nextAttempt();
		initial.stream.fail(Object.assign(new Error("401 rejected"), { status: 401 }));
		const retry = await nextAttempt();
		finish(retry);
		await stream.result();
		const liveIds = contexts.slice(1).map(ctx => ctx.accountRequestId);
		expect(liveIds.length).toBeGreaterThan(1);
		expect(liveIds[0]).toBeDefined();
		expect(new Set(liveIds).size).toBe(1);
		expect(await coordinator.reserve(PROVIDER, liveIds[0]!, "unused", true)).toBeUndefined();
	});

	it("releases an aborted request even while its credential resolver is still pending", async () => {
		const { promise: entered, resolve: markEntered } = Promise.withResolvers<string>();
		const { promise: pending, resolve: finishResolve } = Promise.withResolvers<string>();
		const controller = new AbortController();
		controllers.push(controller);
		const stream = streamSimple(model, context, {
			signal: controller.signal,
			apiKey: ctx => {
				if (!ctx.accountRequestId) throw new Error("missing live request id");
				markEntered(ctx.accountRequestId);
				return pending;
			},
		});
		const id = await entered;
		controller.abort(new Error("canceled during auth"));
		expect(await coordinator.reserve(PROVIDER, id, "unused", true)).toBeUndefined();
		finishResolve("too-late");
		await expect(stream.result()).rejects.toThrow("canceled during auth");
		expect(attempts).toEqual([]);
	});

	for (const failure of ["empty", "throw"] as const) {
		it(`releases the request marker when the resolver returns ${failure}`, async () => {
			let id: string | undefined;
			const stream = streamSimple(model, context, {
				apiKey: ctx => {
					id = ctx.accountRequestId;
					if (failure === "throw") throw new Error("broker offline");
					return undefined;
				},
			});
			await expect(stream.result()).rejects.toThrow();
			expect(id).toBeDefined();
			expect(await coordinator.reserve(PROVIDER, id!, "unused", true)).toBeUndefined();
		});
	}
});
