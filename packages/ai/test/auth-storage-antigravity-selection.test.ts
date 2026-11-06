/**
 * Antigravity OAuth ranking smoke test. Proves the
 * `antigravityRankingStrategy` is wired into `DEFAULT_RANKING_STRATEGIES`
 * (issue #2198): a credential whose usage report shows an exhausted
 * counter must be skipped in favour of a healthy sibling on the next
 * `getApiKey` call.
 *
 * Without the registration `getApiKey` would round-robin between
 * credentials and could pin a session to the exhausted account.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { antigravityUsageProvider } from "@oh-my-pi/pi-ai/usage/google-antigravity";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;
const STALE_BLOCK_GUARD_MS = 5 * 60_000 + 1;

/** Age persisted block rows past the post-429 probe guard so healing may run. */
function ageCredentialBlockRows(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		db.prepare("UPDATE auth_credential_blocks SET updated_at = ?").run(
			Math.floor((Date.now() - STALE_BLOCK_GUARD_MS) / 1000),
		);
	} finally {
		db.close();
	}
}

type AntigravityWindowSpec = {
	counter: "google" | "google-argon" | "anthropic" | "openai" | "default";
	usedFraction: number;
	resetInMs: number;
};

function createAntigravityLimit(spec: AntigravityWindowSpec, projectId: string): UsageLimit {
	const used = Math.min(Math.max(spec.usedFraction, 0), 1);
	return {
		id: `google-antigravity:${spec.counter}:default:WINDOW_DAILY`,
		label: `Usage (${spec.counter})`,
		scope: {
			provider: "google-antigravity",
			projectId,
			windowId: "WINDOW_DAILY",
		},
		window: {
			id: "WINDOW_DAILY",
			label: "Default",
			resetsAt: Date.now() + spec.resetInMs,
		},
		amount: {
			unit: "percent",
			used: used * 100,
			limit: 100,
			remaining: (1 - used) * 100,
			usedFraction: used,
			remainingFraction: 1 - used,
		},
		status: used >= 1 ? "exhausted" : used >= 0.9 ? "warning" : "ok",
	};
}

function createAntigravityReport(args: {
	projectId: string;
	accountId: string;
	windows: AntigravityWindowSpec[];
	argonEligible?: boolean;
	availableModelIds?: string[];
}): UsageReport {
	// fetchAntigravityUsage sorts ascending by remainingFraction; mirror
	// that here so the strategy sees the same shape it would in production.
	const limits = args.windows
		.map(w => createAntigravityLimit(w, args.projectId))
		.sort((a, b) => (a.amount.remainingFraction ?? 1) - (b.amount.remainingFraction ?? 1));
	return {
		provider: "google-antigravity",
		fetchedAt: Date.now(),
		limits,
		metadata: {
			accountId: args.accountId,
			projectId: args.projectId,
			argonEligible: args.argonEligible,
			availableModelIds: args.availableModelIds,
		},
	};
}

function createCredential(accountId: string, projectId: string, email: string): OAuthCredentials {
	return {
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + HOUR_MS,
		accountId,
		projectId,
		email,
	};
}

