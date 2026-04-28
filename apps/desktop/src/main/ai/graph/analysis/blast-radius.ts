/**
 * Blast Radius Analyzer
 * ======================
 *
 * Analyzes the impact of changed files by tracing dependencies through the code graph.
 * Provides token-optimized context by identifying only affected files.
 *
 * Key features:
 * - Direct impact: Files that import/call changed code
 * - Transitive impact: Files affected through dependency chains
 * - Test selection: Tests that cover changed code
 * - Token estimation: Before/after comparison
 *
 * Provider-agnostic: Works with all AI models (Claude, GPT, Gemini, etc.)
 */

import type { GraphDatabase } from '../database';
import type { BlastRadiusResult, BlastRadiusOptions, CodeGraphNode } from '../types';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
const AVERAGE_LINES_PER_FILE = 200;
const AVERAGE_TOKENS_PER_LINE = 4;

// =============================================================================
// BlastRadiusAnalyzer
// =============================================================================

export class BlastRadiusAnalyzer {
	constructor(private db: GraphDatabase) {}

	/**
	 * Analyze the blast radius of changed files.
	 *
	 * Returns:
	 * - Directly affected files (imports/calls changed code)
	 * - Transitively affected files (dependency chains)
	 * - Affected tests
	 * - Token savings estimate
	 */
	async analyze(
		projectId: string,
		changedFiles: string[],
		options: BlastRadiusOptions = {},
	): Promise<BlastRadiusResult> {
		const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
		const includeTests = options.includeTests ?? true;
		const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

		// 1. Get all nodes in changed files
		const changedNodes = await this.getNodesInFiles(projectId, changedFiles);
		const changedNodeIds = new Set(changedNodes.map((n) => n.id));

		// 2. Find directly affected files (depth 1)
		const directlyAffected = await this.findDirectlyAffected(
			projectId,
			changedNodeIds,
			confidenceThreshold,
		);

		// 3. Find transitively affected files (depth 2+)
		const transitivelyAffected = await this.findTransitivelyAffected(
			projectId,
			changedNodeIds,
			maxDepth,
			confidenceThreshold,
		);

		// 4. Find affected tests
		const affectedTests = includeTests
			? await this.findAffectedTests(projectId, changedFiles, directlyAffected, transitivelyAffected)
			: [];

		// 5. Calculate token savings
		const allAffectedFiles = new Set([
			...changedFiles,
			...directlyAffected.map((f) => f.filePath),
			...transitivelyAffected.map((f) => f.filePath),
			...affectedTests.map((t) => t.filePath),
		]);

		const tokenSavings = this.estimateTokenSavings(changedFiles.length, allAffectedFiles.size);

		return {
			changedFiles,
			directlyAffected,
			transitivelyAffected,
			affectedTests,
			tokenSavings,
		};
	}

	/**
	 * Get all nodes in the given files.
	 */
	private async getNodesInFiles(projectId: string, filePaths: string[]): Promise<CodeGraphNode[]> {
		const nodes: CodeGraphNode[] = [];
		for (const filePath of filePaths) {
			const fileNodes = await this.db.getNodesByFile(projectId, filePath);
			nodes.push(...fileNodes);
		}
		return nodes;
	}

	/**
	 * Find files directly affected by changed nodes (depth 1).
	 */
	private async findDirectlyAffected(
		projectId: string,
		changedNodeIds: Set<string>,
		confidenceThreshold: number,
	): Promise<Array<{ filePath: string; reason: string; confidence: number }>> {
		const affectedMap = new Map<string, { reason: string; confidence: number }>();

		for (const nodeId of changedNodeIds) {
			// Find all edges pointing TO this node (who depends on it)
			const incomingEdges = await this.db.getEdgesTo(nodeId);

			for (const edge of incomingEdges) {
				// Get the source node (the one that depends on changed code)
				const sourceNode = await this.db.getNode(edge.fromId);
				if (!sourceNode) continue;

				const confidence = edge.weight;
				if (confidence < confidenceThreshold) continue;

				// Skip if it's in a changed file (already known)
				if (changedNodeIds.has(sourceNode.id)) continue;

				const reason = this.getEdgeReason(edge.type);
				const existing = affectedMap.get(sourceNode.filePath);

				// Keep highest confidence reason
				if (!existing || confidence > existing.confidence) {
					affectedMap.set(sourceNode.filePath, { reason, confidence });
				}
			}
		}

		return Array.from(affectedMap.entries()).map(([filePath, { reason, confidence }]) => ({
			filePath,
			reason,
			confidence,
		}));
	}

