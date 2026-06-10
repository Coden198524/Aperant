import type {
  BlastRadiusOptions,
  BlastRadiusResult,
  CodeGraphNode,
  CodeGraphQueryAdapter,
  ContextOptimizationOptions,
  OptimizedContext,
} from './types.js';

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_TOKENS = 50000;
const AVERAGE_LINES_PER_FILE = 200;
const AVERAGE_TOKENS_PER_LINE = 4;

export class BlastRadiusAnalyzer {
  constructor(private db: CodeGraphQueryAdapter) {}

  async analyze(
    projectId: string,
    changedFiles: string[],
    options: BlastRadiusOptions = {}
  ): Promise<BlastRadiusResult> {
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const includeTests = options.includeTests ?? true;
    const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

    const changedNodes = await this.getNodesInFiles(projectId, changedFiles);
    const changedNodeIds = new Set(changedNodes.map((node) => node.id));

    const directlyAffected = await this.findDirectlyAffected(changedNodeIds, confidenceThreshold);
    const transitivelyAffected = await this.findTransitivelyAffected(changedNodeIds, maxDepth);
    const affectedTests = includeTests
      ? await this.findAffectedTests(projectId, changedFiles, directlyAffected, transitivelyAffected)
      : [];

    const allAffectedFiles = new Set([
      ...changedFiles,
      ...directlyAffected.map((file) => file.filePath),
      ...transitivelyAffected.map((file) => file.filePath),
      ...affectedTests.map((test) => test.filePath),
    ]);

    return {
      changedFiles,
      directlyAffected,
      transitivelyAffected,
      affectedTests,
      tokenSavings: estimateCodeGraphTokenSavings(changedFiles.length, allAffectedFiles.size),
    };
  }

  private async getNodesInFiles(projectId: string, filePaths: string[]): Promise<CodeGraphNode[]> {
    const nodes: CodeGraphNode[] = [];
    for (const filePath of filePaths) {
      nodes.push(...await this.db.getNodesByFile(projectId, filePath));
    }
    return nodes;
  }

  private async findDirectlyAffected(
    changedNodeIds: Set<string>,
    confidenceThreshold: number
  ): Promise<Array<{ filePath: string; reason: string; confidence: number }>> {
    const affectedMap = new Map<string, { reason: string; confidence: number }>();

    for (const nodeId of changedNodeIds) {
      const incomingEdges = await this.db.getEdgesTo(nodeId);

      for (const edge of incomingEdges) {
        const sourceNode = await this.db.getNode(edge.fromId);
        if (!sourceNode || changedNodeIds.has(sourceNode.id) || edge.weight < confidenceThreshold) {
          continue;
        }

        const reason = getIncomingEdgeReason(edge.type);
        const existing = affectedMap.get(sourceNode.filePath);
        if (!existing || edge.weight > existing.confidence) {
          affectedMap.set(sourceNode.filePath, { reason, confidence: edge.weight });
        }
      }
    }

    return Array.from(affectedMap.entries()).map(([filePath, { reason, confidence }]) => ({
      filePath,
      reason,
      confidence,
    }));
  }

  private async findTransitivelyAffected(
    changedNodeIds: Set<string>,
    maxDepth: number
  ): Promise<Array<{ filePath: string; depth: number; path: string[] }>> {
    const affectedMap = new Map<string, { depth: number; path: string[] }>();

    for (const nodeId of changedNodeIds) {
      const ancestors = await this.db.getAncestors(nodeId, maxDepth);

      for (const { ancestorId, depth } of ancestors) {
        if (depth <= 1 || changedNodeIds.has(ancestorId)) {
          continue;
        }

        const ancestorNode = await this.db.getNode(ancestorId);
        if (!ancestorNode) {
          continue;
        }

        const existing = affectedMap.get(ancestorNode.filePath);
        if (!existing || depth < existing.depth) {
          affectedMap.set(ancestorNode.filePath, { depth, path: [] });
        }
      }
    }

    return Array.from(affectedMap.entries()).map(([filePath, { depth, path }]) => ({
      filePath,
      depth,
      path,
    }));
  }

