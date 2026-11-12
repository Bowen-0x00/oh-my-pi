import { extractHttpStatusFromError, logger } from "@oh-my-pi/pi-utils";
import type { CredentialRotation, LimitsApi, OAuthAccess, OAuthApi, OAuthRequestIdentity } from "./auth/types";
import * as AIError from "./error";
import { isAuthRetryableError, isInvalidatedOAuthTokenError } from "./error/auth-classify";
import { isAccountPolicyError, isUsageLimit } from "./error/flags";
import { isConcurrencyCapExclusion, isUsageLimitOutcome } from "./error/rate-limit";

/**
 * Context passed to an {@link ApiKeyResolver} on each resolution attempt.
 *
 * The `error`/`lastChance` pair preserves the legacy a/b/c resolver contract
 * shared by streaming ({@link streamSimple}) and non-streaming ({@link withAuth})
 * drivers:
 * - `error === undefined` → **initial resolve** (no force-refresh; cheap, may
 *   return a locally-cached not-yet-expired token).
 * - `error !== undefined && !lastChance` → **step (b): refresh the SAME
 *   account** (force a token re-mint / await an in-flight broker refresh).
 * - `error !== undefined && lastChance` → **step (c): switch account**
 *   (invalidate/usage-limit the current credential and rotate to a sibling).
 *
 * Current drivers give an ordinary 401/auth failure one step (b) before
 * repeating step (c) through distinct siblings. Account-scoped policy denials,
 * 403s, and usage-limit failures skip refresh. Rotation stops when the resolver
 * returns `undefined`, cycles, or reaches the initial pool's finite attempt
 * budget (at least {@link AUTH_RETRY_MAX_ATTEMPTS}).
 */
export interface ApiKeyResolveContext {
	/** True when the resolver should rotate to a sibling credential. */
	lastChance: boolean;
	/** The auth error that triggered this re-resolution, or `undefined` on the initial resolve. */
	error: unknown;
	/** Bearer used by the failed attempt, when the caller can expose it. */
	previousKey?: string;
	/** Caller cancel signal, threaded into any credential refresh / rotation work. */
	signal?: AbortSignal;
	/** Live streaming request reservation; absent for probes and non-streaming resolves. */
	accountRequestId?: string;
	/** Stored credentials already rejected by this operation's sibling-rotation attempts. */
	excludedCredentialIds?: readonly number[];
}

/**
 * Resolves the API key to send for a request, retried through the a/b/c policy
 * described on {@link ApiKeyResolveContext}.
 */
export interface ResolvedApiKey {
	apiKey: string;
	/** Durable row id of the credential that supplied this bearer, when known. */
	credentialId?: number;
	/** Stored pool size at resolution time; sizes the request's finite account-traversal budget. */
	credentialCount?: number;
	/**
	 * The OAuth access token behind this bearer, when the bearer came from a
	 * stored OAuth credential. A provider whose API key wraps the token in a
	 * structured document makes the two differ, so a 401 recovery names this
	 * one as the token the provider rejected.
	 */
	oauthAccess?: string;
	/**
	 * Resolved after `LimitsApi.rotate` slept out a sibling's short block
	 * (`afterSiblingWait`): the driver accepts this bearer even if the request
	 * already sent it before that block.
	 */
	afterSiblingWait?: boolean;
	/** Non-secret request scope belonging to this bearer, replaced on account rotation. */
	oauthIdentity?: OAuthRequestIdentity;
	/** This request shares an account already serving another live request. */
	accountBusy?: boolean;
	/** Pinned or refresh-bound requests describe their selected account, not the automatic pool. */
	accountBusyReason?: "all-busy" | "pinned";
}

export type ApiKeyResolution = string | ResolvedApiKey | undefined;

export type ApiKeyResolver = (ctx: ApiKeyResolveContext) => Promise<ApiKeyResolution> | ApiKeyResolution;

