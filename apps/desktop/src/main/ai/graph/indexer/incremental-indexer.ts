/**
 * Incremental Indexer
 * ===================
 *
 * Manages incremental graph updates for code changes.
 * Supports both full repo indexing and incremental file updates.
 *
 * Features:
 * - Batch indexing for full repo scan
 * - Incremental updates on file changes (< 2 seconds)
 * - Staleness tracking and cleanup
 * - Parallel file processing
 * - Git integration for change detection
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import { AUTOCODE_COMMON_IGNORED_DIR_NAMES } from '@autocode/core/workspace/ignore-rules';
import type { GraphDatabase } from '../database';
import { parseFile, type ParseResult } from '../parser/tree-sitter-parser';
import { isLanguageSupported, getSupportedExtensions } from '../parser/language-registry';
import type { IndexOptions } from '../types';

const execAsync = promisify(exec);

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_CONCURRENCY = 4; // Parallel file parsing
const DEFAULT_EXCLUDE_PATTERNS = [
	...AUTOCODE_COMMON_IGNORED_DIR_NAMES.map((dirName) => `${dirName}/**`),
	'*.min.js',
	'*.min.css',
	'*.map',
];

// =============================================================================
// Incremental Indexer
// =============================================================================

export class IncrementalIndexer {
	constructor(private db: GraphDatabase) {}

	/**
	 * Index entire project (full scan).
	 *
	 * @param options - Indexing options
	 * @returns Number of files indexed
	 */
	async indexProject(options: IndexOptions): Promise<number> {
		const startTime = Date.now();
		console.log(`[Indexer] Starting full index for project: ${options.projectId}`);

		// Find all source files
		const files = await this.findSourceFiles(options);
		console.log(`[Indexer] Found ${files.length} source files`);

		// Parse files in batches
		const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
		let indexedCount = 0;

		for (let i = 0; i < files.length; i += maxConcurrency) {
			const batch = files.slice(i, i + maxConcurrency);

			await Promise.all(
				batch.map(async (filePath) => {
					try {
						await this.indexFile(options.projectId, filePath);
						indexedCount++;

						if (indexedCount % 100 === 0) {
							console.log(`[Indexer] Progress: ${indexedCount}/${files.length} files`);
						}
					} catch (error) {
						console.error(`[Indexer] Failed to index ${filePath}:`, error);
					}
				}),
			);
		}

		// Rebuild closure table for transitive dependencies
		console.log('[Indexer] Rebuilding closure table...');
		await this.db.rebuildClosure(options.projectId);

		// Update index state
		const languages = this.detectLanguages(files);
		const lastCommitSha = await this.getLastCommitSha(options.projectRoot);

		await this.db.updateIndexState({
			projectId: options.projectId,
			lastIndexedAt: Date.now(),
			lastCommitSha,
			nodeCount: indexedCount,
			edgeCount: 0, // TODO: Count edges
			indexVersion: 1,
			languages,
		});

		const duration = ((Date.now() - startTime) / 1000).toFixed(2);
		console.log(`[Indexer] Completed in ${duration}s. Indexed ${indexedCount} files.`);

		return indexedCount;
	}

	/**
	 * Update index for changed files (incremental).
	 *
	 * @param projectId - Project identifier
	 * @param changedFiles - List of changed file paths
	 * @returns Number of files updated
	 */
	async updateChangedFiles(projectId: string, changedFiles: string[]): Promise<number> {
		const startTime = Date.now();
		console.log(`[Indexer] Updating ${changedFiles.length} changed files`);

		let updatedCount = 0;

		for (const filePath of changedFiles) {
			try {
				// Check if file still exists
				if (!fs.existsSync(filePath)) {
					// File was deleted - mark nodes as stale
					await this.db.markFileStale(projectId, filePath);
					await this.db.markFileEdgesStale(projectId, filePath);
					continue;
				}

				// Re-index the file
				await this.indexFile(projectId, filePath);
				updatedCount++;
			} catch (error) {
				console.error(`[Indexer] Failed to update ${filePath}:`, error);
			}
		}

		// Clean up stale nodes and edges
		const deletedNodes = await this.db.deleteStaleNodes(projectId);
		const deletedEdges = await this.db.deleteStaleEdges(projectId);

		if (deletedNodes > 0 || deletedEdges > 0) {
			console.log(`[Indexer] Cleaned up ${deletedNodes} stale nodes, ${deletedEdges} stale edges`);
		}

		// Rebuild closure table if significant changes
		if (updatedCount > 10) {
			console.log('[Indexer] Rebuilding closure table...');
			await this.db.rebuildClosure(projectId);
		}

		const duration = ((Date.now() - startTime) / 1000).toFixed(2);
		console.log(`[Indexer] Updated ${updatedCount} files in ${duration}s`);

		return updatedCount;
	}

	/**
	 * Index a single file.
	 *
	 * @param projectId - Project identifier
	 * @param filePath - Absolute path to file
	 */
	private async indexFile(projectId: string, filePath: string): Promise<void> {
		// Mark existing nodes/edges as stale
		await this.db.markFileStale(projectId, filePath);
		await this.db.markFileEdgesStale(projectId, filePath);

		// Parse the file
		const result = await parseFile(projectId, filePath);

		// Insert nodes
		for (const node of result.nodes) {
			await this.db.upsertNode(node);
		}

		// Insert edges
		for (const edge of result.edges) {
			await this.db.upsertEdge(edge);
		}
	}

	/**
	 * Find all source files in project.
	 */
	private async findSourceFiles(options: IndexOptions): Promise<string[]> {
		const files: string[] = [];
		const supportedExtensions = new Set(getSupportedExtensions());
		const excludePatterns = [...DEFAULT_EXCLUDE_PATTERNS, ...(options.excludePatterns ?? [])];

		const walk = (dir: string) => {
			const entries = fs.readdirSync(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				const relativePath = path.relative(options.projectRoot, fullPath);

				// Check exclude patterns
				if (this.shouldExclude(relativePath, excludePatterns)) {
					continue;
				}

				if (entry.isDirectory()) {
					walk(fullPath);
				} else if (entry.isFile()) {
					const ext = path.extname(entry.name);
					if (supportedExtensions.has(ext)) {
						files.push(fullPath);
					}
				}
			}
		};

		walk(options.projectRoot);
		return files;
	}

	/**
	 * Check if path should be excluded.
	 */
	private shouldExclude(relativePath: string, patterns: string[]): boolean {
		const normalizedPath = relativePath.replace(/\\/g, '/');

		for (const pattern of patterns) {
			// Simple glob matching
			const regex = new RegExp(
				'^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
			);

			if (regex.test(normalizedPath)) {
				return true;
			}

			// Check if path starts with pattern (for directory exclusions)
			if (pattern.endsWith('/**')) {
				const dirPattern = pattern.slice(0, -3);
				if (normalizedPath.startsWith(dirPattern + '/')) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Detect languages used in project.
	 */
	private detectLanguages(files: string[]): string[] {
		const languages = new Set<string>();

		for (const file of files) {
			const ext = path.extname(file);
			const lang = this.getLanguageFromExtension(ext);
			if (lang) {
				languages.add(lang);
			}
		}

		return Array.from(languages);
	}

	/**
	 * Get language name from file extension.
	 */
	private getLanguageFromExtension(ext: string): string | null {
		const extMap: Record<string, string> = {
			'.cpp': 'C++',
			'.cc': 'C++',
			'.cxx': 'C++',
			'.h': 'C++',
			'.hpp': 'C++',
			'.cs': 'C#',
			'.java': 'Java',
			'.lua': 'Lua',
			'.py': 'Python',
			'.ts': 'TypeScript',
			'.tsx': 'TypeScript',
			'.js': 'JavaScript',
			'.jsx': 'JavaScript',
			'.mjs': 'JavaScript',
		};

		return extMap[ext.toLowerCase()] ?? null;
	}

	/**
	 * Get last git commit SHA.
	 */
	private async getLastCommitSha(projectRoot: string): Promise<string | undefined> {
		try {
			const { stdout } = await execAsync('git rev-parse HEAD', { cwd: projectRoot });
			return stdout.trim();
		} catch {
			return undefined;
		}
	}
}

// =============================================================================
// Git Integration
// =============================================================================

/**
 * Get list of changed files since last commit.
 */
export async function getChangedFilesSinceCommit(
	projectRoot: string,
	lastCommitSha?: string,
): Promise<string[]> {
	try {
		const command = lastCommitSha
			? `git diff --name-only ${lastCommitSha} HEAD`
			: 'git diff --name-only HEAD';

		const { stdout } = await execAsync(command, { cwd: projectRoot });

		return stdout
			.trim()
			.split('\n')
			.filter((line) => line.length > 0)
			.map((relativePath) => path.join(projectRoot, relativePath));
	} catch (error) {
		console.error('[Indexer] Failed to get changed files:', error);
		return [];
	}
}

/**
 * Get list of unstaged changed files.
 */
export async function getUnstagedChangedFiles(projectRoot: string): Promise<string[]> {
	try {
		const { stdout } = await execAsync('git diff --name-only', { cwd: projectRoot });

		return stdout
			.trim()
			.split('\n')
			.filter((line) => line.length > 0)
			.map((relativePath) => path.join(projectRoot, relativePath));
	} catch (error) {
		console.error('[Indexer] Failed to get unstaged files:', error);
		return [];
	}
}
