import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { antigravityUsageProvider } from "@oh-my-pi/pi-ai/usage/google-antigravity";

test("usage initializes a refresh-only import and persists the credential before reporting quota", async () => {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	await store.saveOAuth("google-antigravity", {
		access: "",
		refresh: "imported-refresh",
		expires: 0,
		projectId: "usage-bootstrap-project",
		email: "bootstrap@example.com",
	});
	let refreshCalls = 0;
	const expires = Date.now() + 3_600_000;
	const storage = new AuthStorage(store, {
		usageProviderResolver: provider => (provider === "google-antigravity" ? antigravityUsageProvider : undefined),
		refreshOAuthCredential: async () => {
			refreshCalls += 1;
			return {
				access: "ya29.bootstrapped",
				refresh: "rotated-refresh",
				expires,
				projectId: "usage-bootstrap-project",
				email: "bootstrap@example.com",
			};
		},
		usageFetch: (async (_input, init) => {
			if (new Headers(init?.headers).get("Authorization") !== "Bearer ya29.bootstrapped") {
				return new Response(null, { status: 401 });
			}
			return Response.json({
				groups: [
					{
						displayName: "Gemini Models",
						buckets: [
							{ bucketId: "gemini-5h", window: "5h", remainingFraction: 0.75 },
							{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0.5 },
						],
					},
				],
			});
		}) as typeof fetch,
	});
	try {
		await storage.credentials.reload();
		const reports = await storage.usage.reports({ provider: "google-antigravity" });
		expect(reports).toHaveLength(1);
		expect(reports?.[0]?.metadata?.email).toBe("bootstrap@example.com");
		expect(reports?.[0]?.limits.find(limit => limit.window?.id === "5h")?.amount.usedFraction).toBe(0.25);
		expect(refreshCalls).toBe(1);
		expect(store.listAuthCredentials("google-antigravity").map(row => row.credential)).toMatchObject([
			{ type: "oauth", access: "ya29.bootstrapped", refresh: "rotated-refresh", expires },
		]);
	} finally {
		storage.close();
	}
});
