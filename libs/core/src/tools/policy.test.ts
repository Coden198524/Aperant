import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
	buildReadOnlyToolSignature,
	guardReadOnlyToolUsage,
	normalizeToolSignatureValue,
} from "./policy.js";
import type { ToolUsagePolicyContext } from "./types.js";

describe("tool policy read-only signatures", () => {
	it("normalizes equivalent project file paths before duplicate accounting", () => {
		const projectDir = resolve("tmp", "policy-project");
		const absolutePath = join(
			projectDir,
			"src",
			"features",
			"..",
			"features",
			"panel.ts",
		);

		const first = buildReadOnlyToolSignature(
			"Read",
			{ file_path: absolutePath, offset: 1, limit: 20 },
			{ projectDir },
		);
		const second = buildReadOnlyToolSignature(
			"Read",
			{ file_path: "src/features/panel.ts", offset: 1, limit: 20 },
			{ projectDir },
		);

		expect(first).toBe(second);
	});

	it("keeps targeted read ranges distinct after path normalization", () => {
		const projectDir = resolve("tmp", "policy-project");

		const first = buildReadOnlyToolSignature(
			"Read",
			{ file_path: join(projectDir, "src", "panel.ts"), offset: 1, limit: 20 },
			{ projectDir },
		);
		const second = buildReadOnlyToolSignature(
			"Read",
			{ file_path: "src/panel.ts", offset: 21, limit: 20 },
			{ projectDir },
		);

		expect(first).not.toBe(second);
	});

	it("normalizes URL fragments and query parameter order for web fetch signatures", () => {
		const projectDir = resolve("tmp", "policy-project");

		const first = buildReadOnlyToolSignature(
			"WebFetch",
			{ url: "https://Example.com/docs?b=2&a=1#section" },
			{ projectDir },
		);
		const second = buildReadOnlyToolSignature(
			"WebFetch",
			{ url: "https://example.com/docs?a=1&b=2" },
			{ projectDir },
		);

		expect(first).toBe(second);
	});

	it("normalizes search query whitespace and domain filter order", () => {
		const projectDir = resolve("tmp", "policy-project");

		const first = buildReadOnlyToolSignature(
			"WebSearch",
			{
				query: "  electron     preload bridge  ",
				allowed_domains: [
					"HTTPS://GitHub.com/openai/codex",
					"docs.OpenAI.com",
					"github.com",
				],
				blocked_domains: ["spam.example.com", "ADS.example.com/path"],
			},
			{ projectDir },
		);
		const second = buildReadOnlyToolSignature(
			"WebSearch",
			{
				query: "electron preload bridge",
				allowed_domains: ["github.com", "docs.openai.com"],
				blocked_domains: ["ads.example.com", "spam.example.com"],
			},
			{ projectDir },
		);

		expect(first).toBe(second);
	});

	it("skips repeated read-only calls with equivalent inputs", () => {
		const projectDir = resolve("tmp", "policy-project");
		const context: ToolUsagePolicyContext = {
			projectDir,
			toolUsageState: {
				totalCalls: 0,
				toolCalls: {},
				readOnlySignatureCalls: {},
			},
			toolUsageLimits: { maxDuplicateReadOnlyCalls: 1 },
		};

		expect(
			guardReadOnlyToolUsage(
				"Read",
				{ file_path: join(projectDir, "src", "panel.ts"), offset: 1 },
				context,
			),
		).toBeNull();
		expect(
			guardReadOnlyToolUsage(
				"Read",
				{ file_path: "src/panel.ts", offset: 1 },
				context,
			),
		).toContain("Repeated Read call skipped");
	});

	it("recursively normalizes nested signature values", () => {
		const projectDir = resolve("tmp", "policy-project");

		expect(
			normalizeToolSignatureValue(
				{ nested: { file_path: join(projectDir, "src", "nested.ts") } },
				{ projectDir },
			),
		).toEqual({ nested: { file_path: "src/nested.ts" } });
	});
});
