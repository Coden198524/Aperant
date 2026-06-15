const LOW_VALUE_WHOLE_LINE_PATTERNS = [
	/^(?:Summary:\s*)?No memory search run\b/i,
	/^(?:Summary:\s*)?No relevant (?:[\w/-]+\s+)*memories found\b/i,
	/^(?:Summary:\s*)?Memory search results\b/i,
	/^(?:Summary:\s*)?Memory system not available\b/i,
	/^(?:Summary:\s*)?Memory (?:recorded|skipped|noted locally|not persisted|search unavailable|system not available)\b/i,
	/^(?:Summary:\s*)?Work unit .+ finished with outcome:\s*success\.?$/i,
] as const;

const LOW_VALUE_OUTCOME_LINE_PATTERNS = [
	...LOW_VALUE_WHOLE_LINE_PATTERNS,
	/^(?:Summary:\s*)?Efficient token usage\b/i,
	/^(?:Summary:\s*)?High token usage per step\b/i,
	/^(?:Summary:\s*)?inspect focused files next\.?$/i,
	/^(?:Summary:\s*)?Completed quickly with few steps\b/i,
	/^(?:Summary:\s*)?Many steps required\b/i,
	/^(?:Summary:\s*)?Used diverse set of tools\b/i,
	/^(?:Summary:\s*)?(?:task|implementation|session|work|subtask)\s+(?:completed|finished|done|succeeded)\b/i,
	/^(?:Summary:\s*)?completed successfully\b/i,
	/^(?:Summary:\s*)?(?:tests?|checks?|typecheck|lint|build)\s+(?:passed|succeeded)\.?$/i,
	/^(?:Summary:\s*)?(?:[\w./:-]+\s+){1,5}(?:tests?|checks?|typecheck|lint|build)\s+(?:passed|succeeded)\.?$/i,
	/^(?:Summary:\s*)?all tests passed\b/i,
	/^(?:Summary:\s*)?no issues found\b/i,
	/^Completed at:\s*\S+/i,
	/^Duration:\s*\d+ms$/i,
	/^(?:Summary:\s*)?\u9ad8\u6548\s*token\s*(?:\u4f7f\u7528|\u6d88\u8017)/i,
	/^(?:Summary:\s*)?token\s*(?:\u4f7f\u7528|\u6d88\u8017|\u7528\u91cf).*(?:\u9ad8|\u4f4e|\u5c11|\u591a)/i,
	/^(?:Summary:\s*)?(?:\u4efb\u52a1|\u5b9e\u73b0|\u4f1a\u8bdd|\u5de5\u4f5c|\u5b50\u4efb\u52a1)\s*(?:\u5df2)?(?:\u5b8c\u6210|\u7ed3\u675f|\u6210\u529f)/i,
	/^(?:Summary:\s*)?(?:\u5168\u90e8|\u6240\u6709)?\s*\u6d4b\u8bd5\s*(?:\u5df2)?\u901a\u8fc7/i,
	/^(?:Summary:\s*)?(?:\u7c7b\u578b\u68c0\u67e5|\u6784\u5efa|\u7f16\u8bd1|\u68c0\u67e5|lint)\s*(?:\u5df2)?\u901a\u8fc7[.\u3002]?$/i,
	/^(?:Summary:\s*)?(?:\u6ca1\u6709|\u672a)\s*\u53d1\u73b0\u95ee\u9898/i,
	/^(?:Summary:\s*)?\u65e0\u95ee\u9898/i,
] as const;

const LOW_VALUE_MEMORY_FRAGMENT_SPLIT_PATTERN =
	/(?<=[.!?\u3002\uff01\uff1f])\s+|;\s+/;
const LOW_VALUE_REASONING_CUE_PATTERN =
	/^(?:Actually,?|Wait[,.]?|Correction:|Let me reconsider[.:]?)\s+/i;

const CONTEXT_COST_SIGNAL_LINE_PATTERNS = [
	/context (?:token )?(?:spike|cost|window)/i,
	/high token usage/i,
	/(?:prompt|input) tokens?/i,
	/\btoken (?:usage|use)\b.*(?:because|from|due to|came from|caused by|when|after|before|broad|full|rerank|embedding|context|memory|search|scan|reduce|narrow|compress|save)/i,
	/\btoken\b.*(?:cost|spike|too many|expensive|reduce|save|compress|narrow)/i,
	/(?:\u4e0a\u4e0b\u6587|\u63d0\u793a\u8bcd|\u8f93\u5165).*token/i,
	/(?:\u51cf\u5c11|\u964d\u4f4e|\u8282\u7701|\u538b\u7f29|\u5c11\u7528|\u5c11\u8017).*token/i,
] as const;

export function stripLowValueMemoryLines(content: string): string {
	return content
		.split(/\r?\n/)
		.map(stripLowValueMemoryLine)
		.filter(Boolean)
		.join("\n")
		.trim();
}

export function stripLowValueOutcomeLines(content: string): string {
	return stripLowValueMemoryLines(content);
}

export function stripLowValueContextCostMemoryLines(content: string): string {
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) =>
			isContextCostSignalLine(line) ? line : stripLowValueMemoryLines(line),
		)
		.filter(Boolean)
		.join("\n")
		.trim();
}

function stripLowValueMemoryLine(line: string): string {
	const trimmed = line.trim();
	if (!trimmed) {
		return "";
	}
	if (isLowValueWholeMemoryLine(trimmed)) {
		return "";
	}

	const fragments = trimmed
		.split(LOW_VALUE_MEMORY_FRAGMENT_SPLIT_PATTERN)
		.map((fragment) => fragment.trim())
		.filter(Boolean);
	if (fragments.length <= 1) {
		return isLowValueMemoryLine(trimmed) ? "" : trimmed;
	}

	return fragments
		.filter((fragment) => !isLowValueMemoryLine(fragment))
		.join(" ")
		.trim();
}

function isLowValueMemoryLine(line: string): boolean {
	return LOW_VALUE_OUTCOME_LINE_PATTERNS.some(
		(pattern) =>
			pattern.test(line) || pattern.test(stripLowValueReasoningCue(line)),
	);
}

function isLowValueWholeMemoryLine(line: string): boolean {
	return LOW_VALUE_WHOLE_LINE_PATTERNS.some(
		(pattern) =>
			pattern.test(line) || pattern.test(stripLowValueReasoningCue(line)),
	);
}

function stripLowValueReasoningCue(line: string): string {
	return line.replace(LOW_VALUE_REASONING_CUE_PATTERN, "").trim();
}

function isContextCostSignalLine(line: string): boolean {
	return CONTEXT_COST_SIGNAL_LINE_PATTERNS.some((pattern) =>
		pattern.test(line),
	);
}