/** Extract the bearer while preserving optional credential provenance for streaming callers. */
export function resolvedApiKeyBearer(resolved: ApiKeyResolution): string | undefined {
	return (typeof resolved === "string" ? resolved : resolved?.apiKey) || undefined;
}

/**
 * Step (c) after {@link LimitsApi.rotate}: re-resolve the session credential,
 * or return `undefined` when quota exhaustion found no sibling, so the outer
 * retry layer honours the recorded backoff instead of resending a blocked
 * fallback. Other declines re-resolve: a peer may have refreshed the failed
 * bearer. A resolution after a sibling-unblock wait is marked so the retry
 * driver may resend a bearer it already tried. Shared by every rotating
 * resolver (`KeyCascade.resolver`, the auth gateway, coding-agent
 * `createApiKeyResolver`).
 */
export function resolveAfterRotation(
	rotation: CredentialRotation,
	error: unknown,
	resolve: () => Promise<ResolvedApiKey | undefined>,
): Promise<ResolvedApiKey | undefined>;
export function resolveAfterRotation(
	rotation: CredentialRotation,
	error: unknown,
	resolve: () => Promise<ApiKeyResolution>,
): Promise<ApiKeyResolution>;
export async function resolveAfterRotation(
	rotation: CredentialRotation,
	error: unknown,
	resolve: () => Promise<ApiKeyResolution>,
): Promise<ApiKeyResolution> {
	if (!rotation.switched) {
		const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
		if (isUsageLimit(error) || isUsageLimitOutcome(AIError.status(error), message)) return undefined;
	}
	const resolved = await resolve();
	const apiKey = resolvedApiKeyBearer(resolved);
	if (!rotation.afterSiblingWait || apiKey === undefined) return resolved;
	return typeof resolved === "string"
		? { apiKey, afterSiblingWait: true }
		: { ...resolved, apiKey, afterSiblingWait: true };
}

/** Bearers a resolver served recently, each with the OAuth access token behind it. */
const OAUTH_PROVENANCE_LIMIT = 8;

/**
 * Remembers which OAuth access token produced each bearer a resolver served,
 * so a 401 recovery can name the token of the request that actually failed.
 * A resolver serves many requests, and they fail out of order: the last
 * resolution is not that request's identity. Used by every resolver that
 * serves more than one request ({@link KeyCascade.resolver}, the coding
 * agent's `createApiKeyResolver`, the auth gateway's resolver).
 */
export function createOAuthProvenance(): {
	record: (resolved: ApiKeyResolution) => void;
	accessFor: (bearer: string | undefined) => string | undefined;
} {
	const byBearer = new Map<string, string>();
	return {
		record(resolved) {
			if (typeof resolved !== "object" || resolved === undefined) return;
			const access = resolved.oauthAccess;
			if (access === undefined) return;
			byBearer.delete(resolved.apiKey);
			byBearer.set(resolved.apiKey, access);
			while (byBearer.size > OAUTH_PROVENANCE_LIMIT) {
				const oldest = byBearer.keys().next();
				if (oldest.done) break;
				byBearer.delete(oldest.value);
			}
		},
		accessFor(bearer) {
			return bearer === undefined ? undefined : byBearer.get(bearer);
		},
	};
}

/** A static bearer string, or a {@link ApiKeyResolver} that mints/rotates one. */
export type ApiKey = string | ApiKeyResolver;

/** Keyless-provider credential marker; transports must not send it in authentication headers. */
export const NO_AUTH_SENTINEL = "N/A";

/** Narrows {@link ApiKey} to its resolver form. */
export function isApiKeyResolver(key: ApiKey | undefined): key is ApiKeyResolver {
	return typeof key === "function";
}

/**
 * Performs the initial resolve of an {@link ApiKey} (`error: undefined`,
 * `lastChance: false`). Static keys pass through unchanged.
 */