describe("AuthStorage google-antigravity oauth ranking", () => {
	let tempDir = "";
	let dbPath = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;
	const usageByAccount = new Map<string, UsageReport>();

	const usageProvider: UsageProvider = {
		id: "google-antigravity",
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			if (!accountId) return null;
			return usageByAccount.get(accountId) ?? null;
		},
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-antigravity-selection-"));
		dbPath = path.join(tempDir, "agent.db");
		store = await SqliteAuthCredentialStore.open(dbPath);
		authStorage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "google-antigravity" ? usageProvider : undefined),
		});
		usageByAccount.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials["google-antigravity"] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return {
				apiKey: `api-${credential.accountId}`,
				newCredentials: credential,
			};
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("blocks exhausted Antigravity Gemini counter without blocking healthy Claude counter", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.credentials.set("google-antigravity", [
			{
				type: "oauth",
				...createCredential("acct-gemini-exhausted", "proj-gemini-exhausted", "exhausted@example.com"),
			},
			{
				type: "oauth",
				...createCredential("acct-gemini-healthy", "proj-gemini-healthy", "healthy@example.com"),
			},
		]);

		usageByAccount.set(
			"acct-gemini-exhausted",
			createAntigravityReport({
				accountId: "acct-gemini-exhausted",
				projectId: "proj-gemini-exhausted",
				windows: [
					{ counter: "google", usedFraction: 1, resetInMs: 12 * HOUR_MS },
					{ counter: "anthropic", usedFraction: 0.05, resetInMs: 12 * HOUR_MS },
				],
			}),
		);
		usageByAccount.set(
			"acct-gemini-healthy",
			createAntigravityReport({
				accountId: "acct-gemini-healthy",
				projectId: "proj-gemini-healthy",
				windows: [
					{ counter: "google", usedFraction: 0.3, resetInMs: 20 * HOUR_MS },
					{ counter: "anthropic", usedFraction: 0.7, resetInMs: 20 * HOUR_MS },
				],
			}),
		);

		const geminiKey = await authStorage.keys.get("google-antigravity", "session-antigravity-gemini", {
			modelId: "gemini-3-flash",
		});
		expect(geminiKey).toBe("api-acct-gemini-healthy");

		const counts = new Map<string, number>();
		for (let i = 0; i < 80; i += 1) {
			const apiKey = await authStorage.keys.get("google-antigravity", `session-antigravity-claude-${i}`, {
				modelId: "claude-sonnet-4-5",
			});
			if (!apiKey) continue;
			counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
		}

		expect(counts.get("api-acct-gemini-exhausted") ?? 0).toBeGreaterThan(counts.get("api-acct-gemini-healthy") ?? 0);
	});

	test("ranks by bottleneck counter instead of healthier secondary counter", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.credentials.set("google-antigravity", [
			{
				type: "oauth",
				...createCredential("acct-gemini-hot", "proj-gemini-hot", "hot@example.com"),
			},
			{
				type: "oauth",
				...createCredential("acct-balanced", "proj-balanced", "balanced@example.com"),
			},
		]);

		usageByAccount.set(
			"acct-gemini-hot",
			createAntigravityReport({
				accountId: "acct-gemini-hot",
				projectId: "proj-gemini-hot",
				windows: [
					{ counter: "google", usedFraction: 0.95, resetInMs: 8 * HOUR_MS },
					{ counter: "anthropic", usedFraction: 0, resetInMs: 8 * HOUR_MS },
				],
			}),
		);
		usageByAccount.set(
			"acct-balanced",
			createAntigravityReport({
				accountId: "acct-balanced",
				projectId: "proj-balanced",
				windows: [
					{ counter: "google", usedFraction: 0.8, resetInMs: 8 * HOUR_MS },
					{ counter: "anthropic", usedFraction: 0.7, resetInMs: 8 * HOUR_MS },
				],
			}),
		);

		const counts = new Map<string, number>();
		for (let i = 0; i < 80; i += 1) {
			const apiKey = await authStorage.keys.get("google-antigravity", `session-antigravity-bottleneck-${i}`, {
				modelId: "gemini-3-flash",
			});
			if (!apiKey) continue;
			counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
		}

		expect(counts.get("api-acct-balanced") ?? 0).toBeGreaterThan(counts.get("api-acct-gemini-hot") ?? 0);
	});
	test("a healthy Gemini counter report clears a stale counter block without touching a still-exhausted sibling counter", async () => {
		if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
			throw new Error("test setup failed");
		}

		await authStorage.credentials.set("google-antigravity", [
			{
				type: "oauth",
				...createCredential("acct-recovered", "proj-recovered", "recovered@example.com"),
			},
		]);
		const row = store.listAuthCredentials("google-antigravity")[0];
		if (!row) throw new Error("expected credential row");

		// A 429 whose retry-after pointed at the weekly reset, days ahead of
		// Google actually restoring the quota.
		const weekAhead = Date.now() + 6 * 24 * HOUR_MS;
		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: "google-antigravity:oauth",
			blockScope: "counter:google",
			blockedUntilMs: weekAhead,
		});
		store.upsertCredentialBlock({
			credentialId: row.id,
			providerKey: "google-antigravity:oauth",
			blockScope: "counter:anthropic",
			blockedUntilMs: weekAhead,
		});
		ageCredentialBlockRows(dbPath);
		store.cleanExpiredCredentialBlocks?.(Date.now() + STALE_BLOCK_GUARD_MS);

		usageByAccount.set(
			"acct-recovered",
			createAntigravityReport({
				accountId: "acct-recovered",
				projectId: "proj-recovered",
				windows: [
					{ counter: "google", usedFraction: 0, resetInMs: 5 * HOUR_MS },
					{
						counter: "anthropic",
						usedFraction: 1,
						resetInMs: 6 * 24 * HOUR_MS,
					},
				],
			}),
		);

		await authStorage.usage.reports();

		expect(store.getCredentialBlock(row.id, "google-antigravity:oauth", "counter:google")).toBeUndefined();
		expect(store.getCredentialBlock(row.id, "google-antigravity:oauth", "counter:anthropic")).toBe(weekAhead);

		const geminiKey = await authStorage.keys.get("google-antigravity", "session-antigravity-recovered", {
			modelId: "gemini-3-flash",
		});
		expect(geminiKey).toBe("api-acct-recovered");
	});

	test("prefers less-pressured antigravity account when neither is exhausted", async () => {
		if (!authStorage) throw new Error("test setup failed");

		await authStorage.credentials.set("google-antigravity", [
			{
				type: "oauth",
				...createCredential("acct-loaded", "proj-loaded", "loaded@example.com"),
			},
			{
				type: "oauth",
				...createCredential("acct-fresh", "proj-fresh", "fresh@example.com"),
			},
		]);

		usageByAccount.set(
			"acct-loaded",
			createAntigravityReport({
				accountId: "acct-loaded",
				projectId: "proj-loaded",
				windows: [{ counter: "google", usedFraction: 0.8, resetInMs: 4 * HOUR_MS }],
			}),
		);
		usageByAccount.set(
			"acct-fresh",
			createAntigravityReport({
				accountId: "acct-fresh",
				projectId: "proj-fresh",
				windows: [{ counter: "google", usedFraction: 0.05, resetInMs: 4 * HOUR_MS }],
			}),
		);

		// Sample several sessions; the weighted picker must favour the fresh
		// account by a clear margin even though both are unblocked.
		const counts = new Map<string, number>();
		for (let i = 0; i < 60; i += 1) {
			const apiKey = await authStorage.keys.get("google-antigravity", `session-antigravity-fresh-${i}`, {
				modelId: "gemini-3-flash",
			});
			if (!apiKey) continue;
			counts.set(apiKey, (counts.get(apiKey) ?? 0) + 1);
		}

		const fresh = counts.get("api-acct-fresh") ?? 0;
		const loaded = counts.get("api-acct-loaded") ?? 0;
		expect(fresh).toBeGreaterThan(loaded);
	});

	test.each([
		[true, 0.2],
		[true, 0.95],
		[false, 0.2],
	] as const)(
		"prefers measured Argon quota over an unmeasured account (eligible=%s, measured usage=%s)",
		async (argonEligible, usedFraction) => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.credentials.set("google-antigravity", [
				{ type: "oauth", ...createCredential("acct-unknown", "proj-unknown", "unknown@example.com") },
				{ type: "oauth", ...createCredential("acct-measured", "proj-measured", "measured@example.com") },
			]);
			usageByAccount.set(
				"acct-unknown",
				createAntigravityReport({
					accountId: "acct-unknown",
					projectId: "proj-unknown",
					// Roster eligibility never proves remaining Argon quota.
					argonEligible,
					windows: [{ counter: "google", usedFraction: 0.01, resetInMs: 5 * HOUR_MS }],
				}),
			);
			usageByAccount.set(
				"acct-measured",
				createAntigravityReport({
					accountId: "acct-measured",
					projectId: "proj-measured",
					argonEligible: true,
					windows: [
						{ counter: "google", usedFraction: 1, resetInMs: 5 * HOUR_MS },
						{ counter: "google-argon", usedFraction, resetInMs: 5 * HOUR_MS },
					],
				}),
			);

			expect(
				await authStorage.keys.get("google-antigravity", "argon-measured-first", { modelId: "gemini-4-argon" }),
			).toBe("api-acct-measured");
		},
	);

	test("keeps an account usable when Argon quota and roster eligibility are unknown", async () => {
		if (!authStorage || !store?.getCredentialBlock) throw new Error("test setup failed");
		await authStorage.credentials.set("google-antigravity", [
			{ type: "oauth", ...createCredential("acct-unreported", "proj-unreported", "unreported@example.com") },
		]);
		usageByAccount.set(
			"acct-unreported",
			createAntigravityReport({
				accountId: "acct-unreported",
				projectId: "proj-unreported",
				windows: [{ counter: "google", usedFraction: 0.1, resetInMs: 5 * HOUR_MS }],
			}),
		);

		expect(
			await authStorage.keys.get("google-antigravity", "argon-unreported-fallback", { modelId: "gemini-4-argon" }),
		).toBe("api-acct-unreported");
		const row = store.listAuthCredentials("google-antigravity")[0];
		if (!row) throw new Error("expected credential row");
		expect(store.getCredentialBlock(row.id, "google-antigravity:oauth", "counter:google-argon")).toBeUndefined();
	});

	test("tries unblocked unknown Argon access before a known eligible but exhausted account", async () => {
		if (!authStorage || !store?.getCredentialBlock) throw new Error("test setup failed");
		await authStorage.credentials.set("google-antigravity", [
			{ type: "oauth", ...createCredential("acct-exhausted", "proj-exhausted", "exhausted@example.com") },
			{ type: "oauth", ...createCredential("acct-unknown", "proj-unknown", "unknown@example.com") },
		]);
		usageByAccount.set(
			"acct-exhausted",
			createAntigravityReport({
				accountId: "acct-exhausted",
				projectId: "proj-exhausted",
				argonEligible: true,
				windows: [{ counter: "google-argon", usedFraction: 1, resetInMs: 24 * HOUR_MS }],
			}),
		);
		usageByAccount.set(
			"acct-unknown",
			createAntigravityReport({
				accountId: "acct-unknown",
				projectId: "proj-unknown",
				windows: [{ counter: "google", usedFraction: 0, resetInMs: 5 * HOUR_MS }],
			}),
		);
		expect(
			await authStorage.keys.get("google-antigravity", "argon-unknown-before-blocked", {
				modelId: "gemini-4-argon",
			}),
		).toBe("api-acct-unknown");
		const exhausted = store.listAuthCredentials("google-antigravity")[0];
		if (!exhausted) throw new Error("expected exhausted credential");
		expect(
			store.getCredentialBlock(exhausted.id, "google-antigravity:oauth", "counter:google-argon"),
		).toBeGreaterThan(Date.now());
	});

	test("retains a healthy warm Argon pin without probing siblings after usage cache invalidation", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.credentials.set("google-antigravity", [
			{ type: "oauth", ...createCredential("acct-pin", "proj-pin", "pin@example.com") },
			{ type: "oauth", ...createCredential("acct-peer", "proj-peer", "peer@example.com") },
		]);
		for (const [accountId, usedFraction] of [
			["acct-pin", 0.1],
			["acct-peer", 0.3],
		] as const) {
			usageByAccount.set(
				accountId,
				createAntigravityReport({
					accountId,
					projectId: `proj-${accountId}`,
					argonEligible: true,
					windows: [{ counter: "google-argon", usedFraction, resetInMs: 24 * HOUR_MS }],
				}),
			);
		}
		const options = { modelId: "gemini-4-argon" };
		expect(await authStorage.keys.get("google-antigravity", "argon-warm", options)).toBe("api-acct-pin");
		await authStorage.usage.invalidate("google-antigravity");
		const probe = vi.spyOn(usageProvider, "fetchUsage");
		expect(await authStorage.keys.get("google-antigravity", "argon-warm", options)).toBe("api-acct-pin");
		expect(probe.mock.calls.map(([params]) => params.credential.accountId)).toEqual(["acct-pin"]);
	});

	test("rejects an explicitly unavailable Argon account in every fallback while ordinary Gemini stays usable", async () => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.credentials.set("google-antigravity", [
			{ type: "oauth", ...createCredential("acct-disabled", "proj-disabled", "disabled@example.com") },
		]);
		usageByAccount.set(
			"acct-disabled",
			createAntigravityReport({
				accountId: "acct-disabled",
				projectId: "proj-disabled",
				argonEligible: false,
				windows: [{ counter: "google", usedFraction: 0, resetInMs: 5 * HOUR_MS }],
			}),
		);
		expect(
			await authStorage.keys.get("google-antigravity", "argon-unavailable", { modelId: "gemini-4-argon" }),
		).toBeUndefined();
		expect(
			await authStorage.health.model("google-antigravity", { modelId: "gemini-4-argon", reserveFraction: 0.1 }),
		).toMatchObject({
			state: "depleted",
			accounts: [],
		});
		expect(
			await authStorage.keys.get("google-antigravity", "ordinary-available", { modelId: "gemini-3.8-flash" }),
		).toBe("api-acct-disabled");
	});

	test.each([
		[1, "depleted"],
		[0.95, "reserve"],
		[undefined, "unknown"],
	] as const)("excludes unavailable Argon accounts from pool health (%s used)", async (usedFraction, state) => {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.credentials.set("google-antigravity", [
			{ type: "oauth", ...createCredential("acct-disabled", "proj-disabled", "disabled@example.com") },
			{ type: "oauth", ...createCredential("acct-other", "proj-other", "other@example.com") },
		]);
		usageByAccount.set(
			"acct-disabled",
			createAntigravityReport({
				accountId: "acct-disabled",
				projectId: "proj-disabled",
				argonEligible: false,
				windows: [{ counter: "google", usedFraction: 0, resetInMs: 5 * HOUR_MS }],
			}),
		);
		usageByAccount.set(
			"acct-other",
			createAntigravityReport({
				accountId: "acct-other",
				projectId: "proj-other",
				windows: usedFraction === undefined ? [] : [{ counter: "google-argon", usedFraction, resetInMs: HOUR_MS }],
			}),
		);
		const health = await authStorage.health.model("google-antigravity", {
			modelId: "gemini-4-argon",
			reserveFraction: 0.1,
		});
		expect(health.state).toBe(state);
		expect(health.accounts.map(account => account.credentialId)).toEqual([
			authStorage.credentials.list("google-antigravity")[1]!.id,
		]);
	});

	test.each(["missing", "exhausted"] as const)(
		"ordinary Gemini recovery cannot heal an Argon block when Argon usage is %s",
		async argonUsage => {
			if (!authStorage || !store?.upsertCredentialBlock || !store.getCredentialBlock) {
				throw new Error("test setup failed");
			}
			await authStorage.credentials.set("google-antigravity", [
				{ type: "oauth", ...createCredential("acct-blocked", "proj-blocked", "blocked@example.com") },
				{ type: "oauth", ...createCredential("acct-sibling", "proj-sibling", "sibling@example.com") },
			]);
			const row = store.listAuthCredentials("google-antigravity")[0];
			if (!row) throw new Error("expected credential row");
			const blockedUntilMs = Date.now() + 24 * HOUR_MS;
			store.upsertCredentialBlock({
				credentialId: row.id,
				providerKey: "google-antigravity:oauth",
				blockScope: "counter:google-argon",
				blockedUntilMs,
			});
			ageCredentialBlockRows(dbPath);
			const windows: AntigravityWindowSpec[] = [{ counter: "google", usedFraction: 0, resetInMs: 5 * HOUR_MS }];
			if (argonUsage === "exhausted") {
				windows.push({ counter: "google-argon", usedFraction: 1, resetInMs: 24 * HOUR_MS });
			}
			usageByAccount.set(
				"acct-blocked",
				createAntigravityReport({
					accountId: "acct-blocked",
					projectId: "proj-blocked",
					argonEligible: true,
					windows,
				}),
			);
			usageByAccount.set(
				"acct-sibling",
				createAntigravityReport({
					accountId: "acct-sibling",
					projectId: "proj-sibling",
					argonEligible: true,
					windows: [{ counter: "google-argon", usedFraction: 0.3, resetInMs: 5 * HOUR_MS }],
				}),
			);

			// Run reconciliation after the guard expires, rather than merely
			// checking that a freshly-written block survives its five-minute guard.
			await authStorage.usage.reports();
			expect(store.getCredentialBlock(row.id, "google-antigravity:oauth", "counter:google-argon")).toBe(
				blockedUntilMs,
			);
			expect(
				await authStorage.keys.get("google-antigravity", "argon-still-blocked", { modelId: "gemini-4-argon" }),
			).toBe("api-acct-sibling");
			expect(
				await authStorage.keys.get("google-antigravity", "ordinary-gemini-recovered", {
					modelId: "gemini-3-flash",
				}),
			).toBe("api-acct-blocked");
		},
	);

	test("QUOTA_EXHAUSTED rotates a warm Argon session and persists its block for another AuthStorage instance", async () => {
		if (!authStorage || !store?.getCredentialBlock) throw new Error("test setup failed");
		await authStorage.credentials.set("google-antigravity", [
			{ type: "oauth", ...createCredential("acct-first", "proj-first", "first@example.com") },
			{ type: "oauth", ...createCredential("acct-next", "proj-next", "next@example.com") },
		]);
		for (const [accountId, projectId, usedFraction] of [
			["acct-first", "proj-first", 0.05],
			["acct-next", "proj-next", 0.3],
		] as const) {
			usageByAccount.set(
				accountId,
				createAntigravityReport({
					accountId,
					projectId,
					argonEligible: true,
					windows: [
						{ counter: "google", usedFraction, resetInMs: 5 * HOUR_MS },
						{ counter: "google-argon", usedFraction, resetInMs: 5 * HOUR_MS },
					],
				}),
			);
		}
		const firstSession = "argon-warm-session";
		const modelId = "gemini-4-argon";
		const firstKey = await authStorage.keys.get("google-antigravity", firstSession, { modelId });
		expect(firstKey).toBe("api-acct-first");
		const row = store.listAuthCredentials("google-antigravity")[0];
		if (!row) throw new Error("expected credential row");

		const peerStore = await SqliteAuthCredentialStore.open(dbPath);
		try {
			const peerStorage = new AuthStorage(peerStore, {
				usageProviderResolver: provider => (provider === "google-antigravity" ? usageProvider : undefined),
			});
			await peerStorage.credentials.reload();
			// Give the other instance its own warm pin and cached pre-429 report.
			expect(await peerStorage.keys.get("google-antigravity", "argon-peer-session", { modelId })).toBe(firstKey);
			const rotation = await authStorage.limits.rotate("google-antigravity", firstSession, {
				modelId,
				apiKey: firstKey,
				credentialId: row.id,
				error: new ProviderHttpError(
					'Cloud Code Assist API error (429): {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exhausted","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"QUOTA_EXHAUSTED"}]}}',
					429,
				),
			});
			expect(rotation.switched).toBe(true);
			const blockedUntilMs = store.getCredentialBlock(row.id, "google-antigravity:oauth", "counter:google-argon");
			expect(blockedUntilMs).toBeGreaterThan(Date.now());
			expect(store.getCredentialBlock(row.id, "google-antigravity:oauth", "counter:google")).toBeUndefined();
			expect(store.getCredentialBlock(row.id, "google-antigravity:oauth", "auth")).toBeUndefined();

			// Lagging healthy usage must not immediately undo the actual 429.
			await authStorage.usage.reports();
			for (let attempt = 0; attempt < 3; attempt += 1) {
				expect(await authStorage.keys.get("google-antigravity", firstSession, { modelId })).toBe("api-acct-next");
			}
			expect(await peerStorage.keys.get("google-antigravity", "argon-peer-session", { modelId })).toBe(
				"api-acct-next",
			);
			expect(peerStore.getCredentialBlock?.(row.id, "google-antigravity:oauth", "counter:google-argon")).toBe(
				blockedUntilMs,
			);
			expect(
				await authStorage.keys.get("google-antigravity", "ordinary-after-argon-429", {
					modelId: "gemini-3-flash",
				}),
			).toBe(firstKey);
		} finally {
			peerStore.close();
		}
	});

	test.each([
		["gemini-4-argon", "google-argon"],
		["gemini-3.8-flash", "google"],
		["claude-opus-5-5", "anthropic"],
		["gpt-oss-120b", "openai"],
	] as const)("switches %s to an externally added funded account despite a stale roster", async (modelId, counter) => {
		if (!authStorage || !store?.getCredentialBlock) throw new Error("test setup failed");
		const provider = "google-antigravity";
		const sessionId = "added-after-discovery";
		const options = { modelId, accountIds: ["acct-old"] };
		await authStorage.credentials.set(provider, [
			{ type: "oauth", ...createCredential("acct-old", "proj-old", "old@example.com") },
		]);
		usageByAccount.set(
			"acct-old",
			createAntigravityReport({
				accountId: "acct-old",
				projectId: "proj-old",
				windows: [{ counter, usedFraction: 1, resetInMs: 80 * HOUR_MS }],
			}),
		);
		const oldRow = store.listAuthCredentials(provider)[0];
		if (!oldRow) throw new Error("expected old credential row");
		expect(await authStorage.keys.get(provider, sessionId, options)).toBe("api-acct-old");
		// A single-account session can skip usage preflight until a real 429.
		await authStorage.limits.markReached(provider, sessionId, {
			modelId,
			retryAfterMs: 80 * HOUR_MS,
			providerTimed: true,
		});
		const blockScope = `counter:${counter}`;
		const blockedUntil = store.getCredentialBlock(oldRow.id, "google-antigravity:oauth", blockScope);
		expect(blockedUntil).toBeGreaterThan(Date.now());

		// Both the running storage and model roster predate a sibling login.
		const peerStore = await SqliteAuthCredentialStore.open(dbPath);
		try {
			await peerStore.saveOAuth(provider, createCredential("acct-added", "proj-added", "added@example.com"));
		} finally {
			peerStore.close();
		}
		usageByAccount.set(
			"acct-added",
			createAntigravityReport({
				accountId: "acct-added",
				projectId: "proj-added",
				windows: [{ counter, usedFraction: 0, resetInMs: 7 * 24 * HOUR_MS }],
				availableModelIds: [modelId],
			}),
		);

		expect(await authStorage.keys.get(provider, sessionId, options)).toBe("api-acct-added");
		expect(store.getCredentialBlock(oldRow.id, "google-antigravity:oauth", blockScope)).toBe(blockedUntil);
	});

	test.each([
		["unknown", "api-acct-listed"],
		["disabled", "api-acct-listed"],
	] as const)(
		"does not bypass discovery for unverified or disabled Argon access (%s)",
		async (access, expectedKey) => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.credentials.set("google-antigravity", [
				{ type: "oauth", ...createCredential("acct-listed", "proj-listed", "listed@example.com") },
				{ type: "oauth", ...createCredential("acct-unlisted", "proj-unlisted", "unlisted@example.com") },
			]);
			usageByAccount.set(
				"acct-listed",
				createAntigravityReport({
					accountId: "acct-listed",
					projectId: "proj-listed",
					windows: [{ counter: "google-argon", usedFraction: 1, resetInMs: 80 * HOUR_MS }],
				}),
			);
			usageByAccount.set(
				"acct-unlisted",
				createAntigravityReport({
					accountId: "acct-unlisted",
					projectId: "proj-unlisted",
					argonEligible: access === "disabled" ? false : undefined,
					windows: [
						{ counter: access === "disabled" ? "google-argon" : "google", usedFraction: 0, resetInMs: HOUR_MS },
					],
				}),
			);
			expect(
				await authStorage.keys.get("google-antigravity", `argon-unlisted-${access}`, {
					modelId: "gemini-4-argon",
					accountIds: ["acct-listed"],
				}),
			).toBe(expectedKey);
		},
	);

	test("stale Claude discovery never widens an explicit session account pool", async () => {
		if (!authStorage) throw new Error("test setup failed");
		const provider = "google-antigravity";
		const sessionId = "restricted-claude-pool";
		await authStorage.credentials.set(provider, [
			{ type: "oauth", ...createCredential("acct-permitted", "proj-permitted", "permitted@example.com") },
			{ type: "oauth", ...createCredential("acct-outside", "proj-outside", "outside@example.com") },
		]);
		for (const [accountId, usedFraction] of [
			["acct-permitted", 1],
			["acct-outside", 0],
		] as const) {
			usageByAccount.set(
				accountId,
				createAntigravityReport({
					accountId,
					projectId: `proj-${accountId}`,
					windows: [{ counter: "anthropic", usedFraction, resetInMs: HOUR_MS }],
				}),
			);
		}
		const lease = authStorage.sessions.restrict(provider, sessionId, ["account:acct-permitted"]);
		try {
			expect(
				await authStorage.keys.get(provider, sessionId, {
					modelId: "claude-opus-5-5",
					accountIds: ["acct-permitted"],
				}),
			).toBe("api-acct-permitted");
		} finally {
			authStorage.sessions.unrestrict(provider, sessionId, lease);
		}
	});

	test("never selects an unsupported Opus revision merely because shared quota remains", async () => {
		if (!store) throw new Error("test setup failed");
		const provider = "google-antigravity";
		let addedEnabled = true;
		const checkedStorage = new AuthStorage(store, {
			usageProviderResolver: p => (p === provider ? antigravityUsageProvider : undefined),
			usageFetch: Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
					const bearer = new Headers(init?.headers).get("authorization") ?? "";
					const old = bearer.includes("acct-listed");
					const unsupported = bearer.includes("acct-unsupported");
					if (String(input).endsWith(":retrieveUserQuotaSummary")) {
						return Response.json({
							buckets: [
								{ bucketId: "3p-weekly", window: "weekly", remainingFraction: old ? 0 : unsupported ? 1 : 0.4 },
								{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 1 },
							],
						});
					}
					return Response.json({
						models: unsupported
							? { "claude-opus-4-6": {} }
							: { "claude-opus-5-5-high": { disabled: !old && !addedEnabled } },
					});
				},
				{ preconnect: fetch.preconnect },
			),
		});
		try {
			await checkedStorage.credentials.set(provider, [
				{ type: "oauth", ...createCredential("acct-listed", "proj-listed", "listed@example.com") },
				{ type: "oauth", ...createCredential("acct-unsupported", "proj-unsupported", "unsupported@example.com") },
				{ type: "oauth", ...createCredential("acct-added", "proj-added", "added@example.com") },
			]);
			const options = { modelId: "claude-opus-5-5", accountIds: ["acct-listed"] };
			expect(await checkedStorage.keys.get(provider, "exact-opus-access", options)).toBe("api-acct-added");

			// Once the newly eligible seat loses access, last-resort selection must
			// retain quota failure semantics, not send 5.5 through a 4.6-only seat.
			addedEnabled = false;
			await checkedStorage.usage.invalidate(provider);
			expect(await checkedStorage.keys.get(provider, "exact-opus-access", options)).toBe("api-acct-listed");
		} finally {
			checkedStorage.close();
			store = null;
		}
	});

	test("keeps a real Argon cooldown and switches siblings when only the high short window is exhausted", async () => {
		if (!store?.getCredentialBlock) throw new Error("test setup failed");
		const provider = "google-antigravity";
		const resetTime = new Date(Date.now() + HOUR_MS).toISOString();
		const checkedStorage = new AuthStorage(store, {
			usageProviderResolver: p => (p === provider ? antigravityUsageProvider : undefined),
			usageFetch: Object.assign(
				async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
					const old = new Headers(init?.headers).get("authorization")?.includes("acct-short-spent");
					if (String(input).endsWith(":retrieveUserQuotaSummary")) {
						return Response.json({
							buckets: [{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 1 }],
						});
					}
					return Response.json({
						models: {
							"gemini-4-argon-low": { quotaInfo: { remainingFraction: 1, windowId: "weekly" } },
							"gemini-4-argon-high": {
								quotaInfo: {
									windowId: "5h",
									resetTime,
									...(old ? {} : { remainingFraction: 0.5 }),
								},
							},
						},
					});
				},
				{ preconnect: fetch.preconnect },
			),
		});
		try {
			await checkedStorage.credentials.set(provider, [
				{ type: "oauth", ...createCredential("acct-short-spent", "proj-old", "old@example.com") },
				{ type: "oauth", ...createCredential("acct-short-funded", "proj-new", "new@example.com") },
			]);
			const old = store.listAuthCredentials(provider)[0];
			if (!old) throw new Error("expected old credential");
			const blockedUntilMs = Date.parse(resetTime);
			checkedStorage.blocks.upsert({
				credentialId: old.id,
				providerKey: "google-antigravity:oauth",
				blockScope: "counter:google-argon",
				blockedUntilMs,
			});
			ageCredentialBlockRows(dbPath);
			checkedStorage.sessions.pin(provider, "argon-high-cooldown", old.id);
			await checkedStorage.usage.reports({ provider });
			expect(store.getCredentialBlock(old.id, "google-antigravity:oauth", "counter:google-argon")).toBe(
				blockedUntilMs,
			);
			expect(
				await checkedStorage.keys.get(provider, "argon-high-cooldown", {
					modelId: "gemini-4-argon",
					accountIds: ["acct-short-spent"],
				}),
			).toBe("api-acct-short-funded");
		} finally {
			checkedStorage.close();
			store = null;
		}
	});
});
