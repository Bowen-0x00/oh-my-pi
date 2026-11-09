import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { AccountLoadCoordinator, accountLoadCoordinator, type AccountRequestLease } from "../src/auth/account-load";
import type { AuthApiKeyOptions } from "../src/auth/types";

const PROVIDER = "google-antigravity";
const MODEL = "gemini-4-argon";
const HOUR_MS = 60 * 60 * 1000;

function report(accountId: string, usedFraction: number, argonEligible = true): UsageReport {
	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		limits: [
			{
				id: `${PROVIDER}:google-argon:default:WINDOW_DAILY`,
				label: "Argon",
				scope: { provider: PROVIDER, projectId: "shared-project", windowId: "WINDOW_DAILY" },
				window: { id: "WINDOW_DAILY", label: "Daily", resetsAt: Date.now() + 5 * HOUR_MS },
				amount: {
					unit: "percent",
					used: usedFraction * 100,
					limit: 100,
					remaining: (1 - usedFraction) * 100,
					usedFraction,
					remainingFraction: 1 - usedFraction,
				},
				status: usedFraction >= 1 ? "exhausted" : "ok",
			},
		],
		metadata: { accountId, projectId: "shared-project", argonEligible },
	};
}

describe("request-scoped OAuth account load selection", () => {
	let tempDir: string;
	let store: SqliteAuthCredentialStore;
	let auth: AuthStorage;
	let coordinator: AccountLoadCoordinator;
	const leases: AccountRequestLease[] = [];
	const reports = new Map<string, UsageReport>();
	const usageProvider: UsageProvider = {
		id: PROVIDER,
		async fetchUsage(params) {
			return reports.get(params.credential.accountId ?? "") ?? null;
		},
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-account-load-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		coordinator = new AccountLoadCoordinator(path.join(tempDir, "requests"));
		// Redirect only the root: reservations and live request locks are real.
		vi.spyOn(accountLoadCoordinator, "reserve").mockImplementation((...args) => coordinator.reserve(...args));
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider] as OAuthCredentials | undefined;
			return credential ? { apiKey: `api-${credential.accountId}`, newCredentials: credential } : null;
		});
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => credential);
		reports.clear();
		reports.set("high", report("high", 0.05));
		reports.set("low", report("low", 0.4));
		auth = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
		});
		await auth.credentials.set(
			PROVIDER,
			["high", "low"].map(accountId => ({
				type: "oauth" as const,
				access: `access-${accountId}`,
				refresh: `refresh-${accountId}`,
				expires: Date.now() + 24 * HOUR_MS,
				accountId,
				email: `${accountId}@example.com`,
				projectId: "shared-project",
			})),
		);
	});

	afterEach(async () => {
		await Promise.all(leases.splice(0).map(lease => lease.release()));
		vi.restoreAllMocks();
		store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function request(): Promise<AccountRequestLease> {
		const lease = await coordinator.create(PROVIDER);
		leases.push(lease);
		return lease;
	}

	async function occupy(accountId: string): Promise<AccountRequestLease> {
		const lease = await request();
		expect(await coordinator.reserve(PROVIDER, lease.id, `account:${accountId}`, true)).toBeDefined();
		return lease;
	}

	async function resolve(sessionId: string, options?: AuthApiKeyOptions) {
		const lease = await request();
		return auth.keys.getWithCredential(PROVIDER, sessionId, {
			modelId: MODEL,
			accountRequestId: lease.id,
			...options,
		});
	}

	test("skips a busy higher-quota account for an eligible idle sibling sharing its project", async () => {
		await occupy("high");
		const selected = await resolve("new-session");
		expect(selected?.apiKey).toBe("api-low");
		expect(selected?.accountBusy).toBeUndefined();
		expect(selected?.accountBusyReason).toBeUndefined();
	});

	test("replaces a busy automatic pin only after selecting the idle sibling", async () => {
		expect(await auth.keys.get(PROVIDER, "warm", { modelId: MODEL })).toBe("api-high");
		await occupy("high");
		const selected = await resolve("warm");
		expect(selected?.apiKey).toBe("api-low");
		expect(auth.oauth.accounts(PROVIDER, "warm").find(account => account.active)?.accountId).toBe("low");
		// A rejected busy candidate must not overwrite the final automatic pin.
		expect(await auth.keys.get(PROVIDER, "warm", { modelId: MODEL })).toBe("api-low");
	});

	test("uses the ranked eligible account when all accounts are busy and retains its own reservation", async () => {
		const high = await occupy("high");
		await occupy("low");
		const selected = await resolve("all-busy");
		expect(selected).toMatchObject({ apiKey: "api-high", accountBusy: true, accountBusyReason: "all-busy" });
		await high.release();
		const observer = await request();
		// The fallback request remains an owner after the original holder exits.
		expect(await coordinator.reserve(PROVIDER, observer.id, "account:high")).toBeUndefined();
	});

	test("keeps an explicit busy pin rather than using an idle sibling", async () => {
		const target = auth.oauth.accounts(PROVIDER).find(account => account.accountId === "high");
		if (!target) throw new Error("expected high account");
		expect(auth.sessions.pin(PROVIDER, "explicit", target.credentialId)).toBe(true);
		await occupy("high");
		expect(await resolve("explicit")).toMatchObject({
			apiKey: "api-high",
			accountBusy: true,
			accountBusyReason: "pinned",
		});
		expect(auth.oauth.accounts(PROVIDER, "explicit").find(account => account.active)?.accountId).toBe("high");
	});

	test("keeps the automatic account during forced refresh even if that account is busy", async () => {
		expect(await auth.keys.get(PROVIDER, "refresh", { modelId: MODEL })).toBe("api-high");
		await occupy("high");
		expect(await resolve("refresh", { forceRefresh: true })).toMatchObject({
			apiKey: "api-high",
			accountBusy: true,
			accountBusyReason: "pinned",
		});
	});

	test("resolver initial selection and same-account auth retry share a real request reservation", async () => {
		await occupy("high");
		const lease = await request();
		const resolver = auth.keys.resolver(PROVIDER, { sessionId: "resolver", modelId: MODEL });
		const initial = await resolver({ lastChance: false, error: undefined, accountRequestId: lease.id });
		if (typeof initial !== "object" || initial === undefined) throw new Error("expected stored OAuth resolution");
		expect(initial.apiKey).toBe("api-low");
		expect(initial.accountBusy).toBeUndefined();
		await occupy("low");
		const retried = await resolver({
			lastChance: false,
			accountRequestId: lease.id,
			previousKey: initial?.apiKey,
			error: Object.assign(new Error("unauthorized"), { status: 401 }),
		});
		expect(retried).toMatchObject({
			apiKey: "api-low",
			accountBusy: true,
			accountBusyReason: "pinned",
		});
	});

	test("refreshes the failed request's account when a concurrent turn changed the same session pin", async () => {
		const firstLease = await request();
		const secondLease = await request();
		const resolver = auth.keys.resolver(PROVIDER, { sessionId: "shared-session", modelId: MODEL });
		const first = await resolver({ lastChance: false, error: undefined, accountRequestId: firstLease.id });
		if (typeof first !== "object" || first === undefined) throw new Error("expected first OAuth resolution");
		expect(first.apiKey).toBe("api-high");
		const second = await resolver({ lastChance: false, error: undefined, accountRequestId: secondLease.id });
		if (typeof second !== "object" || second === undefined) throw new Error("expected second OAuth resolution");
		expect(second.apiKey).toBe("api-low");
		expect(auth.oauth.accounts(PROVIDER, "shared-session").find(account => account.active)?.accountId).toBe("low");

		const retried = await resolver({
			lastChance: false,
			accountRequestId: firstLease.id,
			previousKey: first.apiKey,
			error: Object.assign(new Error("unauthorized"), { status: 401 }),
		});
		expect(retried).toMatchObject({ apiKey: "api-high", credentialId: first.credentialId });
		const observer = await request();
		expect(await coordinator.reserve(PROVIDER, observer.id, "account:high")).toBeUndefined();
	});

	test("busy avoidance does not persist quota or auth blocks", async () => {
		const high = await occupy("high");
		expect((await resolve("avoids-busy"))?.apiKey).toBe("api-low");
		for (const row of store.listAuthCredentials(PROVIDER)) {
			for (const scope of ["auth", "counter:google", "counter:google-argon"]) {
				expect(store.getCredentialBlock(row.id, `${PROVIDER}:oauth`, scope)).toBeUndefined();
			}
		}
		await high.release();
		expect((await resolve("after-release"))?.apiKey).toBe("api-high");
	});

	test("does not trade a strict eligible busy account for an idle exhausted account", async () => {
		reports.set("low", report("low", 1));
		await occupy("high");
		expect(await resolve("strict-pass")).toMatchObject({
			apiKey: "api-high",
			accountBusy: true,
			accountBusyReason: "all-busy",
		});
	});

	test("does not bypass an idle sibling's persisted cooldown just to avoid sharing", async () => {
		const low = auth.oauth.accounts(PROVIDER).find(account => account.accountId === "low");
		if (!low) throw new Error("expected low account");
		expect(auth.sessions.pin(PROVIDER, "cooldown", low.credentialId)).toBe(true);
		await auth.limits.markReached(PROVIDER, "cooldown", {
			modelId: MODEL,
			retryAfterMs: HOUR_MS,
			providerTimed: true,
		});
		const blockedUntil = store.getCredentialBlock(low.credentialId, `${PROVIDER}:oauth`, "counter:google-argon");
		expect(blockedUntil).toBeGreaterThan(Date.now());
		await occupy("high");
		expect(await resolve("cooldown-pass")).toMatchObject({
			apiKey: "api-high",
			accountBusy: true,
			accountBusyReason: "all-busy",
		});
		expect(store.getCredentialBlock(low.credentialId, `${PROVIDER}:oauth`, "counter:google-argon")).toBe(
			blockedUntil,
		);
	});

	test("does not trade a busy Argon-eligible account for an idle ineligible account", async () => {
		reports.set("low", report("low", 0, false));
		await occupy("high");
		expect(await resolve("plan-pass")).toMatchObject({
			apiKey: "api-high",
			accountBusy: true,
			accountBusyReason: "all-busy",
		});
	});

	test("respects a session account pool even when its only permitted account is busy", async () => {
		auth.sessions.restrict(PROVIDER, "restricted", ["account:high"]);
		await occupy("high");
		expect(await resolve("restricted")).toMatchObject({
			apiKey: "api-high",
			accountBusy: true,
			accountBusyReason: "all-busy",
		});
	});

	test("preserves legacy selection without a request id and never reserves through get", async () => {
		await occupy("high");
		expect(await auth.keys.getWithCredential(PROVIDER, "legacy", { modelId: MODEL })).toMatchObject({
			apiKey: "api-high",
		});
		expect((await auth.keys.getWithCredential(PROVIDER, "legacy", { modelId: MODEL }))?.accountBusy).toBeUndefined();
		const probe = await request();
		expect(await auth.keys.get(PROVIDER, "probe", { modelId: MODEL, accountRequestId: probe.id })).toBe("api-high");
		const observer = await request();
		expect(await coordinator.reserve(PROVIDER, observer.id, "account:low")).toEqual({ busy: false });
	});

	test("does not record affinity when the caller opts out while avoiding a busy account", async () => {
		await occupy("high");
		expect((await resolve("no-affinity", { recordAffinity: false }))?.apiKey).toBe("api-low");
		expect(auth.oauth.accounts(PROVIDER, "no-affinity").some(account => account.active)).toBe(false);
	});
});
