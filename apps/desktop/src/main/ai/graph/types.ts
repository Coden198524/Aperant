/**
 * Code Graph Types
 * =================
 *
 * Type definitions for the code graph system that provides token-optimized
 * context selection for all AI providers (Claude, GPT, Gemini, etc.).
 *
 * Core concepts:
 * - Nodes: Code entities (files, classes, functions, tests)
 * - Edges: Relationships (calls, imports, inherits, tests)
 * - Blast Radius: Impact analysis for changed files
 * - Context Optimization: Select minimal relevant files for AI context
 */

/** Graph node types (AST entities) */
export type GraphNodeType =
	| 'file'
	| 'class'
	| 'function'
	| 'method'
	| 'interface'
	| 'type'
	| 'test'
	| 'import'
	| 'export';

/** Graph edge types (relationships) */
export type GraphEdgeType =
	| 'calls' // Function A calls Function B
	| 'imports' // File A imports from File B
	| 'inherits' // Class A extends Class B
	| 'implements' // Class A implements Interface B
	| 'contains' // File contains Class/Function
	| 'tests' // Test file tests implementation file
	| 'references'; // Generic reference

/** Graph node (symbol in codebase) */
export interface CodeGraphNode {
	id: string; // sha256(projectId:filePath:label:type)
	projectId: string;
	type: GraphNodeType;
	label: string; // Symbol name (e.g., "MyClass", "myFunction")
	filePath: string;
	language: string; // "typescript", "python", etc.
	startLine: number;
	endLine: number;
	signature?: string; // Function signature for better matching
	metadata: {
		isExported?: boolean;
		isAsync?: boolean;
		visibility?: 'public' | 'private' | 'protected';
		complexity?: number; // Cyclomatic complexity
		[key: string]: unknown;
	};
	createdAt: number;
	updatedAt: number;
	staleAt?: number; // Staleness tracking for incremental updates
}

/** Graph edge (relationship between symbols) */
export interface CodeGraphEdge {
	id: string; // sha256(projectId:fromId:toId:type)
	projectId: string;
	fromId: string; // Source node ID
	toId: string; // Target node ID
	type: GraphEdgeType;
	weight: number; // Relationship strength (1.0 = direct, 0.5 = indirect)
	metadata: {
		lineNumber?: number; // Where the relationship occurs
		isConditional?: boolean; // Inside if/try block
		[key: string]: unknown;
	};
	createdAt: number;
	updatedAt: number;
	staleAt?: number;
}

/** Blast radius analysis result */
export interface BlastRadiusResult {
	changedFiles: string[];
	directlyAffected: Array<{
		filePath: string;
		reason: string; // "imports changed file", "calls changed function"
		confidence: number; // 0.0-1.0
	}>;
	transitivelyAffected: Array<{
		filePath: string;
		depth: number; // Hops from changed file
		path: string[]; // Chain of dependencies
	}>;
	affectedTests: Array<{
		filePath: string;
		testedFiles: string[]; // Which changed files this test covers
	}>;
	tokenSavings: {
		beforeTokens: number; // All changed files + full repo context
		afterTokens: number; // Optimized context (only affected files)
		reductionRatio: number; // afterTokens / beforeTokens
	};
}

/** Context optimization result */
export interface OptimizedContext {
	essentialFiles: string[]; // Must-read files (changed + direct deps)
	suggestedFiles: string[]; // Nice-to-have files (transitive deps)
	excludedFiles: string[]; // Files proven irrelevant
	reasoning: string; // Why this context was selected
	estimatedTokens: number; // Approximate token count
}

/** Graph index state */
export interface GraphIndexState {
	projectId: string;
	lastIndexedAt: number;
	lastCommitSha?: string; // Git commit when last indexed
	nodeCount: number;
	edgeCount: number;
	indexVersion: number; // Schema version for migrations
	languages: string[]; // Languages found in project
}

/** Language configuration for parser */
export interface LanguageConfig {
	extensions: string[]; // File extensions (e.g., ['.ts', '.tsx'])
	parserName: string; // Tree-sitter parser name
	queries: {
		classes?: string; // Tree-sitter query for classes
		functions?: string; // Tree-sitter query for functions
		imports?: string; // Tree-sitter query for imports
		exports?: string; // Tree-sitter query for exports
	};
}

/** Indexing options */
export interface IndexOptions {
	projectId: string;
	projectRoot: string;
	includePatterns?: string[]; // Glob patterns to include
	excludePatterns?: string[]; // Glob patterns to exclude
	languages?: string[]; // Languages to index (default: all supported)
	maxConcurrency?: number; // Max parallel file parsing (default: CPU count)
	incremental?: boolean; // Incremental update vs full rebuild
}

/** Blast radius analysis options */
export interface BlastRadiusOptions {
	maxDepth?: number; // Max transitive dependency depth (default: 3)
	includeTests?: boolean; // Include affected tests (default: true)
	confidenceThreshold?: number; // Min confidence for inclusion (default: 0.5)
}

/** Context optimization options */
export interface ContextOptimizationOptions {
	maxFiles?: number; // Max files to include (default: 50)
	maxTokens?: number; // Max estimated tokens (default: 50000)
	prioritizeTests?: boolean; // Prioritize test files (default: true)
	includeTransitive?: boolean; // Include transitive deps (default: true)
}