export async function resolveApiKeyOnce(
	key: ApiKey | undefined,
	signal?: AbortSignal,
	onResolved?: (resolved: ApiKeyResolution) => void,
): Promise<string | undefined> {
	if (key === undefined) return undefined;
	if (isApiKeyResolver(key)) {
		const resolved = await key({ lastChance: false, error: undefined, signal });
		onResolved?.(resolved);
		return resolvedApiKeyBearer(resolved);
	}
	return key;
}

/**
 * Wraps a resolver with a credential already selected for this request.
 *
 * Callers that preflight credentials can pass the returned resolver to the
 * auth-retry driver without making the driver know about that preflight: the
 * first initial resolution reuses `seed` (including its credential identity),
 * unless a live account reservation requires a fresh, atomic selection.
 * All later resolutions delegate to `resolver`.
 */
export function seedApiKeyResolver(seed: ApiKeyResolution, resolver: ApiKeyResolver): ApiKeyResolver {
	let seedPending = resolvedApiKeyBearer(seed) !== undefined;
	return ctx => {
		if (ctx.accountRequestId !== undefined) {
			// Availability probes do not own account slots. A preflight seed
			// cannot bypass the live request's idle-account selection.
			seedPending = false;
			return resolver(ctx);
		}
		if (seedPending && ctx.error === undefined) {
			seedPending = false;
			return seed;
		}
		return resolver(ctx);
	};
}

// Re-exported from the error module (its new home); see error/auth-classify.ts.
export { isAuthRetryableError };

/**
 * Legacy a/b/c retry sequence retained for public compatibility:
 * `false` → refresh-same, `true` → rotate/switch. Current drivers may repeat
 * sibling rotation until a termination guard fires.
 */
export const AUTH_RETRY_STEPS: readonly boolean[] = [false, true];

export const AUTH_RETRY_MAX_ATTEMPTS = 64;

/** A bounded traversal allows one request and one 401 refresh per stored credential. */
function authRetryAttemptLimit(credentialCount: number | undefined): number {
	return credentialCount !== undefined && Number.isSafeInteger(credentialCount) && credentialCount > 0
		? Math.max(AUTH_RETRY_MAX_ATTEMPTS, credentialCount * 2)
		: AUTH_RETRY_MAX_ATTEMPTS;
}

function isDirectCredentialRotationError(error: unknown): boolean {
	if (isAccountPolicyError(error)) return true;
	if (isUsageLimit(error) || isInvalidatedOAuthTokenError(error)) return true;
	const status = AIError.status(error);
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	// A 403 normally means a valid token lacks access, so rotate through
	// siblings. A concurrency-cap 403 is transient instead; do not burn a
	// sibling before the caller's backoff layer can retry it.
	const isForbidden =
		status === 403 ||
		(status === undefined && message !== undefined && extractHttpStatusFromError({ message }) === 403);
	if (isForbidden && !isConcurrencyCapExclusion(status, message)) return true;
	return isUsageLimitOutcome(status, message);
}

/** Keep a quota reset actionable when rotated siblings reject authentication or access. */
export function preferAuthRetryError(reported: unknown, next: unknown): unknown {
	const message = reported instanceof Error ? reported.message : typeof reported === "string" ? reported : undefined;
	return (isUsageLimit(reported) || isUsageLimitOutcome(AIError.status(reported), message)) &&
		(AIError.status(next) === 401 || AIError.status(next) === 403)
		? reported
		: next;
}

/** Resolve a single retry step, swallowing resolver failures into `undefined`. */
export async function resolveRetryKey(
	resolver: ApiKeyResolver,
	lastChance: boolean,
	error: unknown,
	signal?: AbortSignal,
	previousKey?: string,
	onResolved?: (resolved: ApiKeyResolution) => void,
	excludedCredentialIds?: readonly number[],
): Promise<string | undefined> {
	try {
		const rotateSibling = lastChance || (!lastChance && isDirectCredentialRotationError(error));
		const resolved = await resolver({ lastChance: rotateSibling, error, signal, previousKey, excludedCredentialIds });
		onResolved?.(resolved);
		return resolvedApiKeyBearer(resolved);
	} catch (resolutionError) {
		if (!signal?.aborted) {
			logger.warn("Credential retry resolution failed", {
				status: AIError.status(error),
				errorName: resolutionError instanceof Error ? resolutionError.name : typeof resolutionError,
			});
		}
		return undefined;
	}
}

