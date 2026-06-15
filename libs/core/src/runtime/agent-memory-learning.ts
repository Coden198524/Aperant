import type {
	AutocodeSessionError,
	AutocodeSessionMessage,
	AutocodeSessionResult,
} from "./agent-session-types.js";
import { foldRepeatedAutocodePromptLines } from "./prompt-context.js";

export interface AutocodeLearningSubtask {
	id: string;
	description: string;
	filesToModify?: string[];
	filesToCreate?: string[];
	patternFiles?: string[];
}

export interface AutocodeLearningAnalysisInput {
	sessionResult: AutocodeSessionResult;
	subtask: AutocodeLearningSubtask;
}

export interface AutocodeCreateExtractedKnowledgeInput
	extends AutocodeLearningAnalysisInput {
	codePatterns?: AutocodeCodePattern[];
	sessionId?: string;
	timestamp?: string;
}

export interface AutocodeExtractedKnowledge {
	sessionId: string;
	subtaskId: string;
	timestamp: string;
	outcome: string;
	successPatterns?: AutocodeSuccessPattern[];
	failurePatterns?: AutocodeFailureLearningPattern[];
	codePatterns?: AutocodeCodePattern[];
	insights: string[];
	keyFiles: string[];
}

export interface AutocodeSuccessPattern {
	description: string;
	approach: string;
	whyItWorked: string;
	keyDecisions: string[];
	effectiveTools: string[];
	confidence: number;
}

export interface AutocodeFailureLearningPattern {
	description: string;
	errorType: string;
	rootCause: string;
	prevention: string;
	attemptedApproach: string;
	confidence: number;
}

export interface AutocodeCodePattern {
	category:
		| "error_handling"
		| "api_design"
		| "state_management"
		| "data_flow"
		| "testing"
		| "other";
	name: string;
	code: string;
	useCase: string;
	language: string;
	sourceFile: string;
}

const AUTOCODE_MEMORY_DESCRIPTION_MAX_CHARS = 240;
const AUTOCODE_MEMORY_FIELD_MAX_CHARS = 320;
const AUTOCODE_MEMORY_DECISION_MAX_CHARS = 180;
const AUTOCODE_MEMORY_TOOL_MAX_CHARS = 64;
const AUTOCODE_MEMORY_CODE_MAX_CHARS = 420;
const AUTOCODE_MEMORY_SUMMARY_MAX_CHARS = 900;
const AUTOCODE_MEMORY_KEY_FILE_LIMIT = 12;
const AUTOCODE_MEMORY_KEY_FILE_MAX_CHARS = 160;
const AUTOCODE_MEMORY_LIST_LIMIT = 5;
const AUTOCODE_MEMORY_CODE_PATTERN_LIMIT = 4;
const AUTOCODE_TOOL_CONTEXT_WINDOW_CHARS = 600;
const AUTOCODE_SESSION_METRIC_INSIGHT_PATTERNS = [
	/^(?:Summary:\s*)?Efficient token usage\b/i,
	/^(?:Summary:\s*)?High token usage per step\b/i,
	/^(?:Summary:\s*)?Completed quickly with few steps\b/i,
	/^(?:Summary:\s*)?Many steps required\b/i,
	/^(?:Summary:\s*)?Used diverse set of tools\b/i,
] as const;
const AUTOCODE_MUTATION_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit"]);
const AUTOCODE_HIGH_VALUE_TOOL_NAMES = new Set([
	...AUTOCODE_MUTATION_TOOL_NAMES,
	"Bash",
	"mcp__autocode__update_subtask_status",
]);
const AUTOCODE_EXPLORATION_TOOL_NAMES = new Set([
	"Read",
	"Grep",
	"Glob",
	"WebFetch",
	"WebSearch",
	"mcp__autocode__get_session_context",
]);
const AUTOCODE_VERIFICATION_COMMAND_PATTERN =
	/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|lint|check|vitest|jest)\b|\b(?:vitest|jest|playwright|tsc|biome|eslint)\b|\b(?:cargo|go|dotnet)\s+test\b/i;

