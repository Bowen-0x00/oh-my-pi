import { quotaTierFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { resolveVariantSelector } from "@oh-my-pi/pi-catalog/compat/collapse";
import { getAntigravityHeaders } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import * as AIError from "../error";
import type {
	CredentialRankingContext,
	CredentialRankingStrategy,
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageStatus,
	UsageWindow,
} from "../usage";
import { DAY_MS, HOUR_MS, parseIsoTimestamp, WEEK_MS } from "./shared";

// (Refresh is the sole responsibility of AuthStorage; no provider-direct refresh here.)

interface AntigravityQuotaInfo {
	remainingFraction?: number;
	resetTime?: string;
	tier?: string;
	windowId?: string;
	windowLabel?: string;
	apiProvider?: string;
	modelProvider?: string;
}

interface AntigravityModelInfo {
	displayName?: string;
	disabled?: boolean;
	isInternal?: boolean;
	quotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	quotaInfos?: AntigravityQuotaInfo[];
	dailyQuotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	dailyQuotaInfos?: AntigravityQuotaInfo[];
	weeklyQuotaInfo?: AntigravityQuotaInfo | AntigravityQuotaInfo[];
	weeklyQuotaInfos?: AntigravityQuotaInfo[];
	quotaInfoByTier?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	quotaInfoByWindow?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	quotaInfosByWindow?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>;
	apiProvider?: string;
	modelProvider?: string;
}

interface AntigravityUsageResponse {
	models: Record<string, AntigravityModelInfo>;
	imageGenerationModelIds?: string[];
}

interface AntigravityQuotaSummaryBucket {
	bucketId?: string;
	displayName?: string;
	description?: string;
	window?: string;
	remainingFraction?: number;
	remainingAmount?: number | string;
	disabled?: boolean;
	resetTime?: string;
}

interface AntigravityQuotaSummaryGroup {
	displayName?: string;
	description?: string;
	buckets?: AntigravityQuotaSummaryBucket[];
}

interface AntigravityQuotaSummaryResponse {
	buckets?: AntigravityQuotaSummaryBucket[];
	groups?: AntigravityQuotaSummaryGroup[];
	description?: string;
}

interface AntigravityEndpointRequest {
	endpoints: readonly string[];
	path: string;
	projectId: string;
	accessToken: string;
	signal?: AbortSignal;
}

interface AntigravityEndpointResult {
	response?: Response;
	endpoint: string;
}

const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
const RETRIEVE_USER_QUOTA_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary";
/** `UsageReport.metadata.quotaSource` of reports built from `retrieveUserQuotaSummary`. */
const QUOTA_SUMMARY_SOURCE = "quota-summary";

interface AntigravityWindowDescriptor {
	id: string;
	label: string;
	durationMs?: number;
}

function classifyWindow(id: string | undefined, label: string | undefined): AntigravityWindowDescriptor | undefined {
	const source = `${id ?? ""} ${label ?? ""}`.toLowerCase();
	if (source.includes("week") || source.includes("7d") || /7[\s_-]*day/.test(source)) {
		return { id: "weekly", label: "Weekly", durationMs: WEEK_MS };
	}
	if (source.includes("5h") || source.includes("five hour") || /5[\s_-]*hour/.test(source)) {
		return { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS };
	}
	if (source.includes("day") || source.includes("daily") || source.includes("24h")) {
		return { id: "daily", label: "Daily", durationMs: DAY_MS };
	}
	if (id || label) return { id: id ?? label ?? "default", label: label ?? id ?? "Default" };
	return undefined;
}

function inferWindowFromReset(resetAt: number | undefined, nowMs: number): AntigravityWindowDescriptor {
	if (resetAt !== undefined && resetAt - nowMs > DAY_MS) {
		return { id: "weekly", label: "Weekly", durationMs: WEEK_MS };
	}
	return { id: "daily", label: "Daily", durationMs: DAY_MS };
}

function quotaInferenceKey(info: AntigravityQuotaInfo): string {
	return [info.modelProvider ?? "", info.apiProvider ?? "", info.tier ?? ""].join("|");
}

function inferWindowDescriptors(
	quotaInfos: AntigravityQuotaInfo[],
	nowMs: number,
): WeakMap<AntigravityQuotaInfo, AntigravityWindowDescriptor> {
	const descriptors = new WeakMap<AntigravityQuotaInfo, AntigravityWindowDescriptor>();
	const groups = new Map<string, { info: AntigravityQuotaInfo; resetAt: number | undefined }[]>();

	for (const info of quotaInfos) {
		const explicitDescriptor = classifyWindow(info.windowId, info.windowLabel);
		if (explicitDescriptor) {
			descriptors.set(info, explicitDescriptor);
			continue;
		}
		const group = groups.get(quotaInferenceKey(info)) ?? [];
		group.push({ info, resetAt: parseIsoTimestamp(info.resetTime) });
		groups.set(quotaInferenceKey(info), group);
	}

	for (const group of groups.values()) {
		const resetTimes = [...new Set(group.map(entry => entry.resetAt).filter(resetAt => resetAt !== undefined))].sort(
			(a, b) => a - b,
		);
		const latestReset = resetTimes.length > 1 ? resetTimes.at(-1) : undefined;
		for (const entry of group) {
			const descriptor =
				latestReset !== undefined && entry.resetAt === latestReset
					? { id: "weekly", label: "Weekly", durationMs: WEEK_MS }
					: inferWindowFromReset(entry.resetAt, nowMs);
			descriptors.set(entry.info, descriptor);
		}
	}

	return descriptors;
}

function withWindowDescriptor(
	info: AntigravityQuotaInfo,
	descriptor: AntigravityWindowDescriptor | undefined,
): AntigravityQuotaInfo {
	if (!descriptor) return info;
	return {
		...info,
		windowId: info.windowId ?? descriptor.id,
		windowLabel: info.windowLabel ?? descriptor.label,
	};
}

function clampFraction(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function getUsageStatus(remainingFraction: number | undefined): UsageStatus | undefined {
	if (remainingFraction === undefined) return "unknown";
	if (remainingFraction <= 0) return "exhausted";
	if (remainingFraction <= 0.1) return "warning";
	return "ok";
}

function parseWindow(
	info: AntigravityQuotaInfo,
	descriptor: AntigravityWindowDescriptor | undefined,
): UsageWindow | undefined {
	const resetAt = parseIsoTimestamp(info.resetTime);
	const hasResetAt = resetAt !== undefined;
	if (!descriptor && !hasResetAt) return undefined;
	return {
		id: descriptor?.id ?? info.windowId ?? "default",
		label: info.windowLabel ?? descriptor?.label ?? "Default",
		...(descriptor?.durationMs !== undefined ? { durationMs: descriptor.durationMs } : {}),
		...(hasResetAt ? { resetsAt: resetAt } : {}),
	};
}

function buildPercentAmount(remainingFraction: number | undefined): UsageAmount {
	const amount: UsageAmount = { unit: "percent" };
	if (remainingFraction === undefined) return amount;
	const usedFraction = 1 - remainingFraction;
	amount.remainingFraction = remainingFraction;
	amount.usedFraction = usedFraction;
	amount.remaining = remainingFraction * 100;
	amount.used = usedFraction * 100;
	amount.limit = 100;
	return amount;
}

function buildAmount(info: AntigravityQuotaInfo): UsageAmount {
	const apiRemainingFraction = clampFraction(info.remainingFraction);
	// Observed legacy Antigravity responses omit remainingFraction for exhausted
	// Google/Gemini counters and keep only resetTime. Treat that shape as
	// "blocked until reset" rather than unknown so a healthy sibling backend
	// counter cannot mask it during dedupe.
	return buildPercentAmount(apiRemainingFraction ?? (info.resetTime ? 0 : undefined));
}

function formatCounterName(info: AntigravityQuotaInfo): string | undefined {
	switch (info.modelProvider ?? info.apiProvider) {
		case "MODEL_PROVIDER_ANTHROPIC":
		case "API_PROVIDER_ANTHROPIC_VERTEX":
			return "Anthropic";
		case "MODEL_PROVIDER_GOOGLE":
		case "API_PROVIDER_GOOGLE_GEMINI":
			return "Google";
		case "MODEL_PROVIDER_OPENAI":
		case "API_PROVIDER_OPENAI_VERTEX":
			return "OpenAI";
		default:
			return undefined;
	}
}

function normalizeQuotaInfos(info: AntigravityModelInfo): AntigravityQuotaInfo[] {
	const results: AntigravityQuotaInfo[] = [];
	const source = {
		...(info.apiProvider ? { apiProvider: info.apiProvider } : {}),
		...(info.modelProvider ? { modelProvider: info.modelProvider } : {}),
	};
	const addInfo = (value: AntigravityQuotaInfo, tier?: string, windowDescriptor?: AntigravityWindowDescriptor) => {
		results.push({
			...source,
			...withWindowDescriptor(value, windowDescriptor),
			...(tier ? { tier } : {}),
		});
	};
	const addValue = (
		value: AntigravityQuotaInfo | AntigravityQuotaInfo[] | undefined,
		tier?: string,
		windowDescriptor?: AntigravityWindowDescriptor,
	) => {
		if (!value) return;
		if (Array.isArray(value)) {
			for (const entry of value) addInfo(entry, tier, windowDescriptor);
			return;
		}
		addInfo(value, tier, windowDescriptor);
	};

	addValue(info.quotaInfo);
	addValue(info.quotaInfos);
	addValue(info.dailyQuotaInfo, undefined, classifyWindow("daily", "Daily"));
	addValue(info.dailyQuotaInfos, undefined, classifyWindow("daily", "Daily"));
	addValue(info.weeklyQuotaInfo, undefined, classifyWindow("weekly", "Weekly"));
	addValue(info.weeklyQuotaInfos, undefined, classifyWindow("weekly", "Weekly"));

	if (info.quotaInfoByTier) {
		for (const [tier, value] of Object.entries(info.quotaInfoByTier)) {
			addValue(value, tier);
		}
	}

	const addWindowMap = (values?: Record<string, AntigravityQuotaInfo | AntigravityQuotaInfo[]>) => {
		if (!values) return;
		for (const [windowId, value] of Object.entries(values)) {
			addValue(value, undefined, classifyWindow(windowId, undefined));
		}
	};
	addWindowMap(info.quotaInfoByWindow);
	addWindowMap(info.quotaInfosByWindow);

	return results;
}

function getQuotaSummaryCounterKeys(
	group: AntigravityQuotaSummaryGroup | undefined,
	bucket: AntigravityQuotaSummaryBucket,
): string[] {
	const bucketId = bucket.bucketId?.toLowerCase() ?? "";
	const groupName = group?.displayName?.toLowerCase() ?? "";
	// Argon has its own weekly meter. Keep it separate from the ordinary
	// Gemini bucket so an Argon exhaustion cannot block Gemini (or vice versa).
	if (bucketId.startsWith("gemini-argon-") || groupName.includes("gemini 4 argon")) {
		return ["google-argon"];
	}
	if (bucketId.startsWith("gemini-") || groupName.includes("gemini")) return ["google"];
	if (
		bucketId.startsWith("3p-") ||
		groupName.includes("claude") ||
		groupName.includes("gpt") ||
		groupName.includes("third party")
	) {
		// Antigravity exposes one shared third-party group. Duplicate its limits
		// into the existing model-family scopes so Claude and GPT requests both
		// participate in credential ranking without inventing a second quota.
		return ["anthropic", "openai"];
	}
	return ["default"];
}

function getQuotaSummaryCounterName(counterKey: string): string | undefined {
	switch (counterKey) {
		case "google":
			return "Google";
		case "google-argon":
			return "Gemini (Argon)";
		case "anthropic":
			return "Anthropic";
		case "openai":
			return "OpenAI";
		default:
			return undefined;
	}
}

function buildQuotaSummaryAmount(bucket: AntigravityQuotaSummaryBucket): UsageAmount {
	const remainingFraction = clampFraction(bucket.remainingFraction);
	if (remainingFraction !== undefined) return buildPercentAmount(remainingFraction);

	const remainingAmount =
		typeof bucket.remainingAmount === "number"
			? bucket.remainingAmount
			: typeof bucket.remainingAmount === "string"
				? Number(bucket.remainingAmount)
				: undefined;
	if (remainingAmount === undefined || !Number.isFinite(remainingAmount)) return { unit: "unknown" };
	return { unit: "unknown", remaining: remainingAmount };
}

function buildQuotaSummaryReport(
	data: AntigravityQuotaSummaryResponse,
	params: UsageFetchParams,
	endpoint: string,
	nowMs: number,
): UsageReport | null {
	const groups = Array.isArray(data.groups) ? data.groups : [];
	const topLevelBuckets = Array.isArray(data.buckets) ? data.buckets : [];
	const hasGroupedBuckets = groups.some(group => Array.isArray(group.buckets) && group.buckets.length > 0);
	if (!hasGroupedBuckets && topLevelBuckets.length === 0) return null;

	const limits: UsageLimit[] = [];
	const addBucket = (bucket: AntigravityQuotaSummaryBucket, group?: AntigravityQuotaSummaryGroup) => {
		if (bucket.disabled === true) return;
		const descriptor = classifyWindow(bucket.window, bucket.displayName);
		const window = parseWindow(
			{
				resetTime: bucket.resetTime,
				windowId: bucket.window,
				windowLabel: descriptor?.label,
			},
			descriptor,
		);
		const amount = buildQuotaSummaryAmount(bucket);
		const counterKeys = getQuotaSummaryCounterKeys(group, bucket);
		const sharedGroup =
			counterKeys.length > 1
				? `${bucket.bucketId ?? group?.displayName ?? "third-party"}:${window?.id ?? bucket.window ?? "default"}`
				: undefined;

		for (const counterKey of counterKeys) {
			const counterName = getQuotaSummaryCounterName(counterKey);
			const windowId = window?.id ?? bucket.window ?? bucket.bucketId ?? "default";
			// The API's bucket `displayName` is generic ("Weekly Limit Remaining"),
			// so Argon's dedicated weekly bucket needs its own name to stay
			// distinguishable from the shared Gemini weekly bucket in usage views.
			const label =
				sharedGroup !== undefined
					? "Claude & GPT (shared)"
					: counterKey === "google"
						? "Gemini"
						: counterKey === "google-argon"
							? "Gemini (Argon)"
							: counterName;
			limits.push({
				id: `${params.provider}:${counterKey}:default:${bucket.bucketId ?? windowId}`,
				label: label ?? group?.displayName ?? bucket.displayName ?? "Usage",
				scope: {
					provider: params.provider,
					accountId: params.credential.accountId,
					projectId: params.credential.projectId,
					windowId,
					...(sharedGroup !== undefined ? { shared: true, sharedGroup } : {}),
				},
				window,
				amount,
				status:
					amount.remainingFraction !== undefined
						? getUsageStatus(amount.remainingFraction)
						: amount.remaining === 0
							? "exhausted"
							: "unknown",
			});
		}
	};

	if (hasGroupedBuckets) {
		for (const group of groups) {
			for (const bucket of group.buckets ?? []) addBucket(bucket, group);
		}
	} else {
		for (const bucket of topLevelBuckets) addBucket(bucket);
	}

	limits.sort((a, b) => {
		const aFraction = a.amount.remainingFraction ?? 1;
		const bFraction = b.amount.remainingFraction ?? 1;
		return aFraction - bFraction;
	});

	const metadata: UsageReport["metadata"] = {
		endpoint,
		projectId: params.credential.projectId,
		quotaSource: QUOTA_SUMMARY_SOURCE,
	};
	if (params.credential.email) metadata.email = params.credential.email;
	if (params.credential.accountId) metadata.accountId = params.credential.accountId;

	return {
		provider: params.provider,
		fetchedAt: nowMs,
		limits,
		metadata,
		raw: data,
	};
}

async function fetchAntigravityEndpoint(
	request: AntigravityEndpointRequest,
	ctx: UsageFetchContext,
): Promise<AntigravityEndpointResult> {
	let response: Response | undefined;
	let attemptedEndpoint = request.endpoints[0] ?? DEFAULT_ENDPOINT;
	for (const endpoint of request.endpoints) {
		attemptedEndpoint = endpoint;
		try {
			response = await ctx.fetch(`${endpoint}${request.path}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${request.accessToken}`,
					"Content-Type": "application/json",
					...getAntigravityHeaders(),
				},
				body: JSON.stringify({ project: request.projectId }),
				signal: request.signal,
			});
		} catch (error) {
			if (endpoint === request.endpoints.at(-1)) throw error;
			continue;
		}

		if (response.ok || !AIError.isTransientStatus(response.status)) {
			return { response, endpoint };
		}
	}
	return { response, endpoint: attemptedEndpoint };
}

