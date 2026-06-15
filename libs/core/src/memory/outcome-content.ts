const LOW_VALUE_OUTCOME_LINE_PATTERNS = [
	/^(?:Summary:\s*)?Efficient token usage\b/i,
	/^(?:Summary:\s*)?High token usage per step\b/i,
	/^(?:Summary:\s*)?No memory search run\b/i,
	/^(?:Summary:\s*)?No relevant (?:[\w/-]+\s+)*memories found\b/i,
	/^(?:Summary:\s*)?Memory search results\b/i,
	/^(?:Summary:\s*)?Memory system not available\b/i,
	/^(?:Summary:\s*)?Memory (?:recorded|skipped|noted locally|system not available)\b/i,
	/^(?:Summary:\s*)?Work unit .+ finished with outcome:\s*success\.?$/i,
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

export function stripLowValueMemoryLines(content: string): string {
	return content
		.split(/\r?\n/)
		.filter(
			(line) =>
				!LOW_VALUE_OUTCOME_LINE_PATTERNS.some((pattern) =>
					pattern.test(line.trim()),
				),
		)
		.join("\n")
		.trim();
}

export function stripLowValueOutcomeLines(content: string): string {
	return stripLowValueMemoryLines(content);
}
