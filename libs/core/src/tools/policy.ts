import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
	ToolUsageLimits,
	ToolUsagePolicyContext,
	ToolUsageState,
} from "./types.js";

export const DEFAULT_READ_ONLY_TOOL_LIMITS: Record<string, number> = {
	Read: 160,
	Glob: 80,
	Grep: 80,
};

export const DEFAULT_MAX_DUPLICATE_READ_ONLY_CALLS = 3;

/**
 * Pattern matching trailing JSON artifact characters that some models leak
 * into tool call string arguments. Matches sequences like `'}},{`, `"}`,
 * `'},` etc. at the end of a path.
 */
const TRAILING_JSON_ARTIFACT_RE = /['"}\],{]+$/;
const WINDOWS_MSYS_DRIVE_PATH_RE = /^\/([A-Za-z])(?:\/(.*))?$/;
const PATH_SIGNATURE_KEYS = new Set(["file_path", "path", "cwd"]);
const URL_SIGNATURE_KEYS = new Set(["url"]);
const QUERY_SIGNATURE_KEYS = new Set(["query"]);
const DOMAIN_LIST_SIGNATURE_KEYS = new Set([
	"allowed_domains",
	"blocked_domains",
	"include_domains",
	"exclude_domains",
	"includeDomains",
	"excludeDomains",
]);

/**
 * Sanitize file_path arguments in tool input.
 *
 * Mutates the input object in place for compatibility with AI SDK tool calls.
 */
export function sanitizeFilePathArg(
	input: Record<string, unknown>,
	platform: NodeJS.Platform = process.platform,
): void {
	const filePath = input.file_path;
	if (typeof filePath !== "string") return;

	let cleaned = filePath;
	cleaned = cleaned.replace(TRAILING_JSON_ARTIFACT_RE, "");
	cleaned = cleaned.replace(/\\/g, "/");
	if (platform === "win32") {
		const msysDrivePath = WINDOWS_MSYS_DRIVE_PATH_RE.exec(cleaned);
		if (msysDrivePath) {
			const [, drive, rest = ""] = msysDrivePath;
			cleaned = `${drive.toUpperCase()}:/${rest}`;
		}
	}

	if (cleaned !== filePath) {
		input.file_path = cleaned;
	}
}

export function createToolUsageState(): ToolUsageState {
	return {
		totalCalls: 0,
		toolCalls: {},
		readOnlySignatureCalls: {},
	};
}

export function getToolUsageState(
	context: ToolUsagePolicyContext,
): ToolUsageState {
	if (!context.toolUsageState) {
		context.toolUsageState = createToolUsageState();
	}
	return context.toolUsageState;
}

export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function normalizeToolSignatureValue(
	value: unknown,
	context: Pick<ToolUsagePolicyContext, "projectDir">,
	key?: string,
): unknown {
	if (Array.isArray(value)) {
		const items = value.map((item) =>
			normalizeToolSignatureValue(item, context, key),
		);
		if (key && DOMAIN_LIST_SIGNATURE_KEYS.has(key)) {
			return [
				...new Set(
					items.filter(
						(item): item is string =>
							typeof item === "string" && item.length > 0,
					),
				),
			].sort((left, right) => left.localeCompare(right));
		}
		return items;
	}

	if (value && typeof value === "object") {
		const normalized: Record<string, unknown> = {};
		for (const [childKey, childValue] of Object.entries(
			value as Record<string, unknown>,
		)) {
			normalized[childKey] = normalizeToolSignatureValue(
				childValue,
				context,
				childKey,
			);
		}
		return normalized;
	}

	if (typeof value !== "string") {
		return value;
	}

	if (key && DOMAIN_LIST_SIGNATURE_KEYS.has(key)) {
		return normalizeToolSignatureDomain(value);
	}

	if (key && URL_SIGNATURE_KEYS.has(key)) {
		return normalizeToolSignatureUrl(value);
	}

	if (key && QUERY_SIGNATURE_KEYS.has(key)) {
		return value.replace(/\s+/g, " ").trim();
	}

	if (key && isPathSignatureKey(key)) {
		return normalizeToolSignaturePath(value, context.projectDir);
	}

	return value;
}

export function buildReadOnlyToolSignature(
	toolName: string,
	input: Record<string, unknown>,
	context: Pick<ToolUsagePolicyContext, "projectDir">,
): string {
	const normalizedInput: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		normalizedInput[key] = normalizeToolSignatureValue(value, context, key);
	}
	return `${toolName}:${stableStringify(normalizedInput)}`;
}

