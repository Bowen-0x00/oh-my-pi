import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProviderInFlightRoot, isFileLockHeld, tryAcquireFileLock, withFileLock } from "@oh-my-pi/pi-utils";

export interface AccountRequestLease {
	id: string;
	release(): Promise<void>;
}

const REQUEST_SUFFIX = ".request";
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tracks account use across processes without storing credentials or relying on
 * expiration timers. Each request holds its own OS lock, including requests
 * sharing an already-busy account. Only short filesystem transactions hold the
 * provider-wide coordination lock; callers resolve credentials outside it.
 */
export class AccountLoadCoordinator {
	readonly #root: string | undefined;

	constructor(root?: string) {
		this.#root = root === undefined ? undefined : path.resolve(root);
	}

	#providerDirectory(provider: string): string {
		// Resolve the default lazily so profiles and isolated test roots work even
		// when the shared coordinator was imported before their configuration.
		const root = this.#root ?? path.join(getProviderInFlightRoot(), "accounts");
		return path.join(root, Bun.SHA256.hash(provider, "hex"));
	}

	async create(provider: string): Promise<AccountRequestLease> {
		const directory = this.#providerDirectory(provider);
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		return withFileLock(path.join(directory, "coordination"), async () => {
			const id = Bun.randomUUIDv7();
			const markerPath = path.join(directory, `${id}${REQUEST_SUFFIX}`);
			const lock = tryAcquireFileLock(markerPath);
			if (!lock) throw new Error("Failed to acquire a new account request lease");
			try {
				await Bun.write(markerPath, "");
			} catch (error) {
				lock.release();
				throw error;
			}
			let releasePromise: Promise<void> | undefined;
			return {
				id,
				release: () => {
					releasePromise ??= withFileLock(path.join(directory, "coordination"), async () => {
						try {
							await fs.rm(markerPath, { force: true });
						} finally {
							lock.release();
						}
						// Request IDs are never reused. Unlike the stable coordination
						// lock, this inode has no future holder once its marker is gone.
						await fs.rm(`${markerPath}.lock`, { force: true });
					}).finally(() => lock.release());
					return releasePromise;
				},
			};
		});
	}

	/**
	 * Atomically chooses an idle account, or explicitly shares a busy one.
	 * Rejected choices leave the request's existing reservation unchanged.
	 * Only a live marker created by create() can acquire a reservation.
	 */
	async reserve(
		provider: string,
		requestId: string,
		accountKey: string,
		allowBusy = false,
	): Promise<{ busy: boolean } | undefined> {
		if (!REQUEST_ID.test(requestId)) return undefined;
		const directory = this.#providerDirectory(provider);
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		return withFileLock(path.join(directory, "coordination"), async () => {
			const ownName = `${requestId}${REQUEST_SUFFIX}`;
			const accountHash = Bun.SHA256.hash(accountKey, "hex");
			let liveRequest = false;
			let busy = false;
			const names = await fs.readdir(directory);
			const markers = new Set(names);
			for (const name of names) {
				if (name.endsWith(`${REQUEST_SUFFIX}.lock`)) {
					const markerName = name.slice(0, -".lock".length);
					if (
						REQUEST_ID.test(markerName.slice(0, -REQUEST_SUFFIX.length)) &&
						!markers.has(markerName) &&
						!isFileLockHeld(path.join(directory, markerName))
					) {
						await fs.rm(path.join(directory, name), { force: true });
					}
					continue;
				}
				if (!name.endsWith(REQUEST_SUFFIX) || !REQUEST_ID.test(name.slice(0, -REQUEST_SUFFIX.length))) {
					continue;
				}
				const markerPath = path.join(directory, name);
				if (!isFileLockHeld(markerPath)) {
					await fs.rm(markerPath, { force: true });
					await fs.rm(`${markerPath}.lock`, { force: true });
					continue;
				}
				if (name === ownName) {
					liveRequest = true;
				} else if ((await Bun.file(markerPath).text()) === accountHash) {
					busy = true;
				}
			}
			if (!liveRequest || (busy && !allowBusy)) return undefined;
			await Bun.write(path.join(directory, ownName), accountHash);
			return { busy };
		});
	}
}

export const accountLoadCoordinator = new AccountLoadCoordinator();