/**
 * Return the OAuth access token to use against `/v1internal:*`. AuthStorage is
 * the sole refresh authority (broker-aware, single-flighted, rotation-safe);
 * an expired token short-circuits the probe rather than POSTing the broker
 * sentinel back to Google.
 */
function resolveAccessToken(params: UsageFetchParams): string | undefined {
	const { credential } = params;
	if (!credential.accessToken) return undefined;
	if (credential.expiresAt !== undefined && credential.expiresAt <= Date.now()) {
		return undefined;
	}
	return credential.accessToken;
}

async function fetchAntigravityUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	const credential = params.credential;
	if (!credential.projectId) return null;

	const nowMs = Date.now();

	const accessToken = resolveAccessToken(params);
	if (!accessToken) return null;

	const baseUrl = params.baseUrl?.replace(/\/+$/, "");
	const endpoints = baseUrl ? [baseUrl] : [DEFAULT_ENDPOINT, "https://daily-cloudcode-pa.sandbox.googleapis.com"];
	const endpointRequest = {
		endpoints,
		projectId: credential.projectId,
		accessToken,
		signal: params.signal,
	};

	// This is the endpoint Antigravity's own quota UI uses. Unlike the legacy
	// model catalog response, it reports both the rolling five-hour and weekly
	// buckets even when neither is exhausted.
	const summaryResult = await fetchAntigravityEndpoint(
		{ ...endpointRequest, path: RETRIEVE_USER_QUOTA_SUMMARY_PATH },
		ctx,
	);
	let summaryReport: UsageReport | null = null;
	if (summaryResult.response?.ok) {
		const summaryData = (await summaryResult.response.json()) as AntigravityQuotaSummaryResponse;
		summaryReport = buildQuotaSummaryReport(summaryData, params, summaryResult.endpoint, nowMs);
	}

	// Quota buckets do not prove access to an exact model: accounts with shared
	// Claude quota may serve 4.6 but not 5.5. Cache the roster with each usage
	// report, including accounts whose summary already contains an Argon meter.
	let legacyResult: AntigravityEndpointResult;
	try {
		legacyResult = await fetchAntigravityEndpoint({ ...endpointRequest, path: FETCH_AVAILABLE_MODELS_PATH }, ctx);
	} catch (error) {
		if (summaryReport) return summaryReport;
		throw error;
	}
	if (!legacyResult.response?.ok) {
		if (summaryReport) return summaryReport;
		ctx.logger?.warn("Antigravity usage fetch failed", {
			status: legacyResult.response?.status ?? summaryResult.response?.status ?? 0,
			statusText: legacyResult.response?.statusText ?? summaryResult.response?.statusText ?? "unknown",
		});
		return null;
	}
	let data: AntigravityUsageResponse;
	try {
		data = (await legacyResult.response.json()) as AntigravityUsageResponse;
	} catch (error) {
		if (summaryReport) return summaryReport;
		throw error;
	}
	const successfulEndpoint = legacyResult.endpoint;

	const legacyReport = buildLegacyUsageReport(data, params, successfulEndpoint, nowMs);
	if (!summaryReport) return legacyReport;
	// A summary weekly meter can remain funded while an Argon SKU reaches a
	// separate short window or a stricter weekly cap. Keep those direct model
	// gates too; ordinary legacy Gemini counters still cannot gate Argon.
	const summaryArgonLimits = getAntigravityCounterLimits(summaryReport, "google-argon");
	for (const limit of getAntigravityCounterLimits(legacyReport, "google-argon")) {
		const alreadyReported = summaryArgonLimits.some(
			summary =>
				summary.window?.id === limit.window?.id &&
				summary.window?.resetsAt === limit.window?.resetsAt &&
				summary.amount.remainingFraction === limit.amount.remainingFraction,
		);
		if (!alreadyReported) {
			summaryReport.limits.push({
				...limit,
				notes: ["Additional limit reported by the Argon model roster"],
			});
		}
	}
	summaryReport.limits.sort(
		(left, right) => (left.amount.remainingFraction ?? 1) - (right.amount.remainingFraction ?? 1),
	);
	summaryReport.metadata = {
		...summaryReport.metadata,
		argonEligible: legacyReport.metadata?.argonEligible,
		availableModelIds: legacyReport.metadata?.availableModelIds,
	};
	return summaryReport;
}

