import type { Model } from "@oh-my-pi/pi-ai/types";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { parseModelRedirectSelector } from "./model-redirects-schema";
import type { ModelRegistry } from "./model-registry";
import { formatModelString } from "./model-resolver";

/** Resolve exactly one configured hop, without looking up or authenticating the source. */
export function resolveModelRedirect(
	model: Model,
	redirects: Readonly<Record<string, string>>,
	registry: Pick<ModelRegistry, "find">,
): Model | undefined {
	const source = formatModelString(model);
	if (!Object.hasOwn(redirects, source)) return undefined;
	const target = redirects[source];
	if (source === target) throw new Error(`modelRedirects cannot redirect "${source}" to itself`);
	const parsed = parseModelRedirectSelector(target);
	const resolved = registry.find(parsed.provider, parsed.id);
	// Registry lookup also accepts some alias spellings; redirects are exact, never aliases.
	if (!resolved || formatModelString(resolved) !== target) {
		throw new Error(`Model redirect target "${target}" for "${source}" was not found`);
	}
	if (modelKind(resolved) !== "chat") {
		throw new Error(`Model redirect target "${target}" for "${source}" is not a chat model`);
	}
	return resolved;
}