export interface AuthRetryKeyState {
	/** Bearer strings already sent during this logical operation. */
	attemptedKeys: Set<string>;
	/** Bearer used by the most recent failed attempt. */
	lastKey: string;
	credentialId?: number;
	/** Request-local exclusions survive cooldown expiry and last-resort selection. */
	excludedCredentialIds?: number[];
	/** Whether the current credential already consumed its 401 refresh-same retry. */
	refreshedCurrent: boolean;
	/** Whether this operation already replayed once after an explicit token-refresh request. */
	tokenRefreshReplayUsed?: boolean;
	/** Total outbound attempts accepted for this logical operation, including the initial request. */
	attempts: number;
	/** Fixed from the initial credential pool, so rotation cannot grow its own budget. */
	maxAttempts: number;
}

export function createAuthRetryKeyState(
	initialKey: string,
	credentialId?: number,
	credentialCount?: number,
): AuthRetryKeyState {
	return {
		attemptedKeys: new Set([initialKey]),
		lastKey: initialKey,
		credentialId,
		refreshedCurrent: false,
		tokenRefreshReplayUsed: false,
		attempts: 1,
		maxAttempts: authRetryAttemptLimit(credentialCount),
	};
}

function acceptRetryKey(
	state: AuthRetryKeyState,
	key: string,
	refreshedCurrent: boolean,
	afterSiblingWait = false,
	credentialId?: number,
): string | undefined {
	if ((!afterSiblingWait && state.attemptedKeys.has(key)) || state.attempts >= state.maxAttempts) {
		return undefined;
	}
	state.attemptedKeys.add(key);
	state.attempts += 1;
	state.lastKey = key;
	state.credentialId = credentialId;
	state.refreshedCurrent = refreshedCurrent;
	return key;
}

export async function resolveNextAuthRetryKey(
	state: AuthRetryKeyState,
	resolver: ApiKeyResolver,
	error: unknown,
	signal?: AbortSignal,
	onResolved?: (resolved: ApiKeyResolution) => void,
): Promise<string | undefined> {
	if (signal?.aborted) return undefined;
	if (state.attempts >= state.maxAttempts) return undefined;
	let credentialId: number | undefined;
	const recordResolved = (resolved: ApiKeyResolution): void => {
		credentialId = typeof resolved === "object" ? resolved.credentialId : undefined;
		onResolved?.(resolved);
	};
	if (error instanceof AIError.OAuthError && error.kind === "token-refresh") {
		if (state.tokenRefreshReplayUsed) return undefined;
		state.tokenRefreshReplayUsed = true;
		const refreshed = await resolveRetryKey(
			resolver,
			false,
			error,
			signal,
			state.lastKey,
			recordResolved,
			state.excludedCredentialIds,
		);
		state.refreshedCurrent = true;
		if (signal?.aborted || refreshed === undefined) return undefined;
		return acceptRetryKey(state, refreshed, true, false, credentialId);
	}
	const directRotation = isDirectCredentialRotationError(error);
	if (!directRotation) {
		if (!state.refreshedCurrent) {
			const refreshed = await resolveRetryKey(
				resolver,
				false,
				error,
				signal,
				state.lastKey,
				recordResolved,
				state.excludedCredentialIds,
			);
			state.refreshedCurrent = true;
			if (signal?.aborted) return undefined;
			if (refreshed !== undefined) {
				const accepted = acceptRetryKey(state, refreshed, true, false, credentialId);
				if (accepted !== undefined) return accepted;
			}
		}
	}

	if (signal?.aborted) return undefined;
	if (state.credentialId !== undefined) {
		const excluded = (state.excludedCredentialIds ??= []);
		if (!excluded.includes(state.credentialId)) excluded.push(state.credentialId);
	}
	let afterSiblingWait = false;
	const rotated = await resolveRetryKey(
		resolver,
		true,
		error,
		signal,
		state.lastKey,
		resolved => {
			afterSiblingWait = typeof resolved === "object" && resolved.afterSiblingWait === true;
			recordResolved(resolved);
		},
		state.excludedCredentialIds,
	);
	if (signal?.aborted || rotated === undefined) return undefined;
	return acceptRetryKey(state, rotated, !directRotation, afterSiblingWait, credentialId);
}

