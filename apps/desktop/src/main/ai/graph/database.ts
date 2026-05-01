/**
 * Graph Database
 * ==============
 *
 * SQLite-backed code graph storage with support for:
 * - Nodes (code entities: files, classes, functions, tests)
 * - Edges (relationships: calls, imports, inherits, tests)
 * - Closure table (transitive dependency queries)
 * - Incremental updates (staleness tracking)
 *
 * Integrates with Autocode's existing memory database infrastructure.
 */

import { createHash } from 'node:crypto';
import type { Client as LibsqlClient } from '@libsql/client';
import type {
	CodeGraphNode,
	CodeGraphEdge,
	GraphNodeType,
	GraphEdgeType,
	GraphIndexState,
} from './types';

// =============================================================================
// Schema
// =============================================================================

export const GRAPH_SCHEMA_SQL = `
-- Code graph nodes (files, classes, functions, tests)
CREATE TABLE IF NOT EXISTS code_graph_nodes (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	type TEXT NOT NULL,
	label TEXT NOT NULL,
	file_path TEXT NOT NULL,
	language TEXT NOT NULL,
	start_line INTEGER NOT NULL,
	end_line INTEGER NOT NULL,
	signature TEXT,
	metadata TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	stale_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cgn_project ON code_graph_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_cgn_file ON code_graph_nodes(project_id, file_path);
CREATE INDEX IF NOT EXISTS idx_cgn_type ON code_graph_nodes(project_id, type);
CREATE INDEX IF NOT EXISTS idx_cgn_label ON code_graph_nodes(project_id, label);
CREATE INDEX IF NOT EXISTS idx_cgn_stale ON code_graph_nodes(project_id, stale_at);

-- Code graph edges (relationships between nodes)
CREATE TABLE IF NOT EXISTS code_graph_edges (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	from_id TEXT NOT NULL,
	to_id TEXT NOT NULL,
	type TEXT NOT NULL,
	weight REAL NOT NULL DEFAULT 1.0,
	metadata TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	stale_at INTEGER,
	FOREIGN KEY (from_id) REFERENCES code_graph_nodes(id) ON DELETE CASCADE,
	FOREIGN KEY (to_id) REFERENCES code_graph_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cge_project ON code_graph_edges(project_id);
CREATE INDEX IF NOT EXISTS idx_cge_from ON code_graph_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_cge_to ON code_graph_edges(to_id);
CREATE INDEX IF NOT EXISTS idx_cge_type ON code_graph_edges(project_id, type);
CREATE INDEX IF NOT EXISTS idx_cge_stale ON code_graph_edges(project_id, stale_at);

-- Transitive closure table (for fast ancestor/descendant queries)
CREATE TABLE IF NOT EXISTS code_graph_closure (
	project_id TEXT NOT NULL,
	ancestor_id TEXT NOT NULL,
	descendant_id TEXT NOT NULL,
	depth INTEGER NOT NULL,
	PRIMARY KEY (ancestor_id, descendant_id),
	FOREIGN KEY (ancestor_id) REFERENCES code_graph_nodes(id) ON DELETE CASCADE,
	FOREIGN KEY (descendant_id) REFERENCES code_graph_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cgc_project ON code_graph_closure(project_id);
CREATE INDEX IF NOT EXISTS idx_cgc_ancestor ON code_graph_closure(ancestor_id);
CREATE INDEX IF NOT EXISTS idx_cgc_descendant ON code_graph_closure(descendant_id);
CREATE INDEX IF NOT EXISTS idx_cgc_depth ON code_graph_closure(project_id, depth);

-- Graph index state (metadata about indexed projects)
CREATE TABLE IF NOT EXISTS code_graph_index_state (
	project_id TEXT PRIMARY KEY,
	last_indexed_at INTEGER NOT NULL,
	last_commit_sha TEXT,
	node_count INTEGER NOT NULL DEFAULT 0,
	edge_count INTEGER NOT NULL DEFAULT 0,
	index_version INTEGER NOT NULL DEFAULT 1,
	languages TEXT NOT NULL DEFAULT '[]'
);
`;