export function createAutocodeExtractedKnowledge(
	input: AutocodeCreateExtractedKnowledgeInput,
): AutocodeExtractedKnowledge {
	const knowledge: AutocodeExtractedKnowledge = {
		sessionId: input.sessionId ?? generateAutocodeLearningSessionId(),
		subtaskId: input.subtask.id,
		timestamp: input.timestamp ?? new Date().toISOString(),
		outcome: input.sessionResult.outcome,
		insights: extractAutocodeInsights(input),
		keyFiles: identifyAutocodeKeyFiles(input),
	};

	if (input.sessionResult.outcome === "completed") {
		knowledge.successPatterns = extractAutocodeSuccessPatterns(input);
	}

	if (
		input.sessionResult.outcome === "error" ||
		input.sessionResult.outcome === "max_steps"
	) {
		knowledge.failurePatterns = extractAutocodeFailurePatterns(input);
	}

	knowledge.codePatterns = compactAutocodeCodePatterns(
		input.codePatterns ?? [],
	);

	return knowledge;
}

function compactAutocodeCodePatterns(
	patterns: readonly AutocodeCodePattern[],
): AutocodeCodePattern[] {
	const compacted: AutocodeCodePattern[] = [];
	const seen = new Set<string>();
	for (const pattern of patterns) {
		if (!isAutocodeCodePatternWorthRemembering(pattern)) {
			continue;
		}

		const compactedPattern = compactAutocodeCodePattern(pattern);
		const key = getAutocodeCodePatternDedupeKey(compactedPattern);
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		compacted.push(compactedPattern);
		if (compacted.length >= AUTOCODE_MEMORY_CODE_PATTERN_LIMIT) {
			break;
		}
	}
	return compacted;
}

function compactAutocodeCodePattern(
	pattern: AutocodeCodePattern,
): AutocodeCodePattern {
	return {
		category: pattern.category,
		name: limitAutocodeLearningText(
			pattern.name,
			AUTOCODE_MEMORY_FIELD_MAX_CHARS,
		),
		code: limitAutocodeLearningText(
			pattern.code,
			AUTOCODE_MEMORY_CODE_MAX_CHARS,
		),
		useCase: limitAutocodeLearningText(
			pattern.useCase,
			AUTOCODE_MEMORY_FIELD_MAX_CHARS,
		),
		language: limitAutocodeLearningText(
			pattern.language,
			AUTOCODE_MEMORY_TOOL_MAX_CHARS,
		),
		sourceFile: limitAutocodeLearningText(
			pattern.sourceFile,
			AUTOCODE_MEMORY_FIELD_MAX_CHARS,
		),
	};
}

function isAutocodeCodePatternWorthRemembering(
	pattern: AutocodeCodePattern,
): boolean {
	const code = pattern.code.trim();
	if (!code || !pattern.sourceFile.trim()) {
		return false;
	}

	if (isGenericAutocodeApiResponsePattern(pattern, code)) {
		return false;
	}

	if (isGenericAutocodeRethrowPattern(pattern, code)) {
		return false;
	}

	return !(
		pattern.category === "state_management" &&
		pattern.name === "React useState Hook" &&
		/^const\s*\[[^\]]+\]\s*=\s*useState\([^)]*\)\s*;?$/i.test(code)
	);
}

function isGenericAutocodeApiResponsePattern(
	pattern: AutocodeCodePattern,
	code: string,
): boolean {
	if (
		pattern.category !== "api_design" ||
		pattern.name !== "API Response Format"
	) {
		return false;
	}

	const identifiers = getAutocodeCodeIdentifiers(code).filter(
		(identifier) => !AUTOCODE_GENERIC_CODE_PATTERN_IDENTIFIERS.has(identifier),
	);
	return identifiers.length === 0;
}

