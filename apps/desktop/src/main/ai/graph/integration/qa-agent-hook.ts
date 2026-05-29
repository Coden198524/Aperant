/**
 * QA Agent Hook
 * ==============
 *
 * Optimizes QA reviewer/fixer context by selecting only affected tests.
 * Reduces token usage while ensuring comprehensive test coverage.
 *
 * Integration point: apps/desktop/src/main/ai/orchestration/build-orchestrator.ts
 *
 * How it works:
 * 1. QA phase starts after coder completes implementation
 * 2. Hook analyzes changed files via code graph
 * 3. Selects tests that directly cover changed code (critical)
 * 4. Selects tests that cover transitively affected code (suggested)
 * 5. QA agent runs only relevant tests instead of full suite
 *
 * Provider-agnostic: Works with all AI models (Claude, GPT, Gemini, etc.)
 */

import type { GraphDatabase } from '../database';
import { BlastRadiusAnalyzer } from '../analysis/blast-radius';

// =============================================================================
// Types
// =============================================================================

export interface TestSelectionResult {
	criticalTests: string[]; // Must run (directly test changed code)
	suggestedTests: string[]; // Should run (test affected code)
	skippedTests: string[]; // Can skip (unrelated to changes)
	reasoning: string;
	tokenSavings: {
		before: number; // All tests
		after: number; // Selected tests only
		reductionPercent: number;
	};
}

// =============================================================================
// Test Selection
// =============================================================================

/**
 * Select affected tests for QA review.
 *
 * This is the main entry point for QA test selection.
 * Call this before running QA reviewer/fixer agents.
 *
 * @param projectId - Project identifier for graph lookup
 * @param changedFiles - Files changed in this build
 * @param db - Graph database instance
 * @returns Test selection result with critical/suggested/skipped tests
 */
export async function selectAffectedTests(
	projectId: string,
	changedFiles: string[],
	db: GraphDatabase,
): Promise<TestSelectionResult> {
	try {
		const analyzer = new BlastRadiusAnalyzer(db);

		// 1. Analyze blast radius
		const blastRadius = await analyzer.analyze(projectId, changedFiles, {
			maxDepth: 3,
			includeTests: true,
		});

		// 2. Get all test nodes in project
		const allTests = await db.getNodesByType(projectId, 'test');
		const allTestFiles = new Set(allTests.map((t) => t.filePath));

		// 3. Categorize tests
		const criticalTestFiles = new Set(blastRadius.affectedTests.map((t) => t.filePath));
		const suggestedTestFiles = new Set<string>();
		const skippedTestFiles = new Set<string>();

		// Tests that cover transitively affected files are "suggested"
		for (const transitive of blastRadius.transitivelyAffected) {
			// Find tests that cover this file
			const nodes = await db.getNodesByFile(projectId, transitive.filePath);
			for (const node of nodes) {
				const testEdges = await db.getEdgesTo(node.id, 'tests');
				for (const edge of testEdges) {
					const testNode = await db.getNode(edge.fromId);
					if (testNode && !criticalTestFiles.has(testNode.filePath)) {
						suggestedTestFiles.add(testNode.filePath);
					}
				}
			}
		}

		// All other tests are skipped
		for (const testFile of allTestFiles) {
			if (!criticalTestFiles.has(testFile) && !suggestedTestFiles.has(testFile)) {
				skippedTestFiles.add(testFile);
			}
		}

		// 4. Calculate token savings
		const totalTests = allTestFiles.size;
		const selectedTests = criticalTestFiles.size + suggestedTestFiles.size;
		const avgTokensPerTest = 500; // Rough estimate

		const tokensBefore = totalTests * avgTokensPerTest;
		const tokensAfter = selectedTests * avgTokensPerTest;
		const reductionPercent = totalTests > 0 ? ((1 - tokensAfter / tokensBefore) * 100).toFixed(1) : '0.0';

		// 5. Build reasoning
		const reasoning = buildTestSelectionReasoning(
			changedFiles.length,
			criticalTestFiles.size,
			suggestedTestFiles.size,
			skippedTestFiles.size,
		);

		console.log(
			`[GraphQAHook] Selected ${selectedTests}/${totalTests} tests (${reductionPercent}% token reduction)`,
		);

		return {
			criticalTests: Array.from(criticalTestFiles),
			suggestedTests: Array.from(suggestedTestFiles),
			skippedTests: Array.from(skippedTestFiles),
			reasoning,
			tokenSavings: {
				before: tokensBefore,
				after: tokensAfter,
				reductionPercent: parseFloat(reductionPercent),
			},
		};
	} catch (error) {
		// Graph analysis failed - return all tests as critical
		console.warn('[GraphQAHook] Failed to select tests:', error);

		const allTests = await db.getNodesByType(projectId, 'test');
		const allTestFiles = allTests.map((t) => t.filePath);

		return {
			criticalTests: allTestFiles,
			suggestedTests: [],
			skippedTests: [],
			reasoning: 'Graph analysis unavailable - running all tests',
			tokenSavings: {
				before: allTestFiles.length * 500,
				after: allTestFiles.length * 500,
				reductionPercent: 0,
			},
		};
	}
}