// =============================================================================
// GraphDatabase
// =============================================================================

export class GraphDatabase {
	constructor(private client: LibsqlClient) {}

	/**
	 * Initialize graph schema (idempotent).
	 */
	async initialize(): Promise<void> {
		await this.client.batch(GRAPH_SCHEMA_SQL.split(';').filter((s) => s.trim()), 'write');
	}

	// ---------------------------------------------------------------------------
	// Node Operations
	// ---------------------------------------------------------------------------

	/**
	 * Upsert a node (insert or update if exists).
	 */
	async upsertNode(node: Omit<CodeGraphNode, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
		const id = this.generateNodeId(node.projectId, node.filePath, node.label, node.type);
		const now = Date.now();

		await this.client.execute({
			sql: `
				INSERT INTO code_graph_nodes (
					id, project_id, type, label, file_path, language,
					start_line, end_line, signature, metadata,
					created_at, updated_at, stale_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					type = excluded.type,
					label = excluded.label,
					file_path = excluded.file_path,
					language = excluded.language,
					start_line = excluded.start_line,
					end_line = excluded.end_line,
					signature = excluded.signature,
					metadata = excluded.metadata,
					updated_at = excluded.updated_at,
					stale_at = NULL
			`,
			args: [
				id,
				node.projectId,
				node.type,
				node.label,
				node.filePath,
				node.language,
				node.startLine,
				node.endLine,
				node.signature ?? null,
				JSON.stringify(node.metadata),
				now,
				now,
				node.staleAt ?? null,
			],
		});

		return id;
	}

	/**
	 * Get node by ID.
	 */
	async getNode(id: string): Promise<CodeGraphNode | null> {
		const result = await this.client.execute({
			sql: 'SELECT * FROM code_graph_nodes WHERE id = ?',
			args: [id],
		});

		if (result.rows.length === 0) return null;
		return this.rowToNode(result.rows[0]);
	}

	/**
	 * Get all nodes in a file.
	 */
	async getNodesByFile(projectId: string, filePath: string): Promise<CodeGraphNode[]> {
		const result = await this.client.execute({
			sql: 'SELECT * FROM code_graph_nodes WHERE project_id = ? AND file_path = ? AND stale_at IS NULL',
			args: [projectId, filePath],
		});

		return result.rows.map((row) => this.rowToNode(row));
	}

	/**
	 * Get nodes by type (e.g., all tests).
	 */
	async getNodesByType(projectId: string, type: GraphNodeType): Promise<CodeGraphNode[]> {
		const result = await this.client.execute({
			sql: 'SELECT * FROM code_graph_nodes WHERE project_id = ? AND type = ? AND stale_at IS NULL',
			args: [projectId, type],
		});

		return result.rows.map((row) => this.rowToNode(row));
	}

	/**
	 * Mark nodes in a file as stale (for incremental updates).
	 */
	async markFileStale(projectId: string, filePath: string): Promise<void> {
		const now = Date.now();
		await this.client.execute({
			sql: 'UPDATE code_graph_nodes SET stale_at = ? WHERE project_id = ? AND file_path = ?',
			args: [now, projectId, filePath],
		});
	}

	/**
	 * Delete stale nodes (cleanup after incremental update).
	 */
	async deleteStaleNodes(projectId: string): Promise<number> {
		const result = await this.client.execute({
			sql: 'DELETE FROM code_graph_nodes WHERE project_id = ? AND stale_at IS NOT NULL',
			args: [projectId],
		});

		return result.rowsAffected;
	}

	// ---------------------------------------------------------------------------
	// Edge Operations
	// ---------------------------------------------------------------------------

	/**
	 * Upsert an edge (insert or update if exists).
	 */
	async upsertEdge(edge: Omit<CodeGraphEdge, 'id' | 'createdAt' | 'updatedAt'>): Promise<string> {
		const id = this.generateEdgeId(edge.projectId, edge.fromId, edge.toId, edge.type);
		const now = Date.now();

		await this.client.execute({
			sql: `
				INSERT INTO code_graph_edges (
					id, project_id, from_id, to_id, type, weight, metadata,
					created_at, updated_at, stale_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					weight = excluded.weight,
					metadata = excluded.metadata,
					updated_at = excluded.updated_at,
					stale_at = NULL
			`,
			args: [
				id,
				edge.projectId,
				edge.fromId,
				edge.toId,
				edge.type,
				edge.weight,
				JSON.stringify(edge.metadata),
				now,
				now,
				edge.staleAt ?? null,
			],
		});

		return id;
	}

