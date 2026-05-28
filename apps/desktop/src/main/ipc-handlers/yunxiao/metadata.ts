import type { TaskMetadata } from '../../../shared/types';

interface YunxiaoTaskMetadataInput {
  workItemId: string;
  identifier: string;
  url?: string;
  workitemTypeName?: string;
  workitemCategoryId?: string;
  workitemCategoryName?: string;
}

export interface YunxiaoTaskMetadata {
  [key: string]: unknown;
  sourceType: 'yunxiao';
  yunxiaoWorkItemId: string;
  yunxiaoIdentifier: string;
  yunxiaoUrl?: string;
  category: NonNullable<TaskMetadata['category']>;
  requireReviewBeforeCoding: true;
}

function looksLikeBugCategory(value?: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('bug')
    || normalized.includes('defect')
    || normalized.includes('issue')
    || normalized.includes('缺陷')
    || normalized.includes('问题')
    || normalized.includes('故障');
}

/**
 * Build task metadata for Yunxiao imported tasks.
 * Imported tasks should default to requiring manual review before coding starts.
 */
export function buildYunxiaoTaskMetadata(input: YunxiaoTaskMetadataInput): YunxiaoTaskMetadata {
  const isBugLike = looksLikeBugCategory(input.workitemTypeName)
    || looksLikeBugCategory(input.workitemCategoryId)
    || looksLikeBugCategory(input.workitemCategoryName);

  return {
    sourceType: 'yunxiao',
    yunxiaoWorkItemId: input.workItemId,
    yunxiaoIdentifier: input.identifier,
    yunxiaoUrl: input.url || undefined,
    category: isBugLike ? 'bug_fix' : 'feature',
    requireReviewBeforeCoding: true
  };
}
