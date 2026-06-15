import { describe, expect, it } from "vitest";

import {
	stripLowValueMemoryLines,
	stripLowValueOutcomeLines,
} from "./outcome-content.js";

describe("low-value memory line filtering", () => {
	it("strips generic status and tool echo lines while preserving useful content", () => {
		const result = stripLowValueMemoryLines(
			[
				"Work unit s1 finished with outcome: success.",
				"Work unit s1 (Implement auth cache) finished with outcome: success.",
				"Summary: Auth module narrowed memory lookup before editing.",
				"npm run typecheck passed.",
				'Memory search results for "auth": 1. [gotcha] Already shown.',
				"No issues found.",
				"Duration: 1234ms",
				"Completed at: 2026-06-15T00:00:00.000Z",
				"Mock the OAuth clock before testing refresh retries.",
			].join("\n"),
		);

		expect(result).toBe(
			[
				"Summary: Auth module narrowed memory lookup before editing.",
				"Mock the OAuth clock before testing refresh retries.",
			].join("\n"),
		);
	});

	it("strips localized generic lines without removing actionable Chinese content", () => {
		const result = stripLowValueMemoryLines(
			[
				"\u4efb\u52a1\u5df2\u5b8c\u6210",
				"\u5168\u90e8\u6d4b\u8bd5\u5df2\u901a\u8fc7",
				"\u6ca1\u6709\u53d1\u73b0\u95ee\u9898",
				"\u8ba4\u8bc1\u6a21\u5757\u5fc5\u987b\u5148\u51bb\u7ed3\u65f6\u949f\u518d\u9a8c\u8bc1\u91cd\u8bd5\u3002",
			].join("\n"),
		);

		expect(result).toBe(
			"\u8ba4\u8bc1\u6a21\u5757\u5fc5\u987b\u5148\u51bb\u7ed3\u65f6\u949f\u518d\u9a8c\u8bc1\u91cd\u8bd5\u3002",
		);
	});

	it("strips low-value status fragments from compact single-line memory", () => {
		const result = stripLowValueMemoryLines(
			"Summary: Auth module narrowed memory lookup before editing. npm run typecheck passed. No issues found. Completed at: 2026-06-15T00:00:00.000Z",
		);

		expect(result).toBe(
			"Summary: Auth module narrowed memory lookup before editing.",
		);
	});

	it("strips semicolon-delimited status fragments without dropping useful text", () => {
		const result = stripLowValueMemoryLines(
			"Mock the OAuth clock before testing refresh retries; npm run typecheck passed; No issues found",
		);

		expect(result).toBe("Mock the OAuth clock before testing refresh retries");
	});

	it("strips localized status fragments from compact Chinese memory", () => {
		const result = stripLowValueMemoryLines(
			"\u8ba4\u8bc1\u6a21\u5757\u5fc5\u987b\u5148\u51bb\u7ed3\u65f6\u949f\u518d\u9a8c\u8bc1\u91cd\u8bd5\u3002 \u5168\u90e8\u6d4b\u8bd5\u5df2\u901a\u8fc7\u3002 \u6ca1\u6709\u53d1\u73b0\u95ee\u9898\u3002",
		);

		expect(result).toBe(
			"\u8ba4\u8bc1\u6a21\u5757\u5fc5\u987b\u5148\u51bb\u7ed3\u65f6\u949f\u518d\u9a8c\u8bc1\u91cd\u8bd5\u3002",
		);
	});

	it("keeps the outcome-specific alias aligned with generic filtering", () => {
		const input = [
			"Work unit s1 finished with outcome: success.",
			"npm run typecheck passed.",
			"Completed at: 2026-06-15T00:00:00.000Z",
		].join("\n");

		expect(stripLowValueOutcomeLines(input)).toBe("");
		expect(stripLowValueOutcomeLines(input)).toBe(
			stripLowValueMemoryLines(input),
		);
	});
});