	/**
	 * Get edges from a node (outgoing).
	 */
	async getEdgesFrom(nodeId: string, type?: GraphEdgeType): Promise<CodeGraphEdge[]> {
		const sql = type
			? 'SELECT * FROM code_graph_edges WHERE from_id = ? AND type = ? AND stale_at IS NULL'
			: 'SELECT * FROM code_graph_edges WHERE from_id = ? AND stale_at IS NULL';

		const args = type ? [nodeId, type] : [nodeId];

		const result = await this.client.execute({ sql, args });
		return result.rows.map((row) => this.rowToEdge(row));
	}

	/**
	 * Get edges to a node (incoming).
	 */
	async getEdgesTo(nodeId: string, type?: GraphEdgeType): Promise<CodeGraphEdge[]> {
		const sql = type
			? 'SELECT * FROM code_graph_edges WHERE to_id = ? AND type = ? AND stale_at IS NULL'
			: 'SELECT * FROM code_graph_edges WHERE to_id = ? AND stale_at IS NULL';

		const args = type ? [nodeId, type] : [nodeId];

		const result = await this.client.execute({ sql, args });
		return result.rows.map((row) => this.rowToEdge(row));
	}

	/**
	 * Mark edges involving nodes in a file as stale.
	 */
	async markFileEdgesStale(projectId: string, filePath: string): Promise<void> {
		const now = Date.now();
		await this.client.execute({
			sql: `
				UPDATE code_graph_edges SET stale_at = ?
				WHERE project_id = ? AND (
					from_id IN (SELECT id FROM code_graph_nodes WHERE file_path = ?)
					OR to_id IN (SELECT id FROM code_graph_nodes WHERE file_path = ?)
				)
			`,
			args: [now, projectId, filePath, filePath],
		});
	}

	/**
	 * Delete stale edges (cleanup after incremental update).
	 */
	async deleteStaleEdges(projectId: string): Promise<number> {
		const result = await this.client.execute({
			sql: 'DELETE FROM code_graph_edges WHERE project_id = ? AND stale_at IS NOT NULL',
			args: [projectId],
		});

		return result.rowsAffected;
	}

	// ---------------------------------------------------------------------------
	// Closure Table Operations (Transitive Dependencies)
	// ---------------------------------------------------------------------------

	/**
	 * Rebuild closure table for a project (expensive, run after bulk updates).
	 */
	async rebuildClosure(projectId: string): Promise<void> {
		// Delete existing closure entries
		await this.client.execute({
			sql: 'DELETE FROM code_graph_closure WHERE project_id = ?',
			args: [projectId],
		});

		// Insert direct edges (depth 1)
		await this.client.execute({
			sql: `
				INSERT INTO code_graph_closure (project_id, ancestor_id, descendant_id, depth)
				SELECT project_id, from_id, to_id, 1
				FROM code_graph_edges
				WHERE project_id = ? AND stale_at IS NULL
			`,
			args: [projectId],
		});

		// Compute transitive closure (depth 2-5)
		for (let depth = 2; depth <= 5; depth++) {
			await this.client.execute({
				sql: `
					INSERT OR IGNORE INTO code_graph_closure (project_id, ancestor_id, descendant_id, depth)
					SELECT DISTINCT c1.project_id, c1.ancestor_id, c2.descendant_id, ?
					FROM code_graph_closure c1
					JOIN code_graph_closure c2 ON c1.descendant_id = c2.ancestor_id
					WHERE c1.project_id = ? AND c1.depth = 1 AND c2.depth = ?
				`,
				args: [depth, projectId, depth - 1],
			});
		}
	}