function oauthCredentialIdentity(access: OAuthAccess): string {
	return access.credentialId !== undefined ? `credential:${access.credentialId}` : `bearer:${access.accessToken}`;
}

async function runOAuthAttempt<T>(
	access: OAuthAccess,
	attempt: (access: OAuthAccess) => Promise<T>,
	isAuthError: (error: unknown) => boolean,
): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
	try {
		return { ok: true, result: await attempt(access) };
	} catch (error) {
		if (!isAuthError(error)) throw error;
		return { ok: false, error };
	}
}

/**
 * Runs an auth-protected operation through the central a/b/c retry policy.
 *
 * - A static string key (or any non-resolver) → a single `attempt` with no
 *   retry (identical to the legacy static-key path).
 * - A resolver → initial `attempt`, then resolver-driven retries until the
 *   applicable policy is exhausted, the resolver declines or cycles, or the
 *   initial pool's attempt budget is reached (at least
 *   {@link AUTH_RETRY_MAX_ATTEMPTS}). An explicit typed token-refresh request
 *   gets exactly one refresh-current replay and never
 *   enters sibling rotation. Ordinary 401/auth failures get one refresh-same,
 *   then rotate through distinct siblings; 403/usage-limit failures skip the
 *   refresh and rotate directly.
 * - A resolver that throws on the initial resolve surfaces its cause (a
 *   broker/OAuth/network failure) instead of reading as a missing key; only a
 *   resolver that resolves without a credential is a "No API key" case.
 *
 * Used by non-streaming consumers (image generation, web search, completion
 * helpers). The streaming driver in `stream.ts` implements the same policy with
 * its replay-safe buffering machinery.
 */
