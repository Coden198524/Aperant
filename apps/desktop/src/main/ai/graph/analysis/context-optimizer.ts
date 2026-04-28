/**
 * Context Optimizer
 * =================
 *
 * Optimizes AI context by selecting minimal relevant files based on code graph analysis.
 * Reduces token usage while maintaining code understanding quality.
 *
 * Key features:
 * - Essential files: Changed files + direct dependencies
 * - Suggested files: Transitive dependencies (nice-to-have)
 * - Excluded files: Proven irrelevant via graph analysis
 * - Token budget management: Stay within model limits
 *
 * Provider-agnostic: Works with all AI models (Claude, GPT, Gemini, etc.)
 */

import type { GraphDatabase } from '../database';
import type { OptimizedContext, ContextOptimizationOptions } from '../types';
import { BlastRadiusAnalyzer } from './blast-radius';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_TOKENS = 50000;
const AVERAGE_LINES_PER_FILE = 200;
const AVERAGE_TOKENS_PER_LINE = 4;

// =============================================================================
// ContextOptimizer
// =============================================================================

export class ContextOptimizer {
	private blastRadiusAnalyzer: BlastRadiusAnalyzer;

	constructor(private db: GraphDatabase) {
		this.blastRadiusAnalyzer = new BlastRadiusAnalyzer(db);
	}

	/**
	 * Optimize context for a set of changed files.
	 *
	 * Returns:
	 * - Essential files (must read)
	 * - Suggested files (nice to have)
	 * - Excluded files (irrelevant)
	 * - Reasoning for selection
	 */
	async optimizeContext(
		projectId: string,
		changedFiles: string[],
		options: ContextOptimizationOptions = {},
	): Promise<OptimizedContext> {
		const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
		const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
		const prioritizeTests = options.prioritizeTests ?? true;
		const includeTransitive = options.includeTransitive ?? true;

		// 1. Analyze blast radius
		const blastRadius = await this.blastRadiusAnalyzer.analyze(projectId, changedFiles, {
			maxDepth: includeTransitive ? 3 : 1,
			includeTests: prioritizeTests,
		});

		// 2. Build essential files list (changed + direct deps + tests)
		const essentialFiles = new Set<string>([
			...changedFiles,
			...blastRadius.directlyAffected.map((f) => f.filePath),
		]);

		if (prioritizeTests) {
			for (const test of blastRadius.affectedTests) {
				essentialFiles.add(test.filePath);
			}
		}

		// 3. Build suggested files list (transitive deps)
		const suggestedFiles: string[] = [];
		if (includeTransitive) {
			for (const transitive of blastRadius.transitivelyAffected) {
				if (!essentialFiles.has(transitive.filePath)) {
					suggestedFiles.push(transitive.filePath);
				}
			}
		}

		// 4. Apply token budget constraints
		const { finalEssential, finalSuggested, excluded } = this.applyBudgetConstraints(
			Array.from(essentialFiles),
			suggestedFiles,
			maxFiles,
			maxTokens,
		);

		// 5. Build reasoning
		const reasoning = this.buildReasoning(
			changedFiles.length,
			finalEssential.length,
			finalSuggested.length,
			excluded.length,
			blastRadius.tokenSavings.reductionRatio,
		);

		// 6. Estimate final token count
		const estimatedTokens = this.estimateTokens(finalEssential.length + finalSuggested.length);

		return {
			essentialFiles: finalEssential,
			suggestedFiles: finalSuggested,
			excludedFiles: excluded,
			reasoning,
			estimatedTokens,
		};
	}