function isGenericAutocodeRethrowPattern(
	pattern: AutocodeCodePattern,
	code: string,
): boolean {
	if (
		pattern.category !== "error_handling" ||
		pattern.name !== "Try-Catch Block"
	) {
		return false;
	}

	const catchBody =
		code.match(/catch\s*\([^)]+\)\s*\{([\s\S]*)\}\s*$/)?.[1] ?? "";
	const normalized = normalizeAutocodeLearningText(catchBody);
	return /^(?:console\.(?:error|warn|log)\([^)]*\);\s*)?throw\s+\w+;?$/.test(
		normalized,
	);
}

const AUTOCODE_GENERIC_CODE_PATTERN_IDENTIFIERS = new Set([
	"data",
	"error",
	"false",
	"message",
	"null",
	"ok",
	"return",
	"result",
	"response",
	"success",
	"true",
	"value",
]);

function getAutocodeCodeIdentifiers(code: string): string[] {
	return Array.from(code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g), (match) =>
		match[0].toLowerCase(),
	);
}

function getAutocodeCodePatternDedupeKey(pattern: AutocodeCodePattern): string {
	return [
		pattern.category,
		pattern.name,
		normalizeAutocodeLearningTextKey(pattern.code),
	].join("\0");
}

export function extractAutocodeSuccessPatterns(
	input: AutocodeLearningAnalysisInput,
): AutocodeSuccessPattern[] {
	const toolCalls = extractAutocodeToolCallSequence(input.sessionResult);
	const ranVerificationCommand = hasAutocodeVerificationToolCall(
		input.sessionResult,
	);
	const keyDecisions = extractAutocodeKeyDecisions(
		input.sessionResult.messages,
	);
	if (!hasAutocodeReusableSuccessSignal(input, keyDecisions)) {
		return [];
	}

	return [
		{
			description: limitAutocodeLearningText(
				input.subtask.description,
				AUTOCODE_MEMORY_DESCRIPTION_MAX_CHARS,
			),
			approach: limitAutocodeLearningText(
				analyzeAutocodeApproach(toolCalls, { ranVerificationCommand }),
				AUTOCODE_MEMORY_FIELD_MAX_CHARS,
			),
			whyItWorked: limitAutocodeLearningText(
				analyzeAutocodeWhyItWorked(input),
				AUTOCODE_MEMORY_FIELD_MAX_CHARS,
			),
			keyDecisions,
			effectiveTools: identifyAutocodeEffectiveTools(toolCalls).map((tool) =>
				limitAutocodeLearningText(tool, AUTOCODE_MEMORY_TOOL_MAX_CHARS),
			),
			confidence: 0.8,
		},
	];
}

function hasAutocodeReusableSuccessSignal(
	input: AutocodeLearningAnalysisInput,
	keyDecisions: readonly string[],
): boolean {
	return keyDecisions.length > 0 || Boolean(input.subtask.patternFiles?.length);
}

export function extractAutocodeFailurePatterns(
	input: AutocodeLearningAnalysisInput,
): AutocodeFailureLearningPattern[] {
	const error = input.sessionResult.error;
	if (!error) {
		return [];
	}

	const toolCalls = extractAutocodeToolCallSequence(input.sessionResult);
	const ranVerificationCommand = hasAutocodeVerificationToolCall(
		input.sessionResult,
	);
	const rootCause = analyzeAutocodeFailureLearningRootCause(error, toolCalls);

	return [
		{
			description: limitAutocodeLearningText(
				input.subtask.description,
				AUTOCODE_MEMORY_DESCRIPTION_MAX_CHARS,
			),
			errorType: limitAutocodeLearningText(
				error.code,
				AUTOCODE_MEMORY_TOOL_MAX_CHARS,
			),
			rootCause: limitAutocodeLearningText(
				rootCause,
				AUTOCODE_MEMORY_FIELD_MAX_CHARS,
			),
			prevention: limitAutocodeLearningText(
				generateAutocodeFailurePreventionAdvice(error, rootCause),
				AUTOCODE_MEMORY_FIELD_MAX_CHARS,
			),
			attemptedApproach: limitAutocodeLearningText(
				analyzeAutocodeApproach(toolCalls, { ranVerificationCommand }),
				AUTOCODE_MEMORY_FIELD_MAX_CHARS,
			),
			confidence: 0.7,
		},
	];
}

