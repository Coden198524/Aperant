import type { SessionResult } from '../session/types';

export interface WorkItemInfo {
  id: string;
  phaseId?: string;
  phaseName?: string;
  description: string;
  filesToCreate?: string[];
  filesToModify?: string[];
  patternFiles?: string[];
  verification?: string;
  workPackage?: boolean;
  upstreamTaskIds?: string[];
  upstreamSource?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'stuck';
}

export interface WorkProgress {
  completed: string[];
  inProgress: string[];
  blocked: string[];
  notStarted: string[];
}

export interface WorkItemResult {
  completed: string[];
  failed: string[];
  blocked: string[];
  sessionResult: SessionResult;
}

export interface WorkExecutorResult {
  success: boolean;
  totalCompleted: number;
  totalFailed?: number;
  cancelled?: boolean;
  error?: string;
}

export interface ConflictGraph {
  independent: WorkItemInfo[][];
  sequential: WorkItemInfo[];
}
