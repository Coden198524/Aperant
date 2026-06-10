import type { ImpactAnalysisAdapter, ImpactResult } from './types.js';

export type { ImpactResult };

export async function analyzeAutocodeImpact(
  target: string,
  projectId: string,
  graphDb: ImpactAnalysisAdapter,
  maxDepth: number = 3
): Promise<ImpactResult> {
  const cappedDepth = Math.min(maxDepth, 5);
  return graphDb.analyzeImpact(target, projectId, cappedDepth);
}

export function formatAutocodeImpactResult(result: ImpactResult): string {
  if (!result.target.nodeId) {
    return `No node found for target: "${result.target.label}"`;
  }

  const lines: string[] = [
    `Impact Analysis: ${result.target.label}`,
    `File: ${result.target.filePath || '(external)'}`,
    '',
  ];

  if (result.directDependents.length > 0) {
    lines.push(`Direct dependents (${result.directDependents.length}):`);
    for (const dep of result.directDependents) {
      lines.push(`  - ${dep.label} [${dep.edgeType}] in ${dep.filePath}`);
    }
    lines.push('');
  }

  if (result.transitiveDependents.length > 0) {
    lines.push(`Transitive dependents (${result.transitiveDependents.length}):`);
    for (const dep of result.transitiveDependents.slice(0, 20)) {
      lines.push(`  - [depth=${dep.depth}] ${dep.label} in ${dep.filePath}`);
    }
    if (result.transitiveDependents.length > 20) {
      lines.push(`  ... and ${result.transitiveDependents.length - 20} more`);
    }
    lines.push('');
  }

  if (result.affectedTests.length > 0) {
    lines.push(`Affected test files (${result.affectedTests.length}):`);
    for (const test of result.affectedTests) {
      lines.push(`  - ${test.filePath}`);
    }
    lines.push('');
  }

  if (result.affectedMemories.length > 0) {
    lines.push(`Related memories (${result.affectedMemories.length}):`);
    for (const memory of result.affectedMemories) {
      lines.push(`  - [${memory.type}] ${memory.content.slice(0, 100)}${memory.content.length > 100 ? '...' : ''}`);
    }
  }

  if (
    result.directDependents.length === 0 &&
    result.transitiveDependents.length === 0 &&
    result.affectedTests.length === 0
  ) {
    lines.push('No dependents found. This symbol appears to be a leaf node.');
  }

  return lines.join('\n');
}