export async function withAuth<T>(
	key: ApiKey | undefined,
	attempt: (key: string) => Promise<T>,
	opts?: { isAuthError?: (error: unknown) => boolean; signal?: AbortSignal; missingKeyMessage?: string },
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const missingKey = (): Error => new AIError.MissingApiKeyError(undefined, opts?.missingKeyMessage);

	if (!isApiKeyResolver(key)) {
		if (key === undefined) throw missingKey();
		return attempt(key);
	}

	const resolver = key;
	const signal = opts?.signal;
	let initialKey: string | undefined;
	let initialCredentialId: number | undefined;
	let initialCredentialCount: number | undefined;
	try {
		initialKey = await resolveApiKeyOnce(resolver, signal, resolved => {
			initialCredentialId = typeof resolved === "object" ? resolved.credentialId : undefined;
			initialCredentialCount = typeof resolved === "object" ? resolved.credentialCount : undefined;
		});
	} catch (error) {
		// A resolver that deliberately reports a missing key keeps that type.
		if (error instanceof AIError.MissingApiKeyError) throw error;
		// A thrown resolver is a broker/OAuth/network failure, not a missing
		// key — surface the cause instead of masking it as "No API key".
		throw new AIError.ConfigurationError(
			`Failed to resolve API key: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	if (initialKey === undefined) throw missingKey();

	const state = createAuthRetryKeyState(initialKey, initialCredentialId, initialCredentialCount);
	let lastError: unknown;
	let reportedError: unknown;
	try {
		return await attempt(initialKey);
	} catch (error) {
		if (!isAuthError(error)) throw error;
		lastError = error;
		reportedError = error;
	}

	while (true) {
		const nextKey = await resolveNextAuthRetryKey(state, resolver, lastError, signal);
		if (nextKey === undefined) break;
		try {
			return await attempt(nextKey);
		} catch (error) {
			if (!isAuthError(error)) throw error;
			lastError = error;
			reportedError = preferAuthRetryError(reportedError, error);
		}
	}

	throw reportedError;
}

/**
 * Minimal structural slice of `AuthStorage` consumed by {@link withOAuthAccess}.
 * Typed structurally (type-only imports) so this module never takes a runtime
 * dependency on `./auth-storage`.
 */
export interface OAuthAccessSource {
	readonly oauth: Pick<OAuthApi, "access">;
	readonly limits: Pick<LimitsApi, "rotate">;
}

export interface WithOAuthAccessOptions {
	/** Session id for credential stickiness, threaded into every resolve. */
	sessionId?: string;
	signal?: AbortSignal;
	/** Override the retryable-error classifier (default {@link isAuthRetryableError}). */
	isAuthError?: (error: unknown) => boolean;
	/**
	 * Pre-resolved access used for the initial attempt. Callers that already
	 * resolved access for an availability gate pass it here so the helper
	 * doesn't double-resolve (mirrors the gateway resolver's `initialKey`).
	 */
	seed?: OAuthAccess;
	missingAccessMessage?: string;
}

/**
 * {@link withAuth} for OAuth-access consumers: runs an auth-protected
 * operation through the central a/b/c retry policy, handing the attempt the
 * full {@link OAuthAccess} (bearer + identity metadata: `accountId`,
 * `projectId`, `enterpriseUrl`) instead of bare API-key bytes.
 *
 * - initial → `getOAuthAccess` (or `opts.seed`).
 * - typed token-refresh request → one forced refresh-current replay, then stop.
 * - 401/auth failure → one `getOAuthAccess` with `forceRefresh: true` for the
 *   current account, then sibling rotation through distinct credentials.
 * - 403/usage-limit failure → `rotateSessionCredential` directly, without a
 *   force-refresh detour.
 *
 * A refresh-same step may retry a new bearer for the same credential identity;
 * sibling rotation stops when it yields a credential identity
 * (`credentialId ?? accessToken`) or bearer already attempted in this turn.
 * Attempts share a finite budget sized from the initial pool, with
 * {@link AUTH_RETRY_MAX_ATTEMPTS} as its minimum and unknown-pool fallback.
 * Non-auth errors propagate immediately. Use this instead of hand-rolled
 * `getOAuthAccess` + fetch flows so 401s and usage-limits rotate credentials
 * instead of failing the call.
 */
export async function withOAuthAccess<T>(
	storage: OAuthAccessSource,
	provider: string,
	attempt: (access: OAuthAccess) => Promise<T>,
	opts?: WithOAuthAccessOptions,
): Promise<T> {
	const isAuthError = opts?.isAuthError ?? isAuthRetryableError;
	const { sessionId, signal } = opts ?? {};

	let lastAccess = opts?.seed ?? (await storage.oauth.access(provider, sessionId, { signal }));
	if (!lastAccess) {
		throw new AIError.MissingApiKeyError(
			provider,
			opts?.missingAccessMessage ?? `No OAuth credential available for provider: ${provider}`,
		);
	}

	const attemptedBearers = new Set([lastAccess.accessToken]);
	const attemptedCredentialIdentities = new Set([oauthCredentialIdentity(lastAccess)]);
	let excludedCredentialIds: number[] | undefined;
	let attemptCount = 1;
	const maxAttempts = authRetryAttemptLimit(lastAccess.credentialCount);
	let refreshedCurrent = false;
	let tokenRefreshReplayUsed = false;
	let attemptResult = await runOAuthAttempt(lastAccess, attempt, isAuthError);
	if (attemptResult.ok) return attemptResult.result;

	let lastError = attemptResult.error;
	let reportedError: unknown = lastError;
	while (true) {
		let next: OAuthAccess | undefined;
		if (signal?.aborted || attemptCount >= maxAttempts) break;
		const tokenRefreshReplay = lastError instanceof AIError.OAuthError && lastError.kind === "token-refresh";
		if (tokenRefreshReplay) {
			if (tokenRefreshReplayUsed) break;
			tokenRefreshReplayUsed = true;
			refreshedCurrent = true;
			try {
				next = await storage.oauth.access(provider, sessionId, {
					forceRefresh: true,
					rejectedAccessToken: lastAccess.accessToken,
					signal,
				});
			} catch {
				next = undefined;
			}
			if (signal?.aborted || !next) break;
			const bearer = next.accessToken;
			if (attemptedBearers.has(bearer) || attemptCount >= maxAttempts) break;
			attemptedCredentialIdentities.add(oauthCredentialIdentity(next));
			attemptedBearers.add(bearer);
			attemptCount += 1;
			lastAccess = next;
			attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
			if (attemptResult.ok) return attemptResult.result;
			lastError = attemptResult.error;
			reportedError = preferAuthRetryError(reportedError, attemptResult.error);
			continue;
		}

		const directRotation = isDirectCredentialRotationError(lastError);
		if (!directRotation) {
			if (!refreshedCurrent) {
				refreshedCurrent = true;
				try {
					next = await storage.oauth.access(provider, sessionId, {
						forceRefresh: true,
						refreshReason: AIError.status(lastError) === 401 ? "auth-recovery" : undefined,
						rejectedAccessToken: lastAccess.accessToken,
						signal,
					});
				} catch {
					next = undefined;
				}
				if (signal?.aborted) break;
				if (next) {
					const bearer = next.accessToken;
					if (!attemptedBearers.has(bearer) && attemptCount < maxAttempts) {
						attemptedCredentialIdentities.add(oauthCredentialIdentity(next));
						attemptedBearers.add(bearer);
						attemptCount += 1;
						lastAccess = next;
						attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
						if (attemptResult.ok) return attemptResult.result;
						lastError = attemptResult.error;
						reportedError = preferAuthRetryError(reportedError, attemptResult.error);
						continue;
					}
				}
			}
		}

		if (signal?.aborted || attemptCount >= maxAttempts) break;
		if (lastAccess.credentialId !== undefined) {
			const excluded = (excludedCredentialIds ??= []);
			if (!excluded.includes(lastAccess.credentialId)) excluded.push(lastAccess.credentialId);
		}
		let afterSiblingWait = false;
		try {
			const rotation = await storage.limits.rotate(provider, sessionId, {
				error: lastError,
				signal,
				apiKey: lastAccess.accessToken,
				credentialId: lastAccess.credentialId,
			});
			if (!rotation.switched) break;
			afterSiblingWait = rotation.afterSiblingWait === true;
			next = await storage.oauth.access(provider, sessionId, {
				signal,
				excludedCredentialIds: afterSiblingWait ? undefined : excludedCredentialIds,
			});
		} catch {
			next = undefined;
		}
		if (signal?.aborted || !next) break;
		const credentialIdentity = oauthCredentialIdentity(next);
		if (
			(!afterSiblingWait &&
				(attemptedCredentialIdentities.has(credentialIdentity) || attemptedBearers.has(next.accessToken))) ||
			attemptCount >= maxAttempts
		) {
			break;
		}
		attemptedCredentialIdentities.add(credentialIdentity);
		attemptedBearers.add(next.accessToken);
		attemptCount += 1;
		lastAccess = next;
		refreshedCurrent = !directRotation;
		attemptResult = await runOAuthAttempt(next, attempt, isAuthError);
		if (attemptResult.ok) return attemptResult.result;
		lastError = attemptResult.error;
		reportedError = preferAuthRetryError(reportedError, attemptResult.error);
	}

	throw reportedError;
}