export function extractAutocodeCodePatternsFromContent(
	content: string,
	file: string,
): AutocodeCodePattern[] {
	return [
		...extractAutocodeErrorHandlingPatterns(content, file),
		...extractAutocodeApiPatterns(content, file),
		...extractAutocodeStatePatterns(content, file),
	];
}

export function extractAutocodeToolCallSequence(
	result: Pick<AutocodeSessionResult, "messages">,
): string[] {
	const toolCalls: string[] = [];

	for (const message of result.messages) {
		if (message.role !== "assistant" || !message.content) {
			continue;
		}

		const content = stringifyAutocodeMessageContent(message.content);
		const toolNamePattern = /"toolName"\s*:\s*"([^"]+)"/g;
		for (const match of content.matchAll(toolNamePattern)) {
			const tool = match[1];
			if (tool) {
				toolCalls.push(tool);
			}
		}
	}

	return toolCalls;
}

function hasAutocodeVerificationToolCall(
	result: Pick<AutocodeSessionResult, "messages">,
): boolean {
	for (const message of result.messages) {
		if (message.role !== "assistant" || !message.content) {
			continue;
		}

		const content = stringifyAutocodeMessageContent(message.content);
		const toolNamePattern = /"toolName"\s*:\s*"Bash"/g;
		for (const match of content.matchAll(toolNamePattern)) {
			const startIndex = match.index ?? 0;
			const nearbyToolContext = content.slice(
				startIndex,
				startIndex + AUTOCODE_TOOL_CONTEXT_WINDOW_CHARS,
			);
			if (AUTOCODE_VERIFICATION_COMMAND_PATTERN.test(nearbyToolContext)) {
				return true;
			}
		}
	}

	return false;
}

export function analyzeAutocodeApproach(
	toolCalls: readonly string[],
	options: { ranVerificationCommand?: boolean } = {},
): string {
	const approaches: string[] = [];

	if (
		toolCalls[0] === "Read" ||
		toolCalls[0] === "Grep" ||
		toolCalls[0] === "Glob"
	) {
		approaches.push("Read existing code first to understand context");
	}

	const writeCount = toolCalls.filter((tool) =>
		AUTOCODE_MUTATION_TOOL_NAMES.has(tool),
	).length;
	if (writeCount > 3) {
		approaches.push("Incremental: made multiple small changes");
	}

	if (writeCount > 0 && options.ranVerificationCommand) {
		approaches.push(
			"Validated changes with targeted test or typecheck command",
		);
	} else if (toolCalls.some((tool) => tool === "Bash")) {
		approaches.push("Verified changes by running commands");
	}

	return approaches.join("; ") || "Standard implementation approach";
}

export function extractAutocodeKeyDecisions(
	messages: readonly AutocodeSessionMessage[],
): string[] {
	const decisions: string[] = [];

	for (const message of messages) {
		if (message.role !== "assistant" || typeof message.content !== "string") {
			continue;
		}

		const content = message.content;
		const lower = content.toLowerCase();

		if (lower.includes("decided to") || lower.includes("chose to")) {
			const sentence = content.split(/[.!?]\s/).find((part) => {
				const partLower = part.toLowerCase();
				return partLower.includes("decided") || partLower.includes("chose");
			});
			if (sentence) {
				decisions.push(
					limitAutocodeLearningText(
						sentence,
						AUTOCODE_MEMORY_DECISION_MAX_CHARS,
					),
				);
			}
		}

		if (lower.includes("approach:") || lower.includes("strategy:")) {
			const line = content.split(/\r?\n/).find((part) => {
				const partLower = part.toLowerCase();
				return (
					partLower.includes("approach:") || partLower.includes("strategy:")
				);
			});
			if (line) {
				decisions.push(
					limitAutocodeLearningText(line, AUTOCODE_MEMORY_DECISION_MAX_CHARS),
				);
			}
		}
	}

	return Array.from(new Set(decisions)).slice(0, AUTOCODE_MEMORY_LIST_LIMIT);
}

