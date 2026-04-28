/**
 * Read Tool Hook
 * ==============
 *
 * Wraps the Read tool to inject graph-optimized context suggestions.
 * When an agent reads a file, the graph suggests related files for complete context.
 *
 * Integration point: apps/desktop/src/main/ai/tools/builtin/read.ts
 *
 * How it works:
 * 1. Agent calls Read tool for file A
 * 2. Hook executes original Read
 * 3. Graph analyzes dependencies of file A
 * 4. Hook appends suggestions: "You may also want to read: B, C, D"
 * 5. Agent can choose to follow suggestions or not
 *
 * Provider-agnostic: Works with all AI models (Claude, GPT, Gemini, etc.)
 * Non-blocking: If graph unavailable, returns original result
 */

import type { Tool as AITool } from 'ai';
import type { GraphDatabase } from '../database';
import { ContextOptimizer } from '../analysis/context-optimizer';

// =============================================================================
// Read Tool Hook
// =============================================================================

/**
 * Create a graph-aware Read tool that suggests related files.
 *
 * @param originalReadTool - The original Read tool from builtin tools
 * @param projectId - Project identifier for graph lookup
 * @param db - Graph database instance
 * @returns Enhanced Read tool with graph suggestions
 */
export function createGraphAwareReadTool(
	originalReadTool: AITool,
	projectId: string,
	db: GraphDatabase,
): AITool {
	// Extract the original tool's properties
	const originalDescription = 'description' in originalReadTool ? originalReadTool.description : '';
	const originalExecute = 'execute' in originalReadTool ? originalReadTool.execute : undefined;

	return {
		...originalReadTool,
		description:
			originalDescription +
			'\n\nNOTE: After reading, you may receive suggestions for related files based on code graph analysis.',
		execute: async (args: { file_path: string; offset?: number; limit?: number }, options?: any) => {
			// Execute original read
			if (!originalExecute) {
				throw new Error('Original Read tool has no execute function');
			}
			const result = await originalExecute(args, options);

			// Get graph-based suggestions (non-blocking)
			try {
				const optimizer = new ContextOptimizer(db);

				const suggestions = await optimizer.getSuggestedFiles(projectId, args.file_path, {
					maxSuggestions: 3,
					maxDepth: 2,
				});

				if (suggestions.length > 0) {
					const suggestionText = suggestions.map((s) => `- ${s.filePath} (${s.reason})`).join('\n');

					return `${result}\n\n[Graph Analysis] Related files you may want to read:\n${suggestionText}`;
				}
			} catch (err) {
				// Graph analysis failed - return original result
				console.warn('[GraphReadHook] Failed to get suggestions:', err);
			}

			return result;
		},
	};
}

/**
 * Check if a file path should trigger graph suggestions.
 *
 * Skip suggestions for:
 * - Config files (package.json, tsconfig.json, etc.)
 * - Lock files
 * - Generated files
 * - Documentation files
 */
export function shouldSuggestRelatedFiles(filePath: string): boolean {
	const skipPatterns = [
		/package\.json$/,
		/tsconfig\.json$/,
		/\.lock$/,
		/\.min\.js$/,
		/\.generated\./,
		/\.md$/,
		/README/i,
		/CHANGELOG/i,
		/LICENSE/i,
	];

	return !skipPatterns.some((pattern) => pattern.test(filePath));
}

/**
 * Format graph suggestions for display in tool result.
 */
export function formatGraphSuggestions(
	suggestions: Array<{ filePath: string; reason: string }>,
	maxDisplay = 3,
): string {
	if (suggestions.length === 0) return '';

	const lines: string[] = ['\n[Graph Analysis] Related files you may want to read:'];

	for (const suggestion of suggestions.slice(0, maxDisplay)) {
		lines.push(`- ${suggestion.filePath} (${suggestion.reason})`);
	}

	if (suggestions.length > maxDisplay) {
		lines.push(`- ... and ${suggestions.length - maxDisplay} more`);
	}

	return lines.join('\n');
}