	/**
	 * Find files transitively affected by changed nodes (depth 2+).
	 */
	private async findTransitivelyAffected(
		projectId: string,
		changedNodeIds: Set<string>,
		maxDepth: number,
		confidenceThreshold: number,
	): Promise<Array<{ filePath: string; depth: number; path: string[] }>> {
		const affectedMap = new Map<string, { depth: number; path: string[] }>();

		for (const nodeId of changedNodeIds) {
			// Get ancestors (nodes that transitively depend on this node)
			const ancestors = await this.db.getAncestors(nodeId, maxDepth);

			for (const { ancestorId, depth } of ancestors) {
				if (depth <= 1) continue; // Skip direct dependencies (already handled)

				const ancestorNode = await this.db.getNode(ancestorId);
				if (!ancestorNode) continue;

				// Skip if already in directly affected or changed files
				if (changedNodeIds.has(ancestorId)) continue;

				const existing = affectedMap.get(ancestorNode.filePath);

				// Keep shortest path
				if (!existing || depth < existing.depth) {
					affectedMap.set(ancestorNode.filePath, {
						depth,
						path: [], // TODO: Reconstruct actual path if needed
					});
				}
			}
		}

		return Array.from(affectedMap.entries()).map(([filePath, { depth, path }]) => ({
			filePath,
			depth,
			path,
		}));
	}

	/**
	 * Find tests affected by changed files.
	 */
	private async findAffectedTests(
		projectId: string,
		changedFiles: string[],
		directlyAffected: Array<{ filePath: string }>,
		transitivelyAffected: Array<{ filePath: string }>,
	): Promise<Array<{ filePath: string; testedFiles: string[] }>> {
		// Get all test nodes
		const testNodes = await this.db.getNodesByType(projectId, 'test');

		const affectedTests: Array<{ filePath: string; testedFiles: string[] }> = [];
		const allAffectedFiles = new Set([
			...changedFiles,
			...directlyAffected.map((f) => f.filePath),
			...transitivelyAffected.map((f) => f.filePath),
		]);

		for (const testNode of testNodes) {
			// Find what this test tests (via 'tests' edges)
			const testEdges = await this.db.getEdgesFrom(testNode.id, 'tests');

			const testedFiles: string[] = [];
			for (const edge of testEdges) {
				const testedNode = await this.db.getNode(edge.toId);
				if (testedNode && allAffectedFiles.has(testedNode.filePath)) {
					testedFiles.push(testedNode.filePath);
				}
			}

			if (testedFiles.length > 0) {
				affectedTests.push({
					filePath: testNode.filePath,
					testedFiles,
				});
			}
		}

		return affectedTests;
	}

	/**
	 * Estimate token savings from blast radius optimization.
	 */
	private estimateTokenSavings(
		changedFileCount: number,
		affectedFileCount: number,
	): { beforeTokens: number; afterTokens: number; reductionRatio: number } {
		// Before: Assume we'd read all changed files + some context (2x multiplier)
		const beforeTokens = changedFileCount * 2 * AVERAGE_LINES_PER_FILE * AVERAGE_TOKENS_PER_LINE;

		// After: Only read affected files
		const afterTokens = affectedFileCount * AVERAGE_LINES_PER_FILE * AVERAGE_TOKENS_PER_LINE;

		const reductionRatio = beforeTokens > 0 ? afterTokens / beforeTokens : 1.0;

		return {
			beforeTokens,
			afterTokens,
			reductionRatio,
		};
	}

	/**
	 * Get human-readable reason for edge type.
	 */
	private getEdgeReason(edgeType: string): string {
		switch (edgeType) {
			case 'calls':
				return 'calls changed function';
			case 'imports':
				return 'imports changed file';
			case 'inherits':
				return 'inherits from changed class';
			case 'implements':
				return 'implements changed interface';
			case 'references':
				return 'references changed code';
			default:
				return 'depends on changed code';
		}
	}
}