export function identifyAutocodeEffectiveTools(
	toolCalls: readonly string[],
): string[] {
	const toolCounts = new Map<string, number>();

	for (const tool of toolCalls) {
		toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
	}

	const sortedTools = Array.from(toolCounts.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([tool]) => tool);

	const highValueTools = sortedTools.filter((tool) =>
		AUTOCODE_HIGH_VALUE_TOOL_NAMES.has(tool),
	);
	if (highValueTools.length > 0) {
		return highValueTools.slice(0, 5);
	}

	return sortedTools
		.filter(
			(tool) =>
				(toolCounts.get(tool) ?? 0) > 1 &&
				AUTOCODE_EXPLORATION_TOOL_NAMES.has(tool),
		)
		.slice(0, 5);
}

export function analyzeAutocodeWhyItWorked(
	input: AutocodeLearningAnalysisInput,
): string {
	const reasons: string[] = [];

	if (input.subtask.patternFiles && input.subtask.patternFiles.length > 0) {
		reasons.push("Followed established patterns from reference files");
	}

	if (input.sessionResult.outcome === "completed") {
		reasons.push("Implementation passed all verification checks");
	}

	return reasons.join("; ") || "Standard successful implementation";
}

export function analyzeAutocodeFailureLearningRootCause(
	error: AutocodeSessionError,
	toolCalls: readonly string[],
): string {
	const errorMsg = error.message?.toLowerCase() ?? "";

	if (errorMsg.includes("not found") || errorMsg.includes("cannot find")) {
		return "Missing file or dependency - insufficient context loaded";
	}

	if (errorMsg.includes("syntax") || errorMsg.includes("parse")) {
		return "Syntax error in generated code - pattern not followed correctly";
	}

	if (errorMsg.includes("type") || errorMsg.includes("undefined")) {
		return "Type error - incorrect type usage or missing type definitions";
	}

	if (errorMsg.includes("permission") || errorMsg.includes("access")) {
		return "Permission error - tool execution blocked";
	}

	if (toolCalls.length > 50) {
		return "Too many tool calls - approach was inefficient or stuck in loop";
	}

	if (toolCalls.filter((tool) => tool === "Read").length < 3) {
		return "Insufficient context gathering - should have read more files";
	}

	return limitAutocodeLearningText(
		error.message || "Unknown root cause",
		AUTOCODE_MEMORY_FIELD_MAX_CHARS,
	);
}

export function generateAutocodeFailurePreventionAdvice(
	_error: AutocodeSessionError,
	rootCause: string,
): string {
	if (rootCause.includes("Missing file")) {
		return "Load all related files before implementing. Use Glob to find dependencies.";
	}

	if (rootCause.includes("Syntax error")) {
		return "Study pattern files more carefully. Copy structure exactly.";
	}

	if (rootCause.includes("Type error")) {
		return "Read type definition files. Run typecheck after implementation.";
	}

	if (rootCause.includes("Permission error")) {
		return "Check file permissions. Use appropriate tools for the operation.";
	}

	if (rootCause.includes("Too many tool calls")) {
		return "Plan before implementing. Break down into smaller steps.";
	}

	if (rootCause.includes("Insufficient context")) {
		return "Read pattern files and related implementations first.";
	}

	return "Review error message carefully and adjust approach accordingly.";
}