function buildLegacyUsageReport(
	data: AntigravityUsageResponse,
	params: UsageFetchParams,
	successfulEndpoint: string,
	nowMs: number,
): UsageReport {
	const credential = params.credential;
	// The API returns per-model quota entries, but quota is shared across
	// models within the same backend counter, tier, and reset window. Keep
	// Google and Anthropic-backed Antigravity models separate so a healthy
	// Claude counter cannot mask an exhausted Gemini counter.
	const deduped = new Map<
		string,
		{
			amount: UsageAmount;
			window: UsageWindow | undefined;
			tier: string | undefined;
			tierKey: string;
			windowId: string;
			counterName: string | undefined;
			counterKey: string;
		}
	>();
	let argonEnabled = false;
	let argonDisabled = false;
	const hasModelRoster = data.models && typeof data.models === "object" && !Array.isArray(data.models);
	const availableModelIds =
		hasModelRoster || Array.isArray(data.imageGenerationModelIds) ? new Set<string>() : undefined;

	for (const [modelId, modelInfo] of Object.entries(data.models ?? {})) {
		const modelCounter = getAntigravityCounterKeyForModel(modelId);
		if (modelCounter === "google-argon" && !modelInfo.isInternal) {
			if (modelInfo.disabled === true) argonDisabled = true;
			else argonEnabled = true;
		}
		if (modelInfo.disabled !== true && modelInfo.isInternal !== true) {
			availableModelIds?.add(resolveVariantSelector(params.provider, modelId) ?? modelId);
		}
		if (modelInfo.disabled === true || modelInfo.isInternal === true) continue;
		const quotaInfos = normalizeQuotaInfos(modelInfo);
		const inferredDescriptors = inferWindowDescriptors(quotaInfos, nowMs);
		for (const quotaInfo of quotaInfos) {
			const amount = buildAmount(quotaInfo);
			const window = parseWindow(quotaInfo, inferredDescriptors.get(quotaInfo));
			const tierKey = (quotaInfo.tier ?? "default").toLowerCase();
			const reportedCounterName = formatCounterName(quotaInfo);
			const counterKey = modelCounter ?? reportedCounterName?.toLowerCase() ?? "default";
			const counterName = modelCounter === "google-argon" ? "Gemini (Argon)" : reportedCounterName;
			// Use the parsed window id when available so provider enum names like
			// WINDOW_WEEKLY normalize into the same visible `/usage` group as
			// weeklyQuotaInfo entries.
			const windowId = window?.id ?? quotaInfo.windowId ?? "default";
			const key = `${counterKey}|${tierKey}|${windowId}`;
			const existing = deduped.get(key);
			if (!existing) {
				deduped.set(key, {
					amount,
					window,
					tier: quotaInfo.tier,
					tierKey,
					windowId,
					counterName,
					counterKey,
				});
				continue;
			}
			// Merge: keep the entry with fraction data for the bar, but
			// also keep any window with a reset time so "resets in…" survives.
			const eFrac = existing.amount.remainingFraction;
			const cFrac = amount.remainingFraction;
			const eHasFrac = eFrac !== undefined;
			const cHasFrac = cFrac !== undefined;

			let bestAmount = existing.amount;
			let bestWindow = existing.window?.resetsAt ? existing.window : (window ?? existing.window);
			let bestTier = existing.tier ?? quotaInfo.tier;

			if (!eHasFrac && cHasFrac) {
				bestAmount = amount;
				bestTier = quotaInfo.tier ?? existing.tier;
			} else if (eFrac !== undefined && cFrac !== undefined && cFrac < eFrac) {
				bestAmount = amount;
				bestTier = quotaInfo.tier ?? existing.tier;
			}
			// Always merge in window with reset time if the current
			// best doesn't have one.
			if (!bestWindow?.resetsAt && window?.resetsAt) {
				bestWindow = window;
			}
			deduped.set(key, {
				amount: bestAmount,
				window: bestWindow,
				tier: bestTier,
				tierKey: existing.tierKey,
				windowId: existing.windowId,
				counterName: existing.counterName,
				counterKey: existing.counterKey,
			});
		}
	}
	// Image SKUs can live only in the roster's separate image list.
	if (Array.isArray(data.imageGenerationModelIds)) {
		for (const modelId of data.imageGenerationModelIds) {
			if (typeof modelId !== "string") continue;
			const modelInfo = data.models?.[modelId];
			if (modelInfo?.disabled === true || modelInfo?.isInternal === true) continue;
			availableModelIds?.add(resolveVariantSelector(params.provider, modelId) ?? modelId);
		}
	}

	// Autocomplete models (`tab_*`, internal `chat_*`) report a bare
	// `{ remainingFraction: 1 }` with no reset time on the Google counter. When
	// the metered Gemini window is exhausted, Google reports only the weekly
	// reset, so that unmetered entry no longer merges into a daily sibling and
	// would surface as a phantom "Daily 0%" beside "Weekly 100%". A counter with
	// any windowed entry keeps only its windowed entries.
	const meteredCounters = new Set<string>();
	for (const entry of deduped.values()) {
		if (entry.window?.resetsAt !== undefined) meteredCounters.add(`${entry.counterKey}|${entry.tierKey}`);
	}

	const limits: UsageLimit[] = [];
	for (const entry of deduped.values()) {
		if (entry.window?.resetsAt === undefined && meteredCounters.has(`${entry.counterKey}|${entry.tierKey}`)) {
			continue;
		}
		const label = entry.counterName ? `Usage (${entry.counterName})` : "Usage";
		limits.push({
			id: `${params.provider}:${entry.counterKey}:${entry.tierKey}:${entry.windowId}`,
			label,
			scope: {
				provider: params.provider,
				accountId: credential.accountId,
				projectId: credential.projectId,
				tier: entry.tier,
				windowId: entry.windowId,
			},
			window: entry.window,
			amount: entry.amount,
			status: getUsageStatus(entry.amount.remainingFraction),
		});
	}

	limits.sort((a, b) => {
		const aFraction = a.amount.remainingFraction ?? 1;
		const bFraction = b.amount.remainingFraction ?? 1;
		return aFraction - bFraction;
	});

	const metadata: UsageReport["metadata"] = {
		endpoint: successfulEndpoint,
		projectId: credential.projectId,
		// An enabled roster row proves access, not quota. Missing rows prove
		// neither; an explicit disabled-only roster proves unavailability.
		argonEligible: argonEnabled ? true : argonDisabled ? false : undefined,
		availableModelIds: availableModelIds ? [...availableModelIds] : undefined,
	};
	if (credential.email) metadata.email = credential.email;
	if (credential.accountId) metadata.accountId = credential.accountId;

	const report: UsageReport = {
		provider: params.provider,
		fetchedAt: nowMs,
		limits,
		metadata,
		raw: data,
	};

	return report;
}

