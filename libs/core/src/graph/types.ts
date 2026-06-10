export type GraphNodeType =
  | 'file'
  | 'class'
  | 'function'
  | 'method'
  | 'interface'
  | 'type'
  | 'type_alias'
  | 'variable'
  | 'enum'
  | 'module'
  | 'test'
  | 'import'
  | 'export';

export type GraphEdgeType =
  | 'calls'
  | 'imports'
  | 'imports_symbol'
  | 'inherits'
  | 'extends'
  | 'implements'
  | 'contains'
  | 'tests'
  | 'references'
  | 'exports'
  | 'defined_in';

export interface CodeGraphNode {
  id: string;
  projectId: string;
  type: GraphNodeType;
  label: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  signature?: string;
  metadata: {
    isExported?: boolean;
    isAsync?: boolean;
    visibility?: 'public' | 'private' | 'protected';
    complexity?: number;
    [key: string]: unknown;
  };
  createdAt: number;
  updatedAt: number;
  staleAt?: number;
}

export interface CodeGraphEdge {
  id: string;
  projectId: string;
  fromId: string;
  toId: string;
  type: GraphEdgeType;
  weight: number;
  metadata: {
    lineNumber?: number;
    isConditional?: boolean;
    [key: string]: unknown;
  };
  createdAt: number;
  updatedAt: number;
  staleAt?: number;
}

export type GraphNodeSource = 'ast' | 'scip' | 'llm' | 'agent';
export type GraphNodeConfidence = 'confirmed' | 'inferred' | 'speculative';

export interface GraphNode {
  id: string;
  projectId: string;
  type: GraphNodeType;
  label: string;
  filePath?: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  layer: number;
  source: GraphNodeSource;
  confidence: GraphNodeConfidence;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  staleAt?: number;
  associatedMemoryIds: string[];
}

export interface GraphEdge {
  id: string;
  projectId: string;
  fromId: string;
  toId: string;
  type: GraphEdgeType;
  layer: number;
  weight: number;
  source: GraphNodeSource;
  confidence: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  staleAt?: number;
}

export interface ClosureEntry {
  ancestorId: string;
  descendantId: string;
  depth: number;
  path: string[];
  edgeTypes: GraphEdgeType[];
  totalWeight: number;
}

export interface BlastRadiusResult {
  changedFiles: string[];
  directlyAffected: Array<{
    filePath: string;
    reason: string;
    confidence: number;
  }>;
  transitivelyAffected: Array<{
    filePath: string;
    depth: number;
    path: string[];
  }>;
  affectedTests: Array<{
    filePath: string;
    testedFiles: string[];
  }>;
  tokenSavings: {
    beforeTokens: number;
    afterTokens: number;
    reductionRatio: number;
  };
}

export interface OptimizedContext {
  essentialFiles: string[];
  suggestedFiles: string[];
  excludedFiles: string[];
  reasoning: string;
  estimatedTokens: number;
}

export interface GraphIndexState {
  projectId: string;
  lastIndexedAt: number;
  lastCommitSha?: string;
  nodeCount: number;
  edgeCount: number;
  staleEdgeCount?: number;
  indexVersion: number;
  languages: string[];
}

export interface LanguageConfig {
  extensions: string[];
  parserName: string;
  queries: {
    classes?: string;
    functions?: string;
    imports?: string;
    exports?: string;
  };
}

export interface IndexOptions {
  projectId: string;
  projectRoot: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  languages?: string[];
  maxConcurrency?: number;
  incremental?: boolean;
}

export interface BlastRadiusOptions {
  maxDepth?: number;
  includeTests?: boolean;
  confidenceThreshold?: number;
}

export interface ContextOptimizationOptions {
  maxFiles?: number;
  maxTokens?: number;
  prioritizeTests?: boolean;
  includeTransitive?: boolean;
}

export interface ImpactResult {
  target: {
    nodeId: string;
    label: string;
    filePath: string;
  };
  directDependents: Array<{
    nodeId: string;
    label: string;
    filePath: string;
    edgeType: string;
  }>;
  transitiveDependents: Array<{
    nodeId: string;
    label: string;
    filePath: string;
    depth: number;
  }>;
  affectedTests: Array<{
    filePath: string;
    testName?: string;
  }>;
  affectedMemories: Array<{
    memoryId: string;
    type: string;
    content: string;
  }>;
}

export interface CodeGraphQueryAdapter {
  getNode(nodeId: string): Promise<CodeGraphNode | null>;
  getNodesByFile(projectId: string, filePath: string): Promise<CodeGraphNode[]>;
  getNodesByType(projectId: string, type: GraphNodeType): Promise<CodeGraphNode[]>;
  getEdgesFrom(nodeId: string, type?: GraphEdgeType): Promise<CodeGraphEdge[]>;
  getEdgesTo(nodeId: string, type?: GraphEdgeType): Promise<CodeGraphEdge[]>;
  getAncestors(nodeId: string, maxDepth?: number): Promise<Array<{ ancestorId: string; depth: number }>>;
}

export interface ImpactAnalysisAdapter {
  analyzeImpact(target: string, projectId: string, maxDepth: number): Promise<ImpactResult>;
}
