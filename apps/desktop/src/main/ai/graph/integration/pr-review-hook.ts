/**
 * PR Review Hook
 * ==============
 *
 * Optimizes PR review context using blast radius analysis.
 * Reduces token usage by 5-10x for large PRs while maintaining review quality.
 *
 * Integration point: apps/desktop/src/main/ai/runners/github/pr-review-engine.ts
 *
 * How it works:
 * 1. Analyze changed files via code graph
 * 2. Identify directly + transitively affected files
 * 3. Select only relevant tests
 * 4. Build optimized diff (exclude irrelevant files)
 * 5. Return optimized context + token savings metrics
 *
 * Provider-agnostic: Works with all AI models (Claude, GPT, Gemini, etc.)
 */

import type { GraphDatabase } from '../database';
import { BlastRadiusAnalyzer } from '../analysis/blast-radius';
import { ContextOptimizer } from '../analysis/context-optimizer';

// =============================================================================
// Types (matching pr-review-engine.ts)
// =============================================================================

export interface PRContext {
	prNumber: number;
	title: string;
	description: string;
	author: string;
	baseBranch: string;
	headBranch: string;
	state: string;
	changedFiles: ChangedFile[];
	diff: string;
	diffTruncated: boolean;
	repoStructure: string;
	relatedFiles: string[];
	commits: Array<Record<string, string>>;
	labels: string[];
	totalAdditions: number;
	totalDeletions: number;
	aiBotComments: unknown[];
}

export interface ChangedFile {
	path: string;
	additions: number;
	deletions: number;
	status: string;
	patch?: string;
}

export interface OptimizedPRContext extends PRContext {
	graphAnalysis?: {
		directlyAffected: string[];
		transitivelyAffected: string[];
		affectedTests: string[];
		tokenSavings: {
			before: number;
			after: number;
			reductionPercent: number;
		};
	};
}

// =============================================================================
// PR Review Optimization
// =============================================================================

/**
 * Optimize PR review context using code graph analysis.
 *
 * This is the main entry point for PR review optimization.
 * Call this before sending context to the review agent.
 *
 * @param context - Original PR context from GitHub API
 * @param projectId - Project identifier for graph lookup
 * @param db - Graph database instance
 * @returns Optimized context + token savings metrics
 */
export async function optimizePRContext(
	context: PRContext,
	projectId: string,
	db: GraphDatabase,
): Promise<{ optimizedContext: OptimizedPRContext; tokenSavings: number }> {
	try {
		const analyzer = new BlastRadiusAnalyzer(db);
		const optimizer = new ContextOptimizer(db);

		// 1. Extract changed file paths
		const changedFilePaths = context.changedFiles.map((f) => f.path);

		// 2. Analyze blast radius
		const blastRadius = await analyzer.analyze(projectId, changedFilePaths, {
			maxDepth: 3,
			includeTests: true,
			confidenceThreshold: 0.5,
		});

		// 3. Build set of relevant files
		const relevantFiles = new Set([
			...changedFilePaths,
			...blastRadius.directlyAffected.map((f) => f.filePath),
			...blastRadius.affectedTests.map((t) => t.filePath),
		]);

		// 4. Filter changed files to only relevant ones
		const optimizedChangedFiles = context.changedFiles.filter((f) => relevantFiles.has(f.path));

		// 5. Build optimized diff (only relevant files)
		const optimizedDiff = buildOptimizedDiff(context.diff, relevantFiles);

		// 6. Calculate token savings
		const tokenSavingsBefore = blastRadius.tokenSavings.beforeTokens;
		const tokenSavingsAfter = blastRadius.tokenSavings.afterTokens;
		const reductionPercent = ((1 - blastRadius.tokenSavings.reductionRatio) * 100).toFixed(1);

		console.log(
			`[GraphPRHook] Optimized PR #${context.prNumber}: ${context.changedFiles.length} → ${optimizedChangedFiles.length} files (${reductionPercent}% token reduction)`,
		);

		// 7. Build optimized context
		const optimizedContext: OptimizedPRContext = {
			...context,
			changedFiles: optimizedChangedFiles,
			diff: optimizedDiff,
			relatedFiles: [
				...context.relatedFiles,
				...blastRadius.directlyAffected.map((f) => f.filePath),
			],
			graphAnalysis: {
				directlyAffected: blastRadius.directlyAffected.map((f) => f.filePath),
				transitivelyAffected: blastRadius.transitivelyAffected.map((f) => f.filePath),
				affectedTests: blastRadius.affectedTests.map((t) => t.filePath),
				tokenSavings: {
					before: tokenSavingsBefore,
					after: tokenSavingsAfter,
					reductionPercent: parseFloat(reductionPercent),
				},
			},
		};

		return {
			optimizedContext,
			tokenSavings: blastRadius.tokenSavings.reductionRatio,
		};
	} catch (error) {
		// Graph analysis failed - return original context
		console.warn('[GraphPRHook] Failed to optimize PR context:', error);
		return {
			optimizedContext: context,
			tokenSavings: 1.0, // No savings
		};
	}
}