export function extractAutocodeInsights(
	input: AutocodeLearningAnalysisInput,
): string[] {
	const insights: string[] = [];
	const stepsExecuted = Math.max(1, input.sessionResult.stepsExecuted);
	const tokensPerStep = input.sessionResult.usage.totalTokens / stepsExecuted;

	if (tokensPerStep < 2000) {
		insights.push("Efficient token usage - concise and focused implementation");
	} else if (tokensPerStep > 5000) {
		insights.push("High token usage per step - may need more focused approach");
	}

	if (input.sessionResult.stepsExecuted < 10) {
		insights.push("Completed quickly with few steps - good planning");
	} else if (input.sessionResult.stepsExecuted > 30) {
		insights.push("Many steps required - complex task or inefficient approach");
	}

	const toolCalls = extractAutocodeToolCallSequence(input.sessionResult);
	if (new Set(toolCalls).size > 5) {
		insights.push("Used diverse set of tools - comprehensive approach");
	}

	return insights;
}

export function isAutocodeSessionMetricInsight(insight: string): boolean {
	const text = insight.trim();
	return AUTOCODE_SESSION_METRIC_INSIGHT_PATTERNS.some((pattern) =>
		pattern.test(text),
	);
}

export function identifyAutocodeKeyFiles(
	input: Pick<AutocodeLearningAnalysisInput, "subtask">,
): string[] {
	const keyFiles = [
		...(input.subtask.filesToModify ?? []),
		...(input.subtask.filesToCreate ?? []),
		...(input.subtask.patternFiles ?? []),
	];
	const normalizedFiles: string[] = [];
	const seen = new Set<string>();

	for (const file of keyFiles) {
		const normalized = normalizeAutocodeLearningFilePath(file);
		if (!normalized) {
			continue;
		}

		const compacted = compactAutocodeLearningFilePath(normalized);
		const key = compacted.toLowerCase();
		if (!compacted || seen.has(key)) {
			continue;
		}

		seen.add(key);
		normalizedFiles.push(compacted);
		if (normalizedFiles.length >= AUTOCODE_MEMORY_KEY_FILE_LIMIT) {
			break;
		}
	}

	return normalizedFiles;
}

export function mapAutocodeSessionOutcome(
	outcome: AutocodeSessionResult["outcome"] | string,
): "success" | "failure" | "partial" | "abandoned" {
	switch (outcome) {
		case "completed":
			return "success";
		case "max_steps":
		case "context_window":
			return "partial";
		case "cancelled":
			return "abandoned";
		default:
			return "failure";
	}
}

export function summarizeAutocodeSessionForMemory(
	knowledge: Pick<
		AutocodeExtractedKnowledge,
		"successPatterns" | "failurePatterns" | "insights" | "subtaskId" | "outcome"
	>,
): string {
	const parts = [
		knowledge.successPatterns?.[0]?.description,
		knowledge.successPatterns?.[0]?.approach,
		knowledge.failurePatterns?.[0]?.rootCause,
		knowledge.failurePatterns?.[0]?.prevention,
		knowledge.insights.find(
			(insight) => !isAutocodeSessionMetricInsight(insight),
		),
	]
		.filter(Boolean)
		.map((part) =>
			limitAutocodeLearningText(String(part), AUTOCODE_MEMORY_FIELD_MAX_CHARS),
		);

	return parts.length > 0
		? limitAutocodeLearningText(
				parts.join("\n"),
				AUTOCODE_MEMORY_SUMMARY_MAX_CHARS,
			)
		: "";
}