  private async findAffectedTests(
    projectId: string,
    changedFiles: string[],
    directlyAffected: Array<{ filePath: string }>,
    transitivelyAffected: Array<{ filePath: string }>
  ): Promise<Array<{ filePath: string; testedFiles: string[] }>> {
    const testNodes = await this.db.getNodesByType(projectId, 'test');
    const affectedTests: Array<{ filePath: string; testedFiles: string[] }> = [];
    const allAffectedFiles = new Set([
      ...changedFiles,
      ...directlyAffected.map((file) => file.filePath),
      ...transitivelyAffected.map((file) => file.filePath),
    ]);

    for (const testNode of testNodes) {
      const testEdges = await this.db.getEdgesFrom(testNode.id, 'tests');
      const testedFiles: string[] = [];

      for (const edge of testEdges) {
        const testedNode = await this.db.getNode(edge.toId);
        if (testedNode && allAffectedFiles.has(testedNode.filePath)) {
          testedFiles.push(testedNode.filePath);
        }
      }

      if (testedFiles.length > 0) {
        affectedTests.push({ filePath: testNode.filePath, testedFiles });
      }
    }

    return affectedTests;
  }
}

export class ContextOptimizer {
  private blastRadiusAnalyzer: BlastRadiusAnalyzer;

  constructor(private db: CodeGraphQueryAdapter) {
    this.blastRadiusAnalyzer = new BlastRadiusAnalyzer(db);
  }

  async optimizeContext(
    projectId: string,
    changedFiles: string[],
    options: ContextOptimizationOptions = {}
  ): Promise<OptimizedContext> {
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const prioritizeTests = options.prioritizeTests ?? true;
    const includeTransitive = options.includeTransitive ?? true;

    const blastRadius = await this.blastRadiusAnalyzer.analyze(projectId, changedFiles, {
      maxDepth: includeTransitive ? 3 : 1,
      includeTests: prioritizeTests,
    });

    const essentialFiles = new Set([
      ...changedFiles,
      ...blastRadius.directlyAffected.map((file) => file.filePath),
    ]);

    if (prioritizeTests) {
      for (const test of blastRadius.affectedTests) {
        essentialFiles.add(test.filePath);
      }
    }

    const suggestedFiles = includeTransitive
      ? blastRadius.transitivelyAffected
        .map((file) => file.filePath)
        .filter((filePath) => !essentialFiles.has(filePath))
      : [];

    const { finalEssential, finalSuggested, excluded } = applyCodeGraphBudgetConstraints(
      [...essentialFiles],
      suggestedFiles,
      maxFiles,
      maxTokens
    );

    return {
      essentialFiles: finalEssential,
      suggestedFiles: finalSuggested,
      excludedFiles: excluded,
      reasoning: buildCodeGraphContextReasoning(
        changedFiles.length,
        finalEssential.length,
        finalSuggested.length,
        excluded.length,
        blastRadius.tokenSavings.reductionRatio
      ),
      estimatedTokens: estimateCodeGraphTokens(finalEssential.length + finalSuggested.length),
    };
  }

  async getSuggestedFiles(
    projectId: string,
    filePath: string,
    options: { maxSuggestions?: number; maxDepth?: number } = {}
  ): Promise<Array<{ filePath: string; reason: string }>> {
    const maxSuggestions = options.maxSuggestions ?? 3;
    const nodes = await this.db.getNodesByFile(projectId, filePath);
    if (nodes.length === 0) {
      return [];
    }

    const suggestions = new Map<string, string>();
    for (const node of nodes) {
      const outgoingEdges = await this.db.getEdgesFrom(node.id);

      for (const edge of outgoingEdges) {
        const targetNode = await this.db.getNode(edge.toId);
        if (!targetNode || targetNode.filePath === filePath) {
          continue;
        }

        if (!suggestions.has(targetNode.filePath)) {
          suggestions.set(targetNode.filePath, getOutgoingEdgeReason(edge.type));
        }

        if (suggestions.size >= maxSuggestions) {
          break;
        }
      }

      if (suggestions.size >= maxSuggestions) {
        break;
      }
    }

    return [...suggestions.entries()]
      .slice(0, maxSuggestions)
      .map(([suggestedFilePath, reason]) => ({ filePath: suggestedFilePath, reason }));
  }
}

