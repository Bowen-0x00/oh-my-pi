import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";

/** Parse only a literal provider/id, keeping colons and further slashes in the model ID. */
export function parseModelRedirectSelector(selector: string): { provider: string; id: string } {
	const parsed = parseModelString(selector);
	if (!parsed || /[\s*?{}]/.test(selector) || parsed.provider.startsWith("@")) {
		throw new Error(`Invalid model redirect selector "${selector}": expected an exact provider/id`);
	}
	const id = selector.slice(parsed.provider.length + 1);
	if (!id) throw new Error(`Invalid model redirect selector "${selector}": expected an exact provider/id`);
	return { provider: parsed.provider, id };
}

/** Pure validation: settings registration must not import the runtime model resolver. */
export function validateModelRedirects(raw: unknown): void {
	if (raw === undefined || raw === null) return;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("modelRedirects must be a mapping of exact provider/id selectors");
	}
	for (const [source, target] of Object.entries(raw)) {
		parseModelRedirectSelector(source);
		if (typeof target !== "string") {
			throw new Error(`modelRedirects target for "${source}" must be an exact provider/id string`);
		}
		parseModelRedirectSelector(target);
		if (source === target) throw new Error(`modelRedirects cannot redirect "${source}" to itself`);
	}
}
