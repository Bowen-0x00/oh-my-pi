/**
 * Antigravity usage provider contract tests. The merge logic
 * deduplicates per-model quota entries by (tier, windowId),
 * preserves reset times when bar data and window data come from
 * different model entries, and handles mixed-case tier names.
 */
import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageReport } from "@oh-my-pi/pi-ai/usage";
import {
	antigravityRankingStrategy,
	antigravityUsageProvider,
	getAntigravityCounterKeyForModel,
	scopeAntigravityLimitsForModel,
} from "@oh-my-pi/pi-ai/usage/google-antigravity";

const accessTokenFixture = (() => {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify({ sub: "user-fixture" })).toString("base64url");
	return `${header}.${body}.sig`;
})();

function makeCredential(overrides?: Partial<UsageFetchParams["credential"]>) {
	return {
		type: "oauth" as const,
		accessToken: accessTokenFixture,
		refreshToken: "refresh-fixture",
		expiresAt: Date.now() + 3600_000,
		projectId: "test-project",
		email: "test@example.com",
		accountId: "acct-1",
		...overrides,
	} satisfies UsageFetchParams["credential"];
}

function fakeFetch(json: unknown): FetchImpl {
	const fn = async () =>
		new Response(JSON.stringify(json), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	return fn;
}

function makeCtx(fetchImpl?: FetchImpl): UsageFetchContext {
	return { fetch: fetchImpl ?? fakeFetch({}) };
}

// ── helpers ──────────────────────────────────────────────────────────

function makeApiModel(
	displayName: string,
	quota: {
		remainingFraction?: number;
		resetTime?: string;
		tier?: string;
		windowId?: string;
		apiProvider?: string;
		modelProvider?: string;
	},
) {
	return {
		displayName,
		apiProvider: quota.apiProvider,
		modelProvider: quota.modelProvider,
		quotaInfo: {
			remainingFraction: quota.remainingFraction,
			resetTime: quota.resetTime,
			tier: quota.tier,
			windowId: quota.windowId,
		},
	};
}

// ── tests ────────────────────────────────────────────────────────────

describe("antigravity usage provider", () => {
	it("reports the official five-hour and weekly quota summary", async () => {
		const summary = {
			groups: [
				{
					displayName: "Gemini Models",
					buckets: [
						{
							bucketId: "gemini-weekly",
							displayName: "Weekly Limit Remaining",
							window: "weekly",
							remainingFraction: 0.88,
							resetTime: "2026-09-10T00:00:00Z",
						},
						{
							bucketId: "gemini-5h",
							displayName: "Five Hour Limit Remaining",
							window: "5h",
							remainingFraction: 0.59,
							resetTime: "2026-09-03T12:00:00Z",
						},
						{
							bucketId: "gemini-argon-wtu-weekly",
							displayName: "Weekly Limit Remaining",
							window: "weekly",
							remainingFraction: 0.02,
							resetTime: "2026-09-11T00:00:00Z",
						},
					],
				},
				{
					displayName: "Claude and GPT models",
					buckets: [
						{
							bucketId: "3p-weekly",
							displayName: "Weekly Limit Remaining",
							window: "weekly",
							remainingFraction: 1,
							resetTime: "2026-09-10T12:00:00Z",
						},
						{
							bucketId: "3p-5h",
							displayName: "Five Hour Limit Remaining",
							window: "5h",
							remainingFraction: 1,
							resetTime: "2026-09-03T15:00:00Z",
						},
					],
				},
			],
		};
		const fetchImpl = fakeFetch(summary);

		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fetchImpl),
		);

		expect(report?.limits).toHaveLength(7);

		const googleLimits = scopeAntigravityLimitsForModel(report!, { modelId: "gemini-3.8-flash" });
		const weekly = googleLimits.find(limit => limit.id.endsWith(":gemini-weekly"));
		const fiveHour = googleLimits.find(limit => limit.scope.windowId === "5h");

		expect(weekly?.amount.usedFraction).toBeCloseTo(0.12);
		expect(weekly?.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(fiveHour?.amount.usedFraction).toBeCloseTo(0.41);
		expect(fiveHour?.window?.label).toBe("5 Hour");
		expect(fiveHour?.window?.durationMs).toBe(5 * 60 * 60 * 1000);
		expect(googleLimits.every(limit => limit.label === "Gemini")).toBeTrue();
		// Argon's weekly-only bucket is separate from the shared Gemini weekly
		// one, so it must carry its own name, not the generic Google-counter one.
		const argonLimits = scopeAntigravityLimitsForModel(report!, { modelId: "gemini-4-argon" });
		expect(argonLimits).toHaveLength(1);
		expect(argonLimits[0]?.id).toStartWith("google-antigravity:google-argon:");
		expect(argonLimits[0]?.id).toEndWith(":gemini-argon-wtu-weekly");
		expect(argonLimits[0]?.label).toBe("Gemini (Argon)");
		expect(argonLimits[0]?.amount.usedFraction).toBeCloseTo(0.98);
		expect(argonLimits[0]?.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
		const claudeLimits = scopeAntigravityLimitsForModel(report!, { modelId: "claude-sonnet-4-6" });
		const gptLimits = scopeAntigravityLimitsForModel(report!, { modelId: "gpt-oss-120b" });
		expect(claudeLimits).toHaveLength(2);
		expect(gptLimits).toHaveLength(2);
		expect(claudeLimits.every(limit => limit.scope.shared === true)).toBeTrue();
		expect(gptLimits.every(limit => limit.scope.shared === true)).toBeTrue();
		expect(claudeLimits.every(limit => limit.label === "Claude & GPT (shared)")).toBeTrue();
		expect(gptLimits.every(limit => limit.label === "Claude & GPT (shared)")).toBeTrue();
		expect(claudeLimits.map(limit => limit.scope.sharedGroup).sort()).toEqual(
			gptLimits.map(limit => limit.scope.sharedGroup).sort(),
		);
	});

	it("keeps an exhausted Argon weekly bucket out of Gemini 3.8 Flash selection and healing", async () => {
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential(), signal: undefined },
			makeCtx(
				fakeFetch({
					groups: [
						{
							displayName: "Gemini Models",
							buckets: [
								{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.949 },
								{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.944 },
								{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0 },
							],
						},
					],
				}),
			),
		);
		if (!report) throw new Error("expected usage report");
		const flash = { modelId: "gemini-3.8-flash" };
		const argon = { modelId: "gemini-4-argon-high" };
		const flashLimits = scopeAntigravityLimitsForModel(report, flash);
		expect(flashLimits.map(limit => limit.id).sort()).toEqual([
			"google-antigravity:google:default:gemini-5h",
			"google-antigravity:google:default:gemini-weekly",
		]);
		expect(antigravityRankingStrategy.findWindowLimits(report, flash).primary?.status).toBe("ok");
		expect(antigravityRankingStrategy.blockScope?.(flash)).toBe("counter:google");
		expect(scopeAntigravityLimitsForModel(report, argon).map(limit => limit.status)).toEqual(["exhausted"]);
		expect(antigravityRankingStrategy.blockScope?.(argon)).toBe("counter:google-argon");
		expect(
			antigravityRankingStrategy.healableBlockScopes?.(report)?.map(scope => ({
				blockScope: scope.blockScope,
				statuses: scope.limits.map(limit => limit.status),
			})),
		).toEqual([
			{ blockScope: "counter:google-argon", statuses: ["exhausted"] },
			{ blockScope: "counter:google", statuses: ["ok", "ok"] },
		]);
	});

	it("leaves Argon unconstrained when the quota summary reports no Argon bucket", async () => {
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential(), signal: undefined },
			makeCtx(
				fakeFetch({
					groups: [
						{
							displayName: "Gemini Models",
							buckets: [
								{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.0017 },
								{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9966 },
							],
						},
					],
				}),
			),
		);
		if (!report) throw new Error("expected usage report");
		const argon = { modelId: "gemini-4-argon" };
		expect(scopeAntigravityLimitsForModel(report, argon)).toEqual([]);
		expect(antigravityRankingStrategy.findWindowLimits(report, argon).primary).toBeUndefined();
		expect(antigravityRankingStrategy.healableBlockScopes?.(report)?.map(scope => scope.blockScope)).toEqual([
			"counter:google",
		]);
	});

	it.each([
		{ geminiRemaining: 0.8, argonRemaining: 0 },
		{ geminiRemaining: 0, argonRemaining: 0.8 },
	])(
		"isolates summary ranking and healing for $geminiRemaining Gemini / $argonRemaining Argon",
		async ({ geminiRemaining, argonRemaining }) => {
			const report = await antigravityUsageProvider.fetchUsage!(
				{ provider: "google-antigravity", credential: makeCredential() },
				makeCtx(
					fakeFetch({
						buckets: [
							{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: geminiRemaining },
							{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: argonRemaining },
						],
					}),
				),
			);
			const gemini = antigravityRankingStrategy.findWindowLimits(report!, { modelId: "gemini-3.8-flash" });
			const argon = antigravityRankingStrategy.findWindowLimits(report!, { modelId: "gemini-4-argon" });
			expect(gemini.primary?.amount.remainingFraction).toBe(geminiRemaining);
			expect(argon.primary?.amount.remainingFraction).toBe(argonRemaining);
			expect(antigravityRankingStrategy.blockScope?.({ modelId: "gemini-4-argon" })).toBe("counter:google-argon");
			const healing = antigravityRankingStrategy.healableBlockScopes?.(report!);
			expect(healing?.find(scope => scope.blockScope === "counter:google-argon")?.healthy).toBe(argonRemaining > 0);
			expect(healing?.find(scope => scope.blockScope === "counter:google")?.healthy).toBe(geminiRemaining > 0);
		},
	);

	it("keeps Argon's low, medium and high legacy SKUs in one independent worst-case meter", async () => {
		const quota = { modelProvider: "MODEL_PROVIDER_GOOGLE", windowId: "weekly" };
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential() },
			makeCtx(
				fakeFetch({
					models: {
						"gemini-3.8-flash": makeApiModel("Gemini", { ...quota, remainingFraction: 0.9 }),
						"gemini-4-argon-low": makeApiModel("Argon Low", { ...quota, remainingFraction: 0.3 }),
						"gemini-4-argon-medium": makeApiModel("Argon Medium", {
							...quota,
							resetTime: new Date(Date.now() + 6 * 24 * 3600_000).toISOString(),
						}),
						"gemini-4-argon-high": makeApiModel("Argon High", { ...quota, remainingFraction: 0.7 }),
					},
				}),
			),
		);
		expect(report?.limits).toHaveLength(2);
		const argonLimits = scopeAntigravityLimitsForModel(report!, { modelId: "gemini-4-argon" });
		expect(argonLimits).toHaveLength(1);
		expect(argonLimits[0]?.amount.remainingFraction).toBe(0);
		expect(argonLimits[0]?.status).toBe("exhausted");
		expect(
			scopeAntigravityLimitsForModel(report!, { modelId: "gemini-3.8-flash" })[0]?.amount.remainingFraction,
		).toBe(0.9);
	});

	it.each([
		{ models: { "gemini-4-argon-disabled": { disabled: true } }, eligible: false },
		{ models: { "gemini-4-argon-low": {} }, eligible: true },
		{ models: {}, eligible: false },
	])("supplements an Argon-less summary using explicit roster evidence: $eligible", async ({ models, eligible }) => {
		const requestedUrls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requestedUrls.push(String(input));
			const payload = String(input).endsWith(":retrieveUserQuotaSummary")
				? { buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 1 }] }
				: { models };
			return new Response(JSON.stringify(payload), { status: 200 });
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential() },
			makeCtx(fetchImpl),
		);
		expect(requestedUrls).toEqual([
			"https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
			"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
		]);
		const context = { modelId: "gemini-4-argon" };
		expect(antigravityRankingStrategy.modelAvailability?.(context)?.(report!)).toBe(eligible);
		expect(scopeAntigravityLimitsForModel(report!, context)).toEqual([]);
		expect(antigravityRankingStrategy.findWindowLimits(report!, context).primary).toBeUndefined();
		expect(
			antigravityRankingStrategy
				.healableBlockScopes?.(report!)
				.some(scope => scope.blockScope === "counter:google-argon"),
		).toBeFalse();
	});

	it("supplements only Argon legacy quota without replacing summary Gemini windows", async () => {
		const fetchImpl: FetchImpl = async input =>
			new Response(
				JSON.stringify(
					String(input).endsWith(":retrieveUserQuotaSummary")
						? { buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.8 }] }
						: {
								models: {
									"gemini-3.8-flash": makeApiModel("Gemini", { remainingFraction: 0 }),
									"gemini-4-argon-high": makeApiModel("Argon", { remainingFraction: 0.4, windowId: "weekly" }),
								},
							},
				),
				{ status: 200 },
			);
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential() },
			makeCtx(fetchImpl),
		);
		expect(report?.limits).toHaveLength(2);
		expect(
			scopeAntigravityLimitsForModel(report!, { modelId: "gemini-3.8-flash" })[0]?.amount.remainingFraction,
		).toBe(0.8);
		expect(scopeAntigravityLimitsForModel(report!, { modelId: "gemini-4-argon" })[0]?.amount.remainingFraction).toBe(
			0.4,
		);
	});

	it("honors an exhausted Argon high short window despite a full weekly summary", async () => {
		const resetTime = new Date(Date.now() + 3600_000).toISOString();
		let shortWindowRestored = false;
		const fetchImpl: FetchImpl = async input =>
			Response.json(
				String(input).endsWith(":retrieveUserQuotaSummary")
					? {
							buckets: [
								{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 1 },
								{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0 },
							],
						}
					: {
							models: {
								"gemini-4-argon-low": { quotaInfo: { remainingFraction: 1, windowId: "weekly" } },
								"gemini-4-argon-high": {
									quotaInfo: {
										resetTime,
										windowId: "5h",
										...(shortWindowRestored ? { remainingFraction: 0.6 } : {}),
									},
								},
							},
						},
			);
		const params = { provider: "google-antigravity", credential: makeCredential() };
		const blocked = await antigravityUsageProvider.fetchUsage!(params, makeCtx(fetchImpl));
		if (!blocked) throw new Error("Expected quota report");
		const context = { modelId: "gemini-4-argon" };
		const primary = antigravityRankingStrategy.findWindowLimits(blocked, context).primary;
		expect(primary?.status).toBe("exhausted");
		expect(primary?.window?.resetsAt).toBe(Date.parse(resetTime));
		expect(
			antigravityRankingStrategy
				.healableBlockScopes?.(blocked)
				.find(scope => scope.blockScope === "counter:google-argon")?.healthy,
		).toBeFalse();

		shortWindowRestored = true;
		const restored = await antigravityUsageProvider.fetchUsage!(params, makeCtx(fetchImpl));
		if (!restored) throw new Error("Expected restored quota report");
		expect(antigravityRankingStrategy.findWindowLimits(restored, context).primary?.amount.remainingFraction).toBe(
			0.6,
		);
		expect(
			antigravityRankingStrategy
				.healableBlockScopes?.(restored)
				.find(scope => scope.blockScope === "counter:google-argon")?.healthy,
		).toBeTrue();
		// An unrelated ordinary Gemini cap cannot keep the Argon block alive.
		expect(scopeAntigravityLimitsForModel(restored, { modelId: "gemini-3.8-flash" })[0]?.status).toBe("exhausted");
	});

	it("ranks by a stricter model-reported Argon weekly gate without replacing its summary meter", async () => {
		const fetchImpl: FetchImpl = async input =>
			Response.json(
				String(input).endsWith(":retrieveUserQuotaSummary")
					? { buckets: [{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 1 }] }
					: {
							models: {
								"gemini-4-argon-low": { quotaInfo: { remainingFraction: 1, windowId: "weekly" } },
								"gemini-4-argon-high": { quotaInfo: { remainingFraction: 0.06, windowId: "weekly" } },
							},
						},
			);
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential() },
			makeCtx(fetchImpl),
		);
		if (!report) throw new Error("Expected quota report");
		expect(
			antigravityRankingStrategy.findWindowLimits(report, { modelId: "gemini-4-argon" }).primary?.amount
				.remainingFraction,
		).toBe(0.06);
		expect(report.limits.find(limit => limit.id.endsWith(":gemini-argon-wtu-weekly"))?.amount.remainingFraction).toBe(
			1,
		);
	});

	it("preserves summary usage when the optional roster probe fails", async () => {
		const fetchImpl: FetchImpl = async input => {
			if (String(input).endsWith(":fetchAvailableModels")) throw new Error("roster unavailable");
			return new Response(
				JSON.stringify({
					buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.8 }],
				}),
				{ status: 200 },
			);
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential(), baseUrl: "https://quota.example" },
			makeCtx(fetchImpl),
		);
		expect(report?.limits).toHaveLength(1);
		expect(report?.metadata?.argonEligible).toBeUndefined();
	});

	it("keeps completed summary quota when the optional roster request reaches its shared timeout", async () => {
		const controller = new AbortController();
		const fetchImpl: FetchImpl = async input => {
			if (String(input).endsWith(":fetchAvailableModels")) {
				controller.abort(new DOMException("Usage probe timed out", "TimeoutError"));
				throw controller.signal.reason;
			}
			return Response.json({
				buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0 }],
			});
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				baseUrl: "https://quota.example",
				signal: controller.signal,
			},
			makeCtx(fetchImpl),
		);
		expect(controller.signal.aborted).toBeTrue();
		expect(scopeAntigravityLimitsForModel(report!, { modelId: "gemini-3.8-flash" })[0]?.status).toBe("exhausted");
		expect(scopeAntigravityLimitsForModel(report!, { modelId: "gemini-4-argon" })).toEqual([]);
	});

	it("keeps the worst remainingFraction when merging same tier", async () => {
		const payload = {
			models: {
				modelA: makeApiModel("Model A", {
					remainingFraction: 0.1,
					tier: "premium",
				}),
				modelB: makeApiModel("Model B", {
					remainingFraction: 0.8,
					tier: "premium",
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(1);
		expect(report!.limits[0]!.amount.remainingFraction).toBe(0.1);
	});

	it("merges mixed-case tier names under lowercased key", async () => {
		const payload = {
			models: {
				modelA: makeApiModel("Model A", {
					remainingFraction: 0.3,
					tier: "Default",
				}),
				modelB: makeApiModel("Model B", {
					remainingFraction: 0.6,
					tier: "default",
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(1);
	});

	it("treats reset-only quota entries as exhausted and preserves reset time", async () => {
		const now = Date.now();
		const resetTime = new Date(now + 4 * 3600_000).toISOString();
		const payload = {
			models: {
				modelA: makeApiModel("Model A", {
					remainingFraction: 0.3,
					tier: "default",
				}),
				modelB: makeApiModel("Model B", {
					remainingFraction: undefined,
					tier: "default",
					resetTime,
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(1);
		expect(report!.limits[0]!.amount.remainingFraction).toBe(0);
		expect(report!.limits[0]!.amount.usedFraction).toBe(1);
		expect(report!.limits[0]!.status).toBe("exhausted");
		expect(report!.limits[0]!.window).toBeDefined();
		expect(report!.limits[0]!.window!.resetsAt).toBeGreaterThan(now);
	});

	it("separates Google and Anthropic backend counters", async () => {
		const now = Date.now();
		const resetTime = new Date(now + 4 * 3600_000).toISOString();
		const payload = {
			models: {
				claude: makeApiModel("Claude", {
					remainingFraction: 1,
					modelProvider: "MODEL_PROVIDER_ANTHROPIC",
					apiProvider: "API_PROVIDER_ANTHROPIC_VERTEX",
				}),
				gemini: makeApiModel("Gemini", {
					remainingFraction: undefined,
					resetTime,
					modelProvider: "MODEL_PROVIDER_GOOGLE",
					apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(2);
		const googleLimit = report!.limits.find(limit => limit.label === "Usage (Google)");
		const anthropicLimit = report!.limits.find(limit => limit.label === "Usage (Anthropic)");
		expect(googleLimit?.amount.remainingFraction).toBe(0);
		expect(googleLimit?.status).toBe("exhausted");
		expect(anthropicLimit?.amount.remainingFraction).toBe(1);
		expect(anthropicLimit?.status).toBe("ok");
	});

	it("separates models with different windowIds in the same tier", async () => {
		const now = Date.now();
		const t1 = new Date(now + 5 * 3600_000).toISOString();
		const t2 = new Date(now + 24 * 3600_000).toISOString();
		const payload = {
			models: {
				modelA: makeApiModel("Model A", {
					remainingFraction: 0.3,
					tier: "premium",
					windowId: "5h",
					resetTime: t1,
				}),
				modelB: makeApiModel("Model B", {
					remainingFraction: 0.7,
					tier: "premium",
					windowId: "daily",
					resetTime: t2,
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(2);
	});

	it("surfaces named daily and weekly quota windows as separate limits", async () => {
		const now = Date.now();
		const dailyReset = new Date(now + 12 * 3600_000).toISOString();
		const weeklyReset = new Date(now + 6 * 24 * 3600_000).toISOString();
		const payload = {
			models: {
				gemini: {
					displayName: "Gemini",
					modelProvider: "MODEL_PROVIDER_GOOGLE",
					quotaInfo: {
						remainingFraction: 0.8,
						resetTime: dailyReset,
						windowId: "WINDOW_DAILY",
					},
					weeklyQuotaInfo: { remainingFraction: 0.4, resetTime: weeklyReset },
				},
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);

		const daily = report!.limits.find(limit => limit.scope.windowId === "daily");
		const weekly = report!.limits.find(limit => limit.scope.windowId === "weekly");
		expect(report!.limits.length).toBe(2);
		expect(daily?.label).toBe("Usage (Google)");
		expect(daily?.window?.label).toBe("Daily");
		expect(daily?.window?.durationMs).toBe(24 * 60 * 60 * 1000);
		expect(daily?.amount.remainingFraction).toBe(0.8);
		expect(weekly?.label).toBe("Usage (Google)");
		expect(weekly?.window?.label).toBe("Weekly");
		expect(weekly?.window?.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
		expect(weekly?.amount.remainingFraction).toBe(0.4);
	});
	it("drops unmetered autocomplete entries when the counter is weekly-exhausted", async () => {
		const now = Date.now();
		const weeklyReset = new Date(now + 5 * 24 * 3600_000).toISOString();
		const payload = {
			models: {
				"gemini-3-flash": makeApiModel("Gemini", {
					resetTime: weeklyReset,
					modelProvider: "MODEL_PROVIDER_GOOGLE",
				}),
				tab_flash_lite_preview: makeApiModel("Tab", {
					remainingFraction: 1,
					modelProvider: "MODEL_PROVIDER_GOOGLE",
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);

		expect(report!.limits).toHaveLength(1);
		expect(report!.limits[0]!.scope.windowId).toBe("weekly");
		expect(report!.limits[0]!.status).toBe("exhausted");
	});

	it("keeps near-reset unlabeled weekly windows separate from daily windows", async () => {
		const now = Date.now();
		const dailyReset = new Date(now + 5 * 3600_000).toISOString();
		const weeklyReset = new Date(now + 23 * 3600_000).toISOString();
		const payload = {
			models: {
				gemini: {
					displayName: "Gemini",
					modelProvider: "MODEL_PROVIDER_GOOGLE",
					quotaInfos: [
						{ remainingFraction: 0.9, resetTime: dailyReset },
						{ remainingFraction: 0.3, resetTime: weeklyReset },
					],
				},
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);

		const daily = report!.limits.find(limit => limit.scope.windowId === "daily");
		const weekly = report!.limits.find(limit => limit.scope.windowId === "weekly");
		expect(report!.limits).toHaveLength(2);
		expect(daily?.window?.label).toBe("Daily");
		expect(daily?.amount.remainingFraction).toBe(0.9);
		expect(weekly?.window?.label).toBe("Weekly");
		expect(weekly?.amount.remainingFraction).toBe(0.3);
	});

	it("normalizes 7 Day window ids to the weekly usage window", async () => {
		const payload = {
			models: {
				gemini: {
					displayName: "Gemini",
					modelProvider: "MODEL_PROVIDER_GOOGLE",
					quotaInfoByWindow: {
						WINDOW_7_DAY: { remainingFraction: 0.6 },
					},
				},
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);

		expect(report!.limits).toHaveLength(1);
		expect(report!.limits[0]!.scope.windowId).toBe("weekly");
		expect(report!.limits[0]!.window?.label).toBe("Weekly");
	});

	it("sorts limits by remainingFraction ascending (worst first)", async () => {
		const payload = {
			models: {
				modelA: makeApiModel("Model A", {
					remainingFraction: 0.9,
					tier: "high",
				}),
				modelB: makeApiModel("Model B", {
					remainingFraction: 0.2,
					tier: "low",
				}),
				modelC: makeApiModel("Model C", {
					remainingFraction: 0.5,
					tier: "mid",
				}),
			},
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential(),
				signal: undefined,
			},
			makeCtx(fakeFetch(payload)),
		);
		expect(report!.limits.length).toBe(3);
		expect(report!.limits[0]!.amount.remainingFraction).toBe(0.2);
		expect(report!.limits[1]!.amount.remainingFraction).toBe(0.5);
		expect(report!.limits[2]!.amount.remainingFraction).toBe(0.9);
	});

	it("returns null when credential has no projectId", async () => {
		const report = await antigravityUsageProvider.fetchUsage!(
			{
				provider: "google-antigravity",
				credential: makeCredential({ projectId: undefined }),
				signal: undefined,
			},
			makeCtx(),
		);
		expect(report).toBeNull();
	});

	it("keeps exact model entitlement separate from quota even when summary reports funded Argon", async () => {
		const fetchImpl: FetchImpl = async input =>
			Response.json(
				String(input).endsWith(":retrieveUserQuotaSummary")
					? {
							buckets: [
								{ bucketId: "3p-weekly", window: "weekly", remainingFraction: 1 },
								{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 1 },
							],
						}
					: {
							models: {
								"claude-opus-4-6": {},
								"claude-opus-5-5-high": { disabled: true },
								"gemini-3.8-flash-high": {},
								"gpt-oss-120b": { isInternal: true },
							},
							imageGenerationModelIds: ["gemini-3-pro-image"],
						},
			);
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential() },
			makeCtx(fetchImpl),
		);
		expect(antigravityRankingStrategy.modelAvailability?.({ modelId: "claude-opus-4-6" })?.(report!)).toBeTrue();
		expect(antigravityRankingStrategy.modelAvailability?.({ modelId: "claude-opus-5-5" })?.(report!)).toBeFalse();
		expect(antigravityRankingStrategy.modelAvailability?.({ modelId: "gemini-3.8-flash" })?.(report!)).toBeTrue();
		expect(antigravityRankingStrategy.modelAvailability?.({ modelId: "gpt-oss-120b" })?.(report!)).toBeFalse();
		expect(antigravityRankingStrategy.modelAvailability?.({ modelId: "gemini-3-pro-image" })?.(report!)).toBeTrue();
		expect(scopeAntigravityLimitsForModel(report!, { modelId: "claude-opus-5-5" })[0]?.amount.remainingFraction).toBe(
			1,
		);
	});
});

describe("antigravity ranking strategy", () => {
	function makeLimit(remainingFraction: number, label = "Usage"): UsageLimit {
		const usedFraction = 1 - remainingFraction;
		return {
			id: `google-antigravity:${label.toLowerCase()}`,
			label,
			scope: { provider: "google-antigravity" },
			amount: {
				unit: "percent",
				remainingFraction,
				usedFraction,
				remaining: remainingFraction * 100,
				used: usedFraction * 100,
				limit: 100,
			},
			status: remainingFraction <= 0 ? "exhausted" : remainingFraction <= 0.1 ? "warning" : "ok",
		};
	}

	it.each([
		"gemini-4-argon",
		"gemini-4-argon-low",
		"gemini-4-argon-medium",
		"gemini-4-argon-high",
		"gemini-4-argon-disabled",
	])("resolves the independent catalog quota scope for %s", modelId => {
		expect(getAntigravityCounterKeyForModel(modelId)).toBe("google-argon");
	});

	it("does not interpret legacy mixed counters as Argon quota or eligibility", () => {
		const report: UsageReport = {
			provider: "google-antigravity",
			fetchedAt: Date.now(),
			limits: [
				{ ...makeLimit(1), id: "google-antigravity:google:default:weekly" },
				{ ...makeLimit(0), id: "google-antigravity:default:default:weekly" },
			],
		};
		const context = { modelId: "gemini-4-argon" };
		expect(scopeAntigravityLimitsForModel(report, context)).toEqual([]);
		expect(antigravityRankingStrategy.findWindowLimits(report, context).primary).toBeUndefined();
		expect(antigravityRankingStrategy.modelAvailability?.(context)?.(report)).toBeUndefined();
		expect(antigravityRankingStrategy.modelAvailability?.(context)?.(null)).toBeUndefined();
	});

	it.each([undefined, 0, Number.NaN, 0.2])(
		"only heals a same-counter block from measured positive quota (%s)",
		remaining => {
			const limit: UsageLimit = {
				id: "google-antigravity:google-argon:default:weekly",
				label: "Argon",
				scope: { provider: "google-antigravity" },
				amount: { unit: "percent", remainingFraction: remaining },
				status: remaining === 0 ? "exhausted" : "unknown",
			};
			const report: UsageReport = { provider: "google-antigravity", fetchedAt: Date.now(), limits: [limit] };
			const healing = antigravityRankingStrategy.healableBlockScopes?.(report);
			expect(healing?.find(scope => scope.blockScope === "counter:google-argon")?.healthy).toBe(remaining === 0.2);
			expect(healing?.some(scope => scope.blockScope === "counter:google")).toBeFalse();
		},
	);

	it("does not infer plan permission from a present but unmeasured Argon bucket", async () => {
		const fetchImpl: FetchImpl = async () => {
			return new Response(
				JSON.stringify({
					buckets: [{ bucketId: "gemini-argon-wtu-weekly", window: "weekly" }],
				}),
				{ status: 200 },
			);
		};
		const report = await antigravityUsageProvider.fetchUsage!(
			{ provider: "google-antigravity", credential: makeCredential() },
			makeCtx(fetchImpl),
		);
		expect(report?.limits[0]?.status).toBe("unknown");
		expect(antigravityRankingStrategy.modelAvailability?.({ modelId: "gemini-4-argon" })?.(report!)).toBeUndefined();
		expect(antigravityRankingStrategy.healableBlockScopes?.(report!)[0]?.healthy).toBeFalse();
	});

	it("requires all reported windows to prove recovery and honors an explicit disabled roster", () => {
		const report: UsageReport = {
			provider: "google-antigravity",
			fetchedAt: Date.now(),
			limits: [
				{ ...makeLimit(0.8), id: "google-antigravity:google-argon:default:5h" },
				{
					id: "google-antigravity:google-argon:default:weekly",
					label: "Argon Weekly",
					scope: { provider: "google-antigravity" },
					amount: { unit: "percent" },
					status: "unknown",
				},
			],
		};
		expect(antigravityRankingStrategy.healableBlockScopes?.(report)[0]?.healthy).toBeFalse();
		const gate = antigravityRankingStrategy.modelAvailability?.({ modelId: "gemini-4-argon" });
		expect(gate?.(report)).toBeTrue();
		expect(gate?.({ ...report, metadata: { argonEligible: false } })).toBeFalse();
	});

	it("maps the most-pressured counter to primary and leaves secondary unset", () => {
		// fetchAntigravityUsage sorts ascending by remainingFraction, so a real
		// report's limits[0] is always the bottleneck. AuthStorage compares the
		// secondary ranking metrics before primary; leaving secondary unset makes
		// every Antigravity candidate tie there, so the bottleneck counter in
		// primary decides — otherwise [5%, 90%] remaining can beat [40%, 40%]
		// because the runner-up counter looks healthier.
		const report = {
			provider: "google-antigravity" as const,
			fetchedAt: Date.now(),
			limits: [makeLimit(0.05, "Anthropic"), makeLimit(0.4, "Google"), makeLimit(0.9, "OpenAI")],
		};
		const { primary, secondary } = antigravityRankingStrategy.findWindowLimits(report);
		expect(primary?.label).toBe("Anthropic");
		expect(secondary).toBeUndefined();
	});

	it("lets a weekly Antigravity quota become the ranking bottleneck", () => {
		const daily = makeLimit(0.8, "Google Daily");
		const weekly = makeLimit(0.2, "Google Weekly");
		daily.scope.windowId = "daily";
		daily.window = {
			id: "daily",
			label: "Daily",
			durationMs: 24 * 60 * 60 * 1000,
		};
		weekly.scope.windowId = "weekly";
		weekly.window = {
			id: "weekly",
			label: "Weekly",
			durationMs: 7 * 24 * 60 * 60 * 1000,
		};
		const report = {
			provider: "google-antigravity" as const,
			fetchedAt: Date.now(),
			limits: [weekly, daily],
		};

		const { primary, secondary } = antigravityRankingStrategy.findWindowLimits(report);
		expect(primary).toBe(weekly);
		expect(secondary).toBeUndefined();
	});

	it("returns undefined windows when the credential has no usage limits", () => {
		const report = {
			provider: "google-antigravity" as const,
			fetchedAt: Date.now(),
			limits: [],
		};
		const { primary, secondary } = antigravityRankingStrategy.findWindowLimits(report);
		expect(primary).toBeUndefined();
		expect(secondary).toBeUndefined();
	});
});