export function estimateCodeGraphTokens(fileCount: number): number {
  return fileCount * AVERAGE_LINES_PER_FILE * AVERAGE_TOKENS_PER_LINE;
}

export function estimateCodeGraphTokenSavings(
  changedFileCount: number,
  affectedFileCount: number
): { beforeTokens: number; afterTokens: number; reductionRatio: number } {
  const beforeTokens = changedFileCount * 2 * AVERAGE_LINES_PER_FILE * AVERAGE_TOKENS_PER_LINE;
  const afterTokens = affectedFileCount * AVERAGE_LINES_PER_FILE * AVERAGE_TOKENS_PER_LINE;

  return {
    beforeTokens,
    afterTokens,
    reductionRatio: beforeTokens > 0 ? afterTokens / beforeTokens : 1,
  };
}

export function applyCodeGraphBudgetConstraints(
  essentialFiles: string[],
  suggestedFiles: string[],
  maxFiles: number,
  maxTokens: number
): { finalEssential: string[]; finalSuggested: string[]; excluded: string[] } {
  const excluded: string[] = [];

  let finalEssential = essentialFiles;
  if (finalEssential.length > maxFiles) {
    excluded.push(...finalEssential.slice(maxFiles));
    finalEssential = finalEssential.slice(0, maxFiles);
  }

  const remainingFiles = maxFiles - finalEssential.length;
  const remainingTokens = maxTokens - estimateCodeGraphTokens(finalEssential.length);
  const maxSuggestedFiles = Math.min(
    remainingFiles,
    Math.floor(remainingTokens / (AVERAGE_LINES_PER_FILE * AVERAGE_TOKENS_PER_LINE))
  );

  const finalSuggested = suggestedFiles.slice(0, maxSuggestedFiles);
  excluded.push(...suggestedFiles.slice(maxSuggestedFiles));

  return { finalEssential, finalSuggested, excluded };
}

export function buildCodeGraphContextReasoning(
  changedCount: number,
  essentialCount: number,
  suggestedCount: number,
  excludedCount: number,
  reductionRatio: number
): string {
  const parts: string[] = [];

  parts.push(`Analyzed ${changedCount} changed file${changedCount !== 1 ? 's' : ''}.`);
  parts.push(`Selected ${essentialCount} essential file${essentialCount !== 1 ? 's' : ''} (changed + direct dependencies + tests).`);

  if (suggestedCount > 0) {
    parts.push(`Included ${suggestedCount} suggested file${suggestedCount !== 1 ? 's' : ''} (transitive dependencies).`);
  }

  if (excludedCount > 0) {
    parts.push(`Excluded ${excludedCount} file${excludedCount !== 1 ? 's' : ''} (proven irrelevant via graph analysis).`);
  }

  parts.push(`Estimated token savings: ${((1 - reductionRatio) * 100).toFixed(1)}%.`);
  return parts.join(' ');
}

function getIncomingEdgeReason(edgeType: string): string {
  switch (edgeType) {
    case 'calls':
      return 'calls changed function';
    case 'imports':
      return 'imports changed file';
    case 'inherits':
    case 'extends':
      return 'inherits from changed class';
    case 'implements':
      return 'implements changed interface';
    case 'references':
      return 'references changed code';
    default:
      return 'depends on changed code';
  }
}

function getOutgoingEdgeReason(edgeType: string): string {
  switch (edgeType) {
    case 'calls':
      return 'calls functions in this file';
    case 'imports':
      return 'imports from this file';
    case 'inherits':
    case 'extends':
      return 'inherits from classes in this file';
    case 'implements':
      return 'implements interfaces in this file';
    case 'references':
      return 'references code in this file';
    default:
      return 'depends on this file';
  }
}