export const antigravityUsageProvider: UsageProvider = {
	id: "google-antigravity",
	cacheVersion: 5,
	fetchUsage: fetchAntigravityUsage,
	supports: params => params.provider === "google-antigravity",
};

/** Map an Antigravity model id to its backend quota-counter key. */
export function getAntigravityCounterKeyForModel(modelId: string | undefined): string | undefined {
	return modelId ? quotaTierFor("google-antigravity", modelId) : undefined;
}

function getAntigravityCounterLimits(report: UsageReport, counterKey: string): UsageLimit[] {
	const prefix = `${report.provider}:${counterKey}:`;
	return report.limits.filter(limit => limit.id.toLowerCase().startsWith(prefix));
}


/**
 * Scope an Antigravity report to the active model's backend counter, falling
 * back to legacy default counters only when that backend has no limits.
 * Gemini 4 Argon is scoped by {@link getAntigravityArgonLimits}.
 *
 * Exhaustion checks are only safe with a concrete backend counter. A no-model
 * credential lookup (for example image-provider discovery) must not turn one
 * exhausted family into a provider-wide block.
 */
export function scopeAntigravityLimitsForModel(
	report: UsageReport,
	context: CredentialRankingContext | undefined,
): UsageLimit[] {
	const counterKey = getAntigravityCounterKeyForModel(context?.modelId);
	if (!counterKey) return [];
	const backendLimits = getAntigravityCounterLimits(report, counterKey);
	if (backendLimits.length > 0) return backendLimits;
	// Old default/Google counters mixed ordinary Gemini with Argon. They cannot
	// prove either exhaustion or recovery of the new independent Argon scope.
	if (counterKey === "google-argon") return [];
	return getAntigravityCounterLimits(report, "default");
}