	/**
	 * Get suggested related files for a single file (for Read tool hook).
	 */
	async getSuggestedFiles(
		projectId: string,
		filePath: string,
		options: { maxSuggestions?: number; maxDepth?: number } = {},
	): Promise<Array<{ filePath: string; reason: string }>> {
		const maxSuggestions = options.maxSuggestions ?? 3;
		const maxDepth = options.maxDepth ?? 2;

		// Get nodes in this file
		const nodes = await this.db.getNodesByFile(projectId, filePath);
		if (nodes.length === 0) return [];

		const suggestions = new Map<string, string>();

		for (const node of nodes) {
			// Get direct dependencies (what this file imports/calls)
			const outgoingEdges = await this.db.getEdgesFrom(node.id);

			for (const edge of outgoingEdges) {
				const targetNode = await this.db.getNode(edge.toId);
				if (!targetNode || targetNode.filePath === filePath) continue;

				const reason = this.getEdgeReason(edge.type);
				if (!suggestions.has(targetNode.filePath)) {
					suggestions.set(targetNode.filePath, reason);
				}

				if (suggestions.size >= maxSuggestions) break;
			}

			if (suggestions.size >= maxSuggestions) break;
		}

		return Array.from(suggestions.entries())
			.slice(0, maxSuggestions)
			.map(([filePath, reason]) => ({ filePath, reason }));
	}

	/**
	 * Apply token budget constraints to file lists.
	 */
	private applyBudgetConstraints(
		essentialFiles: string[],
		suggestedFiles: string[],
		maxFiles: number,
		maxTokens: number,
	): { finalEssential: string[]; finalSuggested: string[]; excluded: string[] } {
		const excluded: string[] = [];

		// Always include all essential files (up to maxFiles)
		let finalEssential = essentialFiles;
		if (finalEssential.length > maxFiles) {
			excluded.push(...finalEssential.slice(maxFiles));
			finalEssential = finalEssential.slice(0, maxFiles);
		}

		// Include suggested files if budget allows
		const remainingFiles = maxFiles - finalEssential.length;
		const remainingTokens = maxTokens - this.estimateTokens(finalEssential.length);

		const maxSuggestedFiles = Math.min(
			remainingFiles,
			Math.floor(remainingTokens / (AVERAGE_LINES_PER_FILE * AVERAGE_TOKENS_PER_LINE)),
		);

		const finalSuggested = suggestedFiles.slice(0, maxSuggestedFiles);
		excluded.push(...suggestedFiles.slice(maxSuggestedFiles));

		return { finalEssential, finalSuggested, excluded };
	}

	/**
	 * Build human-readable reasoning for context selection.
	 */
	private buildReasoning(
		changedCount: number,
		essentialCount: number,
		suggestedCount: number,
		excludedCount: number,
		reductionRatio: number,
	): string {
		const parts: string[] = [];

		parts.push(`Analyzed ${changedCount} changed file${changedCount !== 1 ? 's' : ''}.`);
		parts.push(
			`Selected ${essentialCount} essential file${essentialCount !== 1 ? 's' : ''} (changed + direct dependencies + tests).`,
		);

		if (suggestedCount > 0) {
			parts.push(
				`Included ${suggestedCount} suggested file${suggestedCount !== 1 ? 's' : ''} (transitive dependencies).`,
			);
		}

		if (excludedCount > 0) {
			parts.push(
				`Excluded ${excludedCount} file${excludedCount !== 1 ? 's' : ''} (proven irrelevant via graph analysis).`,
			);
		}

		const savingsPercent = ((1 - reductionRatio) * 100).toFixed(1);
		parts.push(`Estimated token savings: ${savingsPercent}%.`);

		return parts.join(' ');
	}

	/**
	 * Estimate token count for a number of files.
	 */
	private estimateTokens(fileCount: number): number {
		return fileCount * AVERAGE_LINES_PER_FILE * AVERAGE_TOKENS_PER_LINE;
	}

	/**
	 * Get human-readable reason for edge type.
	 */
	private getEdgeReason(edgeType: string): string {
		switch (edgeType) {
			case 'calls':
				return 'calls functions in this file';
			case 'imports':
				return 'imports from this file';
			case 'inherits':
				return 'inherits from classes in this file';
			case 'implements':
				return 'implements interfaces in this file';
			case 'references':
				return 'references code in this file';
			default:
				return 'depends on this file';
		}
	}
}