/**
 * Build human-readable reasoning for test selection.
 */
function buildTestSelectionReasoning(
	changedFileCount: number,
	criticalTestCount: number,
	suggestedTestCount: number,
	skippedTestCount: number,
): string {
	const parts: string[] = [];

	parts.push(`Analyzed ${changedFileCount} changed file${changedFileCount !== 1 ? 's' : ''}.`);

	if (criticalTestCount > 0) {
		parts.push(
			`Found ${criticalTestCount} critical test${criticalTestCount !== 1 ? 's' : ''} (directly test changed code).`,
		);
	}

	if (suggestedTestCount > 0) {
		parts.push(
			`Found ${suggestedTestCount} suggested test${suggestedTestCount !== 1 ? 's' : ''} (test affected code).`,
		);
	}

	if (skippedTestCount > 0) {
		parts.push(
			`Skipped ${skippedTestCount} test${skippedTestCount !== 1 ? 's' : ''} (unrelated to changes).`,
		);
	}

	return parts.join(' ');
}

/**
 * Format test selection summary for QA agent prompt.
 */
export function formatTestSelectionSummary(result: TestSelectionResult): string {
	const parts: string[] = [];

	parts.push('## Test Selection (Code Graph Analysis)\n');
	parts.push(result.reasoning);
	parts.push('');

	if (result.criticalTests.length > 0) {
		parts.push(`**Critical Tests (${result.criticalTests.length}):**`);
		parts.push('These tests directly cover changed code and should pass:');
		for (const test of result.criticalTests.slice(0, 10)) {
			parts.push(`- \`${test}\``);
		}
		if (result.criticalTests.length > 10) {
			parts.push(`- ... and ${result.criticalTests.length - 10} more`);
		}
		parts.push('');
	}

	if (result.suggestedTests.length > 0) {
		parts.push(`**Suggested Tests (${result.suggestedTests.length}):**`);
		parts.push('These tests cover transitively affected code:');
		for (const test of result.suggestedTests.slice(0, 5)) {
			parts.push(`- \`${test}\``);
		}
		if (result.suggestedTests.length > 5) {
			parts.push(`- ... and ${result.suggestedTests.length - 5} more`);
		}
		parts.push('');
	}

	if (result.skippedTests.length > 0) {
		parts.push(
			`**Skipped Tests (${result.skippedTests.length}):** Unrelated to changes (not shown for brevity)`,
		);
		parts.push('');
	}

	parts.push(
		`**Token Savings:** ${result.tokenSavings.before.toLocaleString()} → ${result.tokenSavings.after.toLocaleString()} tokens (${result.tokenSavings.reductionPercent}% reduction)`,
	);

	return parts.join('\n');
}