export function formatAutocodeSuccessPatternMemory(
	pattern: AutocodeSuccessPattern,
): string {
	const lines = [
		`Success pattern: ${limitAutocodeLearningText(pattern.description, AUTOCODE_MEMORY_DESCRIPTION_MAX_CHARS)}`,
		`Approach: ${limitAutocodeLearningText(pattern.approach, AUTOCODE_MEMORY_FIELD_MAX_CHARS)}`,
		`Why it worked: ${limitAutocodeLearningText(pattern.whyItWorked, AUTOCODE_MEMORY_FIELD_MAX_CHARS)}`,
	];
	const decisions = pattern.keyDecisions
		.slice(0, 3)
		.map((decision) =>
			limitAutocodeLearningText(decision, AUTOCODE_MEMORY_DECISION_MAX_CHARS),
		);
	if (decisions.length > 0) {
		lines.push(`Key decisions: ${decisions.join("; ")}`);
	}
	const tools = pattern.effectiveTools
		.slice(0, AUTOCODE_MEMORY_LIST_LIMIT)
		.map((tool) =>
			limitAutocodeLearningText(tool, AUTOCODE_MEMORY_TOOL_MAX_CHARS),
		);
	if (tools.length > 0) {
		lines.push(`Effective tools: ${tools.join(", ")}`);
	}
	return limitAutocodeLearningText(
		lines.join("\n"),
		AUTOCODE_MEMORY_SUMMARY_MAX_CHARS,
	);
}

export function formatAutocodeFailurePatternMemory(
	pattern: AutocodeFailureLearningPattern,
): string {
	return limitAutocodeLearningText(
		[
			`Failure pattern: ${limitAutocodeLearningText(pattern.description, AUTOCODE_MEMORY_DESCRIPTION_MAX_CHARS)}`,
			`Error type: ${limitAutocodeLearningText(pattern.errorType, AUTOCODE_MEMORY_TOOL_MAX_CHARS)}`,
			`Root cause: ${limitAutocodeLearningText(pattern.rootCause, AUTOCODE_MEMORY_FIELD_MAX_CHARS)}`,
			`Prevention: ${limitAutocodeLearningText(pattern.prevention, AUTOCODE_MEMORY_FIELD_MAX_CHARS)}`,
			`Attempted approach: ${limitAutocodeLearningText(pattern.attemptedApproach, AUTOCODE_MEMORY_FIELD_MAX_CHARS)}`,
		].join("\n"),
		AUTOCODE_MEMORY_SUMMARY_MAX_CHARS,
	);
}

export function formatAutocodeCodePatternMemory(
	pattern: AutocodeCodePattern,
): string {
	return limitAutocodeLearningText(
		[
			`Code pattern: ${limitAutocodeLearningText(pattern.name, AUTOCODE_MEMORY_FIELD_MAX_CHARS)}`,
			`Category: ${pattern.category}`,
			`Use case: ${limitAutocodeLearningText(pattern.useCase, AUTOCODE_MEMORY_FIELD_MAX_CHARS)}`,
			`Source: ${limitAutocodeLearningText(pattern.sourceFile, AUTOCODE_MEMORY_FIELD_MAX_CHARS)}`,
			`Code: ${limitAutocodeLearningText(pattern.code, AUTOCODE_MEMORY_CODE_MAX_CHARS)}`,
		].join("\n"),
		AUTOCODE_MEMORY_SUMMARY_MAX_CHARS,
	);
}

export function generateAutocodeLearningSessionId(
	timestampMs = Date.now(),
	randomValue = Math.random(),
): string {
	return `${timestampMs}_${randomValue.toString(36).slice(2, 11)}`;
}

export function formatAutocodeKnowledgeSummary(
	knowledge: AutocodeExtractedKnowledge,
): string {
	const lines: string[] = [];

	lines.push(`Session ${knowledge.sessionId} (${knowledge.outcome})`);
	lines.push(`- Success patterns: ${knowledge.successPatterns?.length ?? 0}`);
	lines.push(`- Failure patterns: ${knowledge.failurePatterns?.length ?? 0}`);
	lines.push(`- Code patterns: ${knowledge.codePatterns?.length ?? 0}`);
	lines.push(`- Insights: ${knowledge.insights.length}`);
	lines.push(`- Key files: ${knowledge.keyFiles.length}`);

	return lines.join("\n");
}