	/**
	 * Get ancestors of a node (who depends on this node).
	 */
	async getAncestors(nodeId: string, maxDepth = 3): Promise<Array<{ ancestorId: string; depth: number }>> {
		const result = await this.client.execute({
			sql: 'SELECT ancestor_id, depth FROM code_graph_closure WHERE descendant_id = ? AND depth <= ? ORDER BY depth',
			args: [nodeId, maxDepth],
		});

		return result.rows.map((row) => ({
			ancestorId: row.ancestor_id as string,
			depth: row.depth as number,
		}));
	}

	/**
	 * Get descendants of a node (what this node depends on).
	 */
	async getDescendants(nodeId: string, maxDepth = 3): Promise<Array<{ descendantId: string; depth: number }>> {
		const result = await this.client.execute({
			sql: 'SELECT descendant_id, depth FROM code_graph_closure WHERE ancestor_id = ? AND depth <= ? ORDER BY depth',
			args: [nodeId, maxDepth],
		});

		return result.rows.map((row) => ({
			descendantId: row.descendant_id as string,
			depth: row.depth as number,
		}));
	}

	// ---------------------------------------------------------------------------
	// Index State Operations
	// ---------------------------------------------------------------------------

	/**
	 * Get index state for a project.
	 */
	async getIndexState(projectId: string): Promise<GraphIndexState | null> {
		const result = await this.client.execute({
			sql: 'SELECT * FROM code_graph_index_state WHERE project_id = ?',
			args: [projectId],
		});

		if (result.rows.length === 0) return null;

		const row = result.rows[0];
		return {
			projectId: row.project_id as string,
			lastIndexedAt: row.last_indexed_at as number,
			lastCommitSha: (row.last_commit_sha as string) ?? undefined,
			nodeCount: row.node_count as number,
			edgeCount: row.edge_count as number,
			indexVersion: row.index_version as number,
			languages: JSON.parse(row.languages as string),
		};
	}

	/**
	 * Update index state for a project.
	 */
	async updateIndexState(state: GraphIndexState): Promise<void> {
		await this.client.execute({
			sql: `
				INSERT INTO code_graph_index_state (
					project_id, last_indexed_at, last_commit_sha,
					node_count, edge_count, index_version, languages
				) VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(project_id) DO UPDATE SET
					last_indexed_at = excluded.last_indexed_at,
					last_commit_sha = excluded.last_commit_sha,
					node_count = excluded.node_count,
					edge_count = excluded.edge_count,
					index_version = excluded.index_version,
					languages = excluded.languages
			`,
			args: [
				state.projectId,
				state.lastIndexedAt,
				state.lastCommitSha ?? null,
				state.nodeCount,
				state.edgeCount,
				state.indexVersion,
				JSON.stringify(state.languages),
			],
		});
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	private generateNodeId(projectId: string, filePath: string, label: string, type: string): string {
		return createHash('sha256').update(`${projectId}:${filePath}:${label}:${type}`).digest('hex').slice(0, 16);
	}

	private generateEdgeId(projectId: string, fromId: string, toId: string, type: string): string {
		return createHash('sha256').update(`${projectId}:${fromId}:${toId}:${type}`).digest('hex').slice(0, 16);
	}

	private rowToNode(row: Record<string, unknown>): CodeGraphNode {
		return {
			id: row.id as string,
			projectId: row.project_id as string,
			type: row.type as GraphNodeType,
			label: row.label as string,
			filePath: row.file_path as string,
			language: row.language as string,
			startLine: row.start_line as number,
			endLine: row.end_line as number,
			signature: (row.signature as string) ?? undefined,
			metadata: JSON.parse(row.metadata as string),
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
			staleAt: (row.stale_at as number) ?? undefined,
		};
	}

	private rowToEdge(row: Record<string, unknown>): CodeGraphEdge {
		return {
			id: row.id as string,
			projectId: row.project_id as string,
			fromId: row.from_id as string,
			toId: row.to_id as string,
			type: row.type as GraphEdgeType,
			weight: row.weight as number,
			metadata: JSON.parse(row.metadata as string),
			createdAt: row.created_at as number,
			updatedAt: row.updated_at as number,
			staleAt: (row.stale_at as number) ?? undefined,
		};
	}
}
