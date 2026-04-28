/**
 * Graph Indexer - Public API
 * ===========================
 *
 * Main entry point for graph indexing operations.
 * Exports all indexer functionality.
 */

export { IncrementalIndexer, getChangedFilesSinceCommit, getUnstagedChangedFiles } from './incremental-indexer';
export { FileWatcher, WatcherManager, getWatcherManager } from './file-watcher';

// Re-export types
export type { IndexOptions } from '../types';