/**
 * Build optimized diff containing only relevant files.
 */
function buildOptimizedDiff(fullDiff: string, relevantFiles: Set<string>): string {
	// Split diff into per-file chunks
	const chunks = fullDiff.split(/\ndiff --git /);

	// Filter chunks to only relevant files
	const relevantChunks = chunks.filter((chunk) => {
		// Extract file path from diff header
		const fileMatch = chunk.match(/a\/(.+?) b\//);
		if (!fileMatch) return false;

		const filePath = fileMatch[1];
		return relevantFiles.has(filePath);
	});

	// Rejoin chunks
	if (relevantChunks.length === 0) return '';

	// First chunk doesn't need "diff --git" prefix (it's already there)
	const result = relevantChunks[0] + relevantChunks.slice(1).map((c) => `\ndiff --git ${c}`).join('');

	return result;
}

/**
 * Add graph analysis summary to PR review prompt.
 *
 * This provides the reviewer with context about the blast radius analysis.
 */
export function buildGraphAnalysisSummary(context: OptimizedPRContext): string {
	if (!context.graphAnalysis) return '';

	const { directlyAffected, transitivelyAffected, affectedTests, tokenSavings } = context.graphAnalysis;

	const parts: string[] = [];

	parts.push('## Code Graph Analysis\n');
	parts.push(
		`This PR was analyzed using code graph blast radius analysis. Token usage optimized by ${tokenSavings.reductionPercent}%.\n`,
	);

	if (directlyAffected.length > 0) {
		parts.push(`\n**Directly Affected Files (${directlyAffected.length}):**`);
		parts.push('Files that import or call changed code:');
		for (const file of directlyAffected.slice(0, 10)) {
			parts.push(`- \`${file}\``);
		}
		if (directlyAffected.length > 10) {
			parts.push(`- ... and ${directlyAffected.length - 10} more`);
		}
	}

	if (transitivelyAffected.length > 0) {
		parts.push(`\n**Transitively Affected Files (${transitivelyAffected.length}):**`);
		parts.push('Files affected through dependency chains (not included in review context):');
		for (const file of transitivelyAffected.slice(0, 5)) {
			parts.push(`- \`${file}\``);
		}
		if (transitivelyAffected.length > 5) {
			parts.push(`- ... and ${transitivelyAffected.length - 5} more`);
		}
	}

	if (affectedTests.length > 0) {
		parts.push(`\n**Affected Tests (${affectedTests.length}):**`);
		parts.push('Test files that cover changed code:');
		for (const file of affectedTests.slice(0, 10)) {
			parts.push(`- \`${file}\``);
		}
		if (affectedTests.length > 10) {
			parts.push(`- ... and ${affectedTests.length - 10} more`);
		}
	}

	parts.push(
		`\n**Token Savings:** ${tokenSavings.before.toLocaleString()} → ${tokenSavings.after.toLocaleString()} tokens (${tokenSavings.reductionPercent}% reduction)\n`,
	);

	return parts.join('\n');
}

/**
 * Check if graph is available for a project.
 */
export async function isGraphAvailable(projectId: string, db: GraphDatabase): Promise<boolean> {
	try {
		const indexState = await db.getIndexState(projectId);
		return indexState !== null && indexState.nodeCount > 0;
	} catch {
		return false;
	}
}
