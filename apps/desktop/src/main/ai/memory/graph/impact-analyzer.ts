import {
  analyzeAutocodeImpact,
  formatAutocodeImpactResult,
} from '@autocode/core/graph/impact';
import type { ImpactResult } from '../types';
import type { GraphDatabase } from './graph-database';

export type { ImpactResult };

export async function analyzeImpact(
  target: string,
  projectId: string,
  graphDb: GraphDatabase,
  maxDepth: number = 3
): Promise<ImpactResult> {
  return analyzeAutocodeImpact(target, projectId, graphDb, maxDepth) as Promise<ImpactResult>;
}

export function formatImpactResult(result: ImpactResult): string {
  return formatAutocodeImpactResult(result);
}