function isPathSignatureKey(key: string): boolean {
	return (
		PATH_SIGNATURE_KEYS.has(key) ||
		key.endsWith("_path") ||
		key.endsWith("Path")
	);
}

function normalizeToolSignaturePath(value: string, projectDir: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}

	const projectRoot = resolve(projectDir);
	const resolvedPath = resolve(projectRoot, trimmed);
	const rel = relative(projectRoot, resolvedPath).replace(/\\/g, "/");
	if (rel === "") {
		return ".";
	}
	if (!rel.startsWith("..") && !isAbsolute(rel)) {
		return rel.replace(/\/+$/, "");
	}

	return resolvedPath.replace(/\\/g, "/").replace(/\/+$/, "");
}

function normalizeToolSignatureUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}

	try {
		const url = new URL(trimmed);
		url.hash = "";
		url.hostname = url.hostname.toLowerCase();
		url.searchParams.sort();
		return url.toString();
	} catch {
		return trimmed.replace(/#.*$/, "");
	}
}

function normalizeToolSignatureDomain(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}

	try {
		const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
			? trimmed
			: `https://${trimmed}`;
		return new URL(withProtocol).hostname.toLowerCase().replace(/\.+$/, "");
	} catch {
		return trimmed
			.toLowerCase()
			.replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
			.split(/[/?#]/, 1)[0]
			.replace(/\.+$/, "");
	}
}

export function resolveToolUsageLimits(
	context: Pick<ToolUsagePolicyContext, "toolUsageLimits">,
): Required<ToolUsageLimits> {
	return {
		readOnlyToolCallLimits: {
			...DEFAULT_READ_ONLY_TOOL_LIMITS,
			...(context.toolUsageLimits?.readOnlyToolCallLimits ?? {}),
		},
		maxDuplicateReadOnlyCalls:
			context.toolUsageLimits?.maxDuplicateReadOnlyCalls ??
			DEFAULT_MAX_DUPLICATE_READ_ONLY_CALLS,
	};
}

/**
 * Track a read-only tool call and return a guard message when the call should
 * be skipped.
 */
export function guardReadOnlyToolUsage(
	toolName: string,
	input: Record<string, unknown>,
	context: ToolUsagePolicyContext,
): string | null {
	const limits = resolveToolUsageLimits(context);
	const state = getToolUsageState(context);

	state.totalCalls += 1;
	state.toolCalls[toolName] = (state.toolCalls[toolName] ?? 0) + 1;

	const toolLimit = limits.readOnlyToolCallLimits[toolName];
	if (toolLimit !== undefined && state.toolCalls[toolName] > toolLimit) {
		return [
			`Tool budget exceeded for ${toolName}: ${state.toolCalls[toolName]} calls in this session, limit ${toolLimit}.`,
			"Use the evidence already gathered, or run a narrower non-repeated query only after starting a new session.",
		].join("\n");
	}

	const signature = buildReadOnlyToolSignature(toolName, input, context);
	const repeated = (state.readOnlySignatureCalls[signature] ?? 0) + 1;
	state.readOnlySignatureCalls[signature] = repeated;
	if (repeated > limits.maxDuplicateReadOnlyCalls) {
		return [
			`Repeated ${toolName} call skipped: the same input has already been used ${repeated - 1} times in this session.`,
			"Use the earlier result, change offset/limit for a targeted range, or narrow the query instead of repeating it.",
		].join("\n");
	}

	return null;
}

/**
 * Return a denial message when a write-like tool tries to write outside the
 * allowed directories. Returns null when no allowedWritePaths policy is set or
 * all provided write paths are allowed.
 */
export function getToolWritePathDenial(
	toolName: string,
	input: Record<string, unknown>,
	allowedWritePaths: string[] | undefined,
	writePathInputKeys: string[] = ["file_path"],
): string | null {
	if (!allowedWritePaths?.length) {
		return null;
	}

	for (const key of writePathInputKeys) {
		const writePath = input[key];
		if (typeof writePath !== "string" || !writePath) continue;

		const resolved = resolve(writePath);
		const allowed = allowedWritePaths.some((dir) => {
			const rel = relative(resolve(dir), resolved);
			return (
				rel === "" ||
				(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
			);
		});
		if (!allowed) {
			return `Write denied: ${toolName} cannot write to ${writePath}. Allowed directories: ${allowedWritePaths.join(", ")}`;
		}
	}

	return null;
}