function rankAntigravityLimits(report: UsageReport, context: CredentialRankingContext | undefined): UsageLimit[] {
	const counterKey = getAntigravityCounterKeyForModel(context?.modelId);
	if (!counterKey) return report.limits;
	return scopeAntigravityLimitsForModel(report, context);
}

/**
 * Antigravity quotas are returned per backend counter (Anthropic / Google /
 * OpenAI) and can include both daily and weekly windows. `fetchAntigravityUsage`
 * sorts `limits` ascending by `remainingFraction`; after model-family scoping,
 * the most-pressured relevant counter/window is index 0.
 *
 * Leave `secondary` unset: AuthStorage compares secondary metrics before
 * primary metrics, which is correct for providers with a fixed short/long
 * split but wrong here. Ranking Antigravity by the bottleneck counter first
 * avoids preferring an account at 95% Gemini daily / 0% Claude weekly over one
 * with healthier Gemini headroom.
 */
export const antigravityRankingStrategy: CredentialRankingStrategy = {
	modelAvailability(context) {
		if (!context.modelId) return undefined;
		const modelId = resolveVariantSelector("google-antigravity", context.modelId) ?? context.modelId;
		const isArgon = getAntigravityCounterKeyForModel(context.modelId) === "google-argon";
		return report => {
			const availableModelIds = report?.metadata?.availableModelIds;
			if (Array.isArray(availableModelIds) && availableModelIds.every(id => typeof id === "string")) {
				return availableModelIds.includes(modelId);
			}
			// Older reports without a roster can prove only the dedicated Argon SKU.
			if (!isArgon) return undefined;
			const eligible = report?.metadata?.argonEligible;
			if (typeof eligible === "boolean") return eligible;
			// A dedicated measured quota proves access, not headroom, even when
			// an older cached or caller-supplied report lacks roster metadata.
			if (
				report &&
				getAntigravityCounterLimits(report, "google-argon").some(limit => {
					const remaining = limit.amount.remainingFraction ?? limit.amount.remaining;
					return remaining !== undefined && Number.isFinite(remaining);
				})
			) {
				return true;
			}
			return undefined;
		};
	},
	findWindowLimits(report, context) {
		return { primary: rankAntigravityLimits(report, context)[0] };
	},
	scopeLimits: scopeAntigravityLimitsForModel,
	hasPriorityBoost(primary, _primaryUncapped, context) {
		if (getAntigravityCounterKeyForModel(context?.modelId) !== "google-argon") return false;
		// An ordinary Gemini report does not measure Argon headroom. Prefer a
		// funded Argon meter to an unmeasured account, including near its limit.
		const remaining = primary?.amount.remainingFraction ?? primary?.amount.remaining;
		return remaining !== undefined && Number.isFinite(remaining) && remaining > 0;
	},
	// Always return a scope for Antigravity so missing/unknown model context
	// cannot fall through to AuthStorage's provider-wide block bucket.
	blockScope(context) {
		const counterKey = getAntigravityCounterKeyForModel(context?.modelId);
		return `counter:${counterKey ?? "unknown"}`;
	},
	// One scope per backend counter, judged by the same limits ranking uses
	// for it. A 429 can carry a retry-after at the weekly reset while Google
	// restores the quota days earlier; the next `/usage` fetch then lifts the
	// block instead of the account idling until the clock runs out.
	healableBlockScopes(report) {
		const counterKeys = new Set<string>(["google-argon"]);
		for (const limit of report.limits) {
			const counterKey = limit.id.split(":")[1];
			if (counterKey) counterKeys.add(counterKey.toLowerCase());
		}
		return [...counterKeys]
			.map(counterKey => {
				const limits =
					counterKey === "google-argon" &&
					report.metadata?.quotaSource !== QUOTA_SUMMARY_SOURCE &&
					getAntigravityCounterLimits(report, "google-argon").length === 0
						? getAntigravityCounterLimits(report, "google")
						: getAntigravityCounterLimits(report, counterKey);
				return {
					blockScope: `counter:${counterKey}`,
					limits,
					// Unknown windows cannot prove recovery, even if a sibling window
					// is positive. Every reported gate in this same bucket must be funded.
					healthy:
						limits.length > 0 &&
						limits.every(limit => {
							const remaining = limit.amount.remainingFraction ?? limit.amount.remaining;
							return remaining !== undefined && Number.isFinite(remaining) && remaining > 0;
						}),
				};
			})
			.filter(scope => scope.limits.length > 0);
	},
	// Antigravity windows carry `durationMs` when the response identifies them
	// as daily/weekly. Fall back to daily for legacy unlabelled quotaInfo
	// entries from `daily-cloudcode-pa.googleapis.com`.
	windowDefaults: { primaryMs: DAY_MS, secondaryMs: DAY_MS },
};
