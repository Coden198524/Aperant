/**
 * Code Graph System
 * ==================
 *
 * Provider-agnostic code graph for token-optimized AI context.
 * Reduces token usage by 5-10x while maintaining code understanding quality.
 *
 * ## Features
 *
 * - **Blast Radius Analysis**: Identify files affected by changes
 * - **Context Optimization**: Select minimal relevant files for AI
 * - **Test Selection**: Run only affected tests
 * - **Incremental Updates**: Fast re-indexing on file changes
 * - **Multi-Language**: TypeScript, JavaScript, Python, Rust, Go, Java, etc.
 *
 * ## Usage
 *
 * ```typescript
 * import { GraphDatabase, BlastRadiusAnalyzer } from './graph';
 * import { getMemoryClient } from '../memory/db';
 *
 * // Initialize
 * const client = await getMemoryClient();
 * const db = new GraphDatabase(client);
 * await db.initialize();
 *
 * // Analyze blast radius
 * const analyzer = new BlastRadiusAnalyzer(db);
 * const result = await analyzer.analyze(projectId, changedFiles);
 *
 * console.log(`Token savings: ${result.tokenSavings.reductionRatio * 100}%`);
 * ```
 *
 * ## Integration Points
 *
 * - **PR Review**: `integration/pr-review-hook.ts`
 * - **QA Agents**: `integration/qa-agent-hook.ts`
 * - **Read Tool**: `integration/read-tool-hook.ts`
 *
 * ## Architecture
 *
 * ```
 * graph/
 * ├── database.ts              # SQLite storage (nodes, edges, closure)
 * ├── types.ts                 # Core type definitions
 * ├── analysis/
 * │   ├── blast-radius.ts      # Impact analysis
 * │   └── context-optimizer.ts # Token-optimized context selection
 * └── integration/
 *     ├── pr-review-hook.ts    # PR review optimization
 *     ├── qa-agent-hook.ts     # QA test selection
 *     └── read-tool-hook.ts    # Read tool suggestions
 * ```
 *
 * ## Provider Support
 *
 * Works with ALL AI providers in Auto Claude:
 * - Anthropic (Claude)
 * - OpenAI (GPT, Codex, o1)
 * - Google (Gemini)
 * - AWS Bedrock
 * - Azure OpenAI
 * - Mistral, Groq, xAI, Ollama
 *
 * Token optimization is provider-agnostic and benefits all models equally.
 */

// =============================================================================
// Core Exports
// =============================================================================

export { GraphDatabase, GRAPH_SCHEMA_SQL } from './database';
export type {
	CodeGraphNode,
	CodeGraphEdge,
	GraphNodeType,
	GraphEdgeType,
	BlastRadiusResult,
	OptimizedContext,
	GraphIndexState,
	LanguageConfig,
	IndexOptions,
	BlastRadiusOptions,
	ContextOptimizationOptions,
} from './types';

// =============================================================================
// Analysis Exports
// =============================================================================

export { BlastRadiusAnalyzer } from './analysis/blast-radius';
export { ContextOptimizer } from './analysis/context-optimizer';

// =============================================================================
// Integration Exports
// =============================================================================

export {
	optimizePRContext,
	buildGraphAnalysisSummary,
	isGraphAvailable,
	type PRContext,
	type ChangedFile,
	type OptimizedPRContext,
} from './integration/pr-review-hook';

export {
	selectAffectedTests,
	formatTestSelectionSummary,
	type TestSelectionResult,
} from './integration/qa-agent-hook';

export {
	createGraphAwareReadTool,
	shouldSuggestRelatedFiles,
	formatGraphSuggestions,
} from './integration/read-tool-hook';

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Initialize graph database schema.
 *
 * Call this once on app startup or when opening a project.
 */
export async function initializeGraphDatabase(db: import('./database').GraphDatabase): Promise<void> {
	await db.initialize();
}

/**
 * Check if graph is indexed for a project.
 */
export async function isProjectIndexed(projectId: string, db: import('./database').GraphDatabase): Promise<boolean> {
	const state = await db.getIndexState(projectId);
	return state !== null && state.nodeCount > 0;
}

/**
 * Get graph statistics for a project.
 */
export async function getGraphStats(
	projectId: string,
	db: import('./database').GraphDatabase,
): Promise<{
	nodeCount: number;
	edgeCount: number;
	languages: string[];
	lastIndexedAt: number | null;
} | null> {
	const state = await db.getIndexState(projectId);
	if (!state) return null;

	return {
		nodeCount: state.nodeCount,
		edgeCount: state.edgeCount,
		languages: state.languages,
		lastIndexedAt: state.lastIndexedAt,
	};
}
