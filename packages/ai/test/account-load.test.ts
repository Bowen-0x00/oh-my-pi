import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils";
import { AccountLoadCoordinator, type AccountRequestLease } from "../src/auth/account-load";

const roots: string[] = [];
const leases: AccountRequestLease[] = [];
const provider = "test-provider";

async function setup(): Promise<{ root: string; coordinator: AccountLoadCoordinator }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "account-load-test-"));
	roots.push(root);
	return { root, coordinator: new AccountLoadCoordinator(root) };
}

async function request(coordinator: AccountLoadCoordinator, name = provider): Promise<AccountRequestLease> {
	const lease = await coordinator.create(name);
	leases.push(lease);
	return lease;
}

afterEach(async () => {
	try {
		await Promise.all(leases.splice(0).map(lease => lease.release()));
	} finally {
		await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
	}
});

describe("account request leases", () => {
	test("only one simultaneous request can reserve the same idle account", async () => {
		const { root } = await setup();
		const contenders = await Promise.all(
			Array.from({ length: 8 }, async () => {
				const coordinator = new AccountLoadCoordinator(root);
				return { coordinator, lease: await request(coordinator) };
			}),
		);
		const results = await Promise.all(
			contenders.map(({ coordinator, lease }) => coordinator.reserve(provider, lease.id, "same-account")),
		);
		expect(results.filter(result => result !== undefined)).toEqual([{ busy: false }]);
	});

	test("different accounts and providers remain independently available", async () => {
		const { coordinator } = await setup();
		const first = await request(coordinator);
		const second = await request(coordinator);
		const otherProvider = await request(coordinator, "other-provider");
		expect(await coordinator.reserve(provider, first.id, "account-a")).toEqual({ busy: false });
		expect(await coordinator.reserve(provider, second.id, "account-b")).toEqual({ busy: false });
		expect(await coordinator.reserve("other-provider", otherProvider.id, "account-a")).toEqual({ busy: false });
	});

	test("a request does not count its own reservation as busy", async () => {
		const { coordinator } = await setup();
		const lease = await request(coordinator);
		expect(await coordinator.reserve(provider, lease.id, "account-a")).toEqual({ busy: false });
		expect(await coordinator.reserve(provider, lease.id, "account-a")).toEqual({ busy: false });
		expect(await coordinator.reserve(provider, lease.id, "account-a", true)).toEqual({ busy: false });
	});

	test("rejected busy choices preserve the request's previous reservation", async () => {
		const { coordinator } = await setup();
		const first = await request(coordinator);
		const second = await request(coordinator);
		const observer = await request(coordinator);
		await coordinator.reserve(provider, first.id, "account-a");
		await coordinator.reserve(provider, second.id, "account-b");
		expect(await coordinator.reserve(provider, second.id, "account-a")).toBeUndefined();
		expect(await coordinator.reserve(provider, observer.id, "account-b")).toBeUndefined();
		await first.release();
		expect(await coordinator.reserve(provider, observer.id, "account-a")).toEqual({ busy: false });
	});

	test("shared requests remain visible after the original account holder releases", async () => {
		const { coordinator } = await setup();
		const original = await request(coordinator);
		const shared = await request(coordinator);
		const observer = await request(coordinator);
		expect(await coordinator.reserve(provider, original.id, "account-a")).toEqual({ busy: false });
		expect(await coordinator.reserve(provider, shared.id, "account-a", true)).toEqual({ busy: true });
		await original.release();
		expect(await coordinator.reserve(provider, observer.id, "account-a")).toBeUndefined();
		expect(await coordinator.reserve(provider, shared.id, "account-a")).toEqual({ busy: false });
		await shared.release();
		expect(await coordinator.reserve(provider, observer.id, "account-a")).toEqual({ busy: false });
	});

	test("moving a live request to another idle account releases its previous account", async () => {
		const { coordinator } = await setup();
		const moving = await request(coordinator);
		const observer = await request(coordinator);
		await coordinator.reserve(provider, moving.id, "account-a");
		expect(await coordinator.reserve(provider, moving.id, "account-b")).toEqual({ busy: false });
		expect(await coordinator.reserve(provider, observer.id, "account-a")).toEqual({ busy: false });
	});

	test("release is idempotent and a released request cannot reserve again", async () => {
		const { coordinator } = await setup();
		const first = await request(coordinator);
		const next = await request(coordinator);
		await coordinator.reserve(provider, first.id, "account-a");
		await Promise.all([first.release(), first.release()]);
		expect(await coordinator.reserve(provider, first.id, "account-a", true)).toBeUndefined();
		expect(await coordinator.reserve(provider, next.id, "account-a")).toEqual({ busy: false });
		await first.release();
		const observer = await request(coordinator);
		expect(await coordinator.reserve(provider, observer.id, "account-a")).toBeUndefined();
	});

	test("missing, malformed, and wrong-provider request IDs cannot create reservations", async () => {
		const { coordinator } = await setup();
		const lease = await request(coordinator);
		expect(await coordinator.reserve(provider, randomUUID(), "account-a", true)).toBeUndefined();
		expect(await coordinator.reserve(provider, "../escape", "account-a", true)).toBeUndefined();
		expect(await coordinator.reserve("other-provider", lease.id, "account-a", true)).toBeUndefined();
	});

	test("an existing marker without an OS lease is dead and gets removed", async () => {
		const { root, coordinator } = await setup();
		const live = await request(coordinator);
		const [directory] = await fs.readdir(root);
		if (!directory) throw new Error("request directory was not created");
		const deadId = randomUUID();
		const deadMarker = path.join(root, directory, `${deadId}.request`);
		await Bun.write(deadMarker, "abandoned-account");
		expect(await coordinator.reserve(provider, deadId, "account-a", true)).toBeUndefined();
		expect(await Bun.file(deadMarker).exists()).toBe(false);
		expect(await coordinator.reserve(provider, live.id, "account-a")).toEqual({ busy: false });
	});

	test("a held lease with a missing request marker cannot fabricate a reservation", async () => {
		const { root, coordinator } = await setup();
		const lease = await request(coordinator);
		const [directory] = await fs.readdir(root);
		if (!directory) throw new Error("request directory was not created");
		await fs.rm(path.join(root, directory, `${lease.id}.request`));
		expect(await coordinator.reserve(provider, lease.id, "account-a", true)).toBeUndefined();
	});

	test("only hashed account identities are written to request markers", async () => {
		const { root, coordinator } = await setup();
		const lease = await request(coordinator);
		const accountKey = "private@example.test:secret-token-value";
		await coordinator.reserve(provider, lease.id, accountKey);
		const [directory] = await fs.readdir(root);
		if (!directory) throw new Error("request directory was not created");
		const marker = await Bun.file(path.join(root, directory, `${lease.id}.request`)).text();
		expect(marker).toMatch(/^[0-9a-f]{64}$/);
		expect(marker).not.toContain("private@example.test");
		expect(marker).not.toContain("secret-token-value");
	});

	test("an abruptly exiting child releases its OS lease and its marker is reclaimed", async () => {
		const { root, coordinator } = await setup();
		const modulePath = path.resolve(import.meta.dir, "../src/auth/account-load.ts");
		const script = [
			`import { AccountLoadCoordinator } from ${JSON.stringify(modulePath)};`,
			`const coordinator = new AccountLoadCoordinator(${JSON.stringify(root)});`,
			`const lease = await coordinator.create(${JSON.stringify(provider)});`,
			`const result = await coordinator.reserve(${JSON.stringify(provider)}, lease.id, "child-account");`,
			'if (!result || result.busy) throw new Error("child failed to reserve account");',
			'await Bun.write(Bun.stdout, lease.id + "\\n");',
			"await Bun.stdin.text();",
			"await lease.release();",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: import.meta.dir,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const lines = readLines(child.stdout, AbortSignal.timeout(5_000));
			let childId: string;
			try {
				const firstLine = await lines.next();
				if (firstLine.done) {
					if (child.exitCode === null) child.kill("SIGKILL");
					await child.exited;
					throw new Error(`child exited before readiness: ${await new Response(child.stderr).text()}`);
				}
				childId = new TextDecoder().decode(firstLine.value).trim();
			} finally {
				await lines.return(undefined);
			}
			const observer = await request(coordinator);
			expect(await coordinator.reserve(provider, observer.id, "child-account")).toBeUndefined();
			child.kill("SIGKILL");
			await child.exited;
			expect(await coordinator.reserve(provider, observer.id, "child-account")).toEqual({ busy: false });
			expect(await coordinator.reserve(provider, childId, "child-account", true)).toBeUndefined();
			const [directory] = await fs.readdir(root);
			if (!directory) throw new Error("request directory was not created");
			expect(await Bun.file(path.join(root, directory, `${childId}.request`)).exists()).toBe(false);
		} finally {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await child.exited;
			}
		}
	}, 10_000);
});