function extractAutocodeErrorHandlingPatterns(
	content: string,
	file: string,
): AutocodeCodePattern[] {
	const patterns: AutocodeCodePattern[] = [];
	const tryCatchMatch = content.match(
		/try\s*\{[\s\S]{20,200}?\}\s*catch\s*\([^)]+\)\s*\{[\s\S]{20,200}?\}/,
	);

	if (tryCatchMatch) {
		patterns.push({
			category: "error_handling",
			name: "Try-Catch Block",
			code: tryCatchMatch[0].trim(),
			useCase: "Handling errors in async operations",
			language: detectAutocodeCodeLanguage(file),
			sourceFile: file,
		});
	}

	return patterns;
}

function extractAutocodeApiPatterns(
	content: string,
	file: string,
): AutocodeCodePattern[] {
	const patterns: AutocodeCodePattern[] = [];
	const responseMatch = content.match(
		/return\s*\{[\s\S]{20,200}(success|data|error)[\s\S]{0,100}\}/,
	);

	if (responseMatch) {
		patterns.push({
			category: "api_design",
			name: "API Response Format",
			code: responseMatch[0].trim(),
			useCase: "Standardized API response structure",
			language: detectAutocodeCodeLanguage(file),
			sourceFile: file,
		});
	}

	return patterns;
}

function extractAutocodeStatePatterns(
	content: string,
	file: string,
): AutocodeCodePattern[] {
	const patterns: AutocodeCodePattern[] = [];
	const useStateMatch = content.match(
		/const\s*\[([^\]]+)\]\s*=\s*useState\([^)]*\)/,
	);

	if (useStateMatch) {
		patterns.push({
			category: "state_management",
			name: "React useState Hook",
			code: useStateMatch[0].trim(),
			useCase: "Managing component state in React",
			language: "typescript",
			sourceFile: file,
		});
	}

	return patterns;
}

function detectAutocodeCodeLanguage(file: string): string {
	if (file.endsWith(".ts") || file.endsWith(".tsx")) {
		return "typescript";
	}
	if (file.endsWith(".js") || file.endsWith(".jsx")) {
		return "javascript";
	}
	if (file.endsWith(".py")) {
		return "python";
	}
	if (file.endsWith(".go")) {
		return "go";
	}
	if (file.endsWith(".rs")) {
		return "rust";
	}
	return "unknown";
}

function stringifyAutocodeMessageContent(
	content: AutocodeSessionMessage["content"] | unknown,
): string {
	return typeof content === "string" ? content : JSON.stringify(content);
}

function limitAutocodeLearningText(value: string, maxChars: number): string {
	const normalized = normalizeAutocodeLearningText(value);
	if (normalized.length <= maxChars) {
		return normalized;
	}
	const marker = " ... [truncated] ... ";
	const budget = maxChars - marker.length;
	if (budget <= 0) {
		return normalized.slice(0, maxChars);
	}
	const headChars = Math.ceil(budget * 0.6);
	const tailChars = budget - headChars;
	return `${normalized.slice(0, headChars).trimEnd()}${marker}${normalized.slice(-tailChars).trimStart()}`;
}

function normalizeAutocodeLearningText(value: string): string {
	return foldRepeatedAutocodePromptLines(value).replace(/\s+/g, " ").trim();
}

function normalizeAutocodeLearningTextKey(value: string): string {
	return normalizeAutocodeLearningText(value).toLowerCase();
}

function normalizeAutocodeLearningFilePath(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.trim()
		.replace(/^(?:\.\/)+/, "")
		.replace(/\/+$/, "");
}

function compactAutocodeLearningFilePath(value: string): string {
	if (value.length <= AUTOCODE_MEMORY_KEY_FILE_MAX_CHARS) {
		return value;
	}
	const marker = "...";
	const budget = AUTOCODE_MEMORY_KEY_FILE_MAX_CHARS - marker.length;
	if (budget <= 0) {
		return value.slice(0, AUTOCODE_MEMORY_KEY_FILE_MAX_CHARS);
	}

	const headChars = Math.ceil(budget * 0.35);
	const tailChars = budget - headChars;
	return `${value.slice(0, headChars)}${marker}${value.slice(-tailChars)}`;
}
