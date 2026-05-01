/**
 * File Watcher
 * =============
 *
 * Watches for file changes and triggers incremental graph updates.
 * Integrates with Autocode's existing file watcher system.
 *
 * Features:
 * - Watch for file saves (create, modify, delete)
 * - Debounced updates (avoid excessive re-indexing)
 * - Integration with git hooks
 * - Automatic re-indexing on file changes
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FSWatcher } from 'node:fs';
import type { GraphDatabase } from '../database';
import { IncrementalIndexer } from './incremental-indexer';
import { isLanguageSupported } from '../parser/language-registry';

// =============================================================================
// Constants
// =============================================================================

const DEBOUNCE_DELAY = 1000; // 1 second debounce
const BATCH_DELAY = 2000; // 2 seconds batch window

// =============================================================================
// File Watcher
// =============================================================================

export class FileWatcher {
	private watcher: FSWatcher | null = null;
	private indexer: IncrementalIndexer;
	private pendingChanges: Map<string, 'create' | 'modify' | 'delete'> = new Map();
	private debounceTimer: NodeJS.Timeout | null = null;
	private isWatching = false;

	constructor(
		private projectId: string,
		private projectRoot: string,
		private db: GraphDatabase,
	) {
		this.indexer = new IncrementalIndexer(db);
	}

	/**
	 * Start watching for file changes.
	 */
	start(): void {
		if (this.isWatching) {
			console.warn('[FileWatcher] Already watching');
			return;
		}

		console.log(`[FileWatcher] Starting watch for: ${this.projectRoot}`);

		this.watcher = fs.watch(
			this.projectRoot,
			{ recursive: true },
			(eventType, filename) => {
				if (!filename) return;

				const filePath = path.join(this.projectRoot, filename);
				this.handleFileChange(filePath, eventType);
			},
		);

		this.isWatching = true;
	}

	/**
	 * Stop watching for file changes.
	 */
	stop(): void {
		if (!this.isWatching) return;

		console.log('[FileWatcher] Stopping watch');

		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}

		this.isWatching = false;
	}

	/**
	 * Handle file change event.
	 */
	private handleFileChange(filePath: string, eventType: string): void {
		// Check if file is a supported source file
		const ext = path.extname(filePath);
		if (!isLanguageSupported(ext)) {
			return;
		}

		// Determine change type
		let changeType: 'create' | 'modify' | 'delete';

		if (eventType === 'rename') {
			// File was created or deleted
			changeType = fs.existsSync(filePath) ? 'create' : 'delete';
		} else {
			// File was modified
			changeType = 'modify';
		}

		// Add to pending changes
		this.pendingChanges.set(filePath, changeType);

		// Debounce updates
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			this.processPendingChanges();
		}, DEBOUNCE_DELAY);
	}

	/**
	 * Process all pending file changes.
	 */
	private async processPendingChanges(): Promise<void> {
		if (this.pendingChanges.size === 0) return;

		const changes = Array.from(this.pendingChanges.entries());
		this.pendingChanges.clear();

		console.log(`[FileWatcher] Processing ${changes.length} file changes`);

		const changedFiles = changes.map(([filePath]) => filePath);

		try {
			await this.indexer.updateChangedFiles(this.projectId, changedFiles);
			console.log('[FileWatcher] Index updated successfully');
		} catch (error) {
			console.error('[FileWatcher] Failed to update index:', error);
		}
	}

	/**
	 * Check if watcher is active.
	 */
	isActive(): boolean {
		return this.isWatching;
	}
}

// =============================================================================
// Watcher Manager
// =============================================================================

/**
 * Global watcher manager for multiple projects.
 */
export class WatcherManager {
	private watchers: Map<string, FileWatcher> = new Map();

	/**
	 * Start watching a project.
	 */
	startWatching(projectId: string, projectRoot: string, db: GraphDatabase): void {
		if (this.watchers.has(projectId)) {
			console.warn(`[WatcherManager] Already watching project: ${projectId}`);
			return;
		}

		const watcher = new FileWatcher(projectId, projectRoot, db);
		watcher.start();

		this.watchers.set(projectId, watcher);
		console.log(`[WatcherManager] Started watching project: ${projectId}`);
	}

	/**
	 * Stop watching a project.
	 */
	stopWatching(projectId: string): void {
		const watcher = this.watchers.get(projectId);
		if (!watcher) {
			console.warn(`[WatcherManager] Not watching project: ${projectId}`);
			return;
		}

		watcher.stop();
		this.watchers.delete(projectId);
		console.log(`[WatcherManager] Stopped watching project: ${projectId}`);
	}

	/**
	 * Stop all watchers.
	 */
	stopAll(): void {
		for (const [projectId, watcher] of this.watchers.entries()) {
			watcher.stop();
		}
		this.watchers.clear();
		console.log('[WatcherManager] Stopped all watchers');
	}

	/**
	 * Get active watcher for a project.
	 */
	getWatcher(projectId: string): FileWatcher | undefined {
		return this.watchers.get(projectId);
	}

	/**
	 * Check if a project is being watched.
	 */
	isWatching(projectId: string): boolean {
		const watcher = this.watchers.get(projectId);
		return watcher?.isActive() ?? false;
	}

	/**
	 * Get list of watched projects.
	 */
	getWatchedProjects(): string[] {
		return Array.from(this.watchers.keys());
	}
}

// Singleton instance
let watcherManager: WatcherManager | null = null;

/**
 * Get global watcher manager instance.
 */
export function getWatcherManager(): WatcherManager {
	if (!watcherManager) {
		watcherManager = new WatcherManager();
	}
	return watcherManager;
}
