export const AUTOCODE_MEMORY_TYPES = [
  'gotcha',
  'decision',
  'preference',
  'pattern',
  'requirement',
  'error_pattern',
  'module_insight',
  'prefetch_pattern',
  'work_state',
  'causal_dependency',
  'task_calibration',
  'e2e_observation',
  'dead_end',
  'work_unit_outcome',
  'workflow_recipe',
  'context_cost',
] as const;

export const AUTOCODE_MEMORY_SOURCES = [
  'agent_explicit',
  'observer_inferred',
  'qa_auto',
  'mcp_auto',
  'commit_auto',
  'user_taught',
] as const;

export const AUTOCODE_MEMORY_SCOPES = [
  'global',
  'module',
  'work_unit',
  'session',
] as const;

export const AUTOCODE_MEMORY_PHASES = [
  'define',
  'implement',
  'validate',
  'refine',
  'explore',
  'reflect',
] as const;

export const AUTOCODE_SESSION_OUTCOMES = [
  'success',
  'failure',
  'abandoned',
  'partial',
] as const;

export const AUTOCODE_SESSION_TYPES = [
  'build',
  'insights',
  'roadmap',
  'terminal',
  'changelog',
  'spec_creation',
  'pr_review',
] as const;

export const AUTOCODE_OBSERVER_SIGNAL_TYPES = [
  'file_access',
  'co_access',
  'error_retry',
  'backtrack',
  'read_abandon',
  'repeated_grep',
  'tool_sequence',
  'time_anomaly',
  'self_correction',
  'external_reference',
  'glob_ignore',
  'import_chase',
  'test_order',
  'config_touch',
  'step_overrun',
  'parallel_conflict',
  'context_token_spike',
] as const;

export type AutocodeMemoryType = (typeof AUTOCODE_MEMORY_TYPES)[number];
export type AutocodeMemorySource = (typeof AUTOCODE_MEMORY_SOURCES)[number];
export type AutocodeMemoryScope = (typeof AUTOCODE_MEMORY_SCOPES)[number];
export type AutocodeUniversalPhase = (typeof AUTOCODE_MEMORY_PHASES)[number];
export type AutocodeSessionOutcome = (typeof AUTOCODE_SESSION_OUTCOMES)[number];
export type AutocodeSessionType = (typeof AUTOCODE_SESSION_TYPES)[number];
export type AutocodeObserverSignalType = (typeof AUTOCODE_OBSERVER_SIGNAL_TYPES)[number];

export type MemoryType = AutocodeMemoryType;
export type MemorySource = AutocodeMemorySource;
export type MemoryScope = AutocodeMemoryScope;
export type UniversalPhase = AutocodeUniversalPhase;
export type SessionOutcome = AutocodeSessionOutcome;
export type SessionType = AutocodeSessionType;
export type SignalType = AutocodeObserverSignalType;

export interface WorkUnitRef {
  methodology: string;
  hierarchy: string[];
  label: string;
}

export interface MemoryRelation {
  targetMemoryId?: string;
  targetFilePath?: string;
  relationType: 'required_with' | 'conflicts_with' | 'validates' | 'supersedes' | 'derived_from';
  confidence: number;
  autoExtracted: boolean;
}

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  confidence: number;
  tags: string[];
  relatedFiles: string[];
  relatedModules: string[];
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  workUnitRef?: WorkUnitRef;
  scope: MemoryScope;
  source: MemorySource;
  sessionId: string;
  commitSha?: string;
  provenanceSessionIds: string[];
  targetNodeId?: string;
  impactedNodeIds?: string[];
  relations?: MemoryRelation[];
  decayHalfLifeDays?: number;
  needsReview?: boolean;
  userVerified?: boolean;
  citationText?: string;
  pinned?: boolean;
  methodology?: string;
  chunkType?: 'function' | 'class' | 'module' | 'prose';
  chunkStartLine?: number;
  chunkEndLine?: number;
  contextPrefix?: string;
  embeddingModelId?: string;
  projectId: string;
  trustLevelScope?: string;
  deprecated?: boolean;
  deprecatedAt?: string;
  staleAt?: string;
}

export interface MemorySearchFilters {
  query?: string;
  types?: MemoryType[];
  sources?: MemorySource[];
  scope?: MemoryScope;
  relatedFiles?: string[];
  relatedModules?: string[];
  projectId?: string;
  phase?: UniversalPhase;
  minConfidence?: number;
  limit?: number;
  sort?: 'relevance' | 'recency' | 'confidence';
  excludeDeprecated?: boolean;
  filter?: (memory: Memory) => boolean;
}

export interface MemoryRecordEntry {
  type: MemoryType;
  content: string;
  confidence?: number;
  tags?: string[];
  relatedFiles?: string[];
  relatedModules?: string[];
  scope?: MemoryScope;
  source?: MemorySource;
  sessionId?: string;
  projectId: string;
  workUnitRef?: WorkUnitRef;
  methodology?: string;
  decayHalfLifeDays?: number;
  needsReview?: boolean;
  pinned?: boolean;
  citationText?: string;
  chunkType?: 'function' | 'class' | 'module' | 'prose';
  chunkStartLine?: number;
  chunkEndLine?: number;
  contextPrefix?: string;
  trustLevelScope?: string;
}

export interface MemoryCandidate {
  signalType: SignalType;
  proposedType: MemoryType;
  content: string;
  relatedFiles: string[];
  relatedModules: string[];
  confidence: number;
  priority: number;
  originatingStep: number;
  needsReview?: boolean;
  trustFlags?: {
    contaminated: boolean;
    contaminationSource: string;
  };
}

export interface AcuteCandidate {
  signalType: SignalType;
  rawData: unknown;
  priority: number;
  capturedAt: number;
  stepNumber: number;
}

export interface MemoryService {
  store(entry: MemoryRecordEntry): Promise<string>;
  search(filters: MemorySearchFilters): Promise<Memory[]>;
  searchByPattern(pattern: string): Promise<Memory | null>;
  insertUserTaught(content: string, projectId: string, tags: string[]): Promise<string>;
  searchWorkflowRecipe(taskDescription: string, opts?: { limit?: number }): Promise<Memory[]>;
  updateAccessCount(memoryId: string): Promise<void>;
  deprecateMemory(memoryId: string): Promise<void>;
  verifyMemory(memoryId: string): Promise<void>;
  pinMemory(memoryId: string, pinned: boolean): Promise<void>;
  deleteMemory(memoryId: string): Promise<void>;
}

export interface MemoryTypeDefinition {
  id: string;
  displayName: string;
  decayHalfLifeDays?: number;
}

export interface RelayTransition {
  from: string;
  to: string;
  filter?: { types: MemoryType[] };
}

export interface ExecutionContext {
  specNumber?: string;
  subtaskId?: string;
  phase?: string;
  methodology?: string;
}

export interface WorkUnitResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface MemoryMethodologyPlugin {
  id: string;
  displayName: string;
  mapPhase(methodologyPhase: string): UniversalPhase;
  resolveWorkUnitRef(context: ExecutionContext): WorkUnitRef;
  getRelayTransitions(): RelayTransition[];
  formatRelayContext(memories: Memory[], toStage: string): string;
  extractWorkState(sessionOutput: string): Promise<Record<string, unknown>>;
  formatWorkStateContext(state: Record<string, unknown>): string;
  customMemoryTypes?: MemoryTypeDefinition[];
  onWorkUnitComplete?(ctx: ExecutionContext, result: WorkUnitResult, svc: MemoryService): Promise<void>;
}

export const nativePlugin: MemoryMethodologyPlugin = {
  id: 'native',
  displayName: 'Autocode (Subtasks)',
  mapPhase: (phase: string): UniversalPhase => {
    const phaseMap: Record<string, UniversalPhase> = {
      planning: 'define',
      spec: 'define',
      coding: 'implement',
      qa_review: 'validate',
      qa_fix: 'refine',
      debugging: 'refine',
      insights: 'explore',
    };
    return phaseMap[phase] ?? 'explore';
  },
  resolveWorkUnitRef: (context: ExecutionContext): WorkUnitRef => ({
    methodology: 'native',
    hierarchy: [context.specNumber, context.subtaskId].filter((value): value is string => Boolean(value)),
    label: context.subtaskId
      ? `Spec ${context.specNumber} / Subtask ${context.subtaskId}`
      : `Spec ${context.specNumber}`,
  }),
  getRelayTransitions: (): RelayTransition[] => [
    { from: 'planner', to: 'coder' },
    { from: 'coder', to: 'qa_reviewer' },
    { from: 'qa_reviewer', to: 'qa_fixer', filter: { types: ['error_pattern', 'requirement'] } },
  ],
  formatRelayContext: (_memories: Memory[], _toStage: string): string => '',
  extractWorkState: async (_sessionOutput: string): Promise<Record<string, unknown>> => ({}),
  formatWorkStateContext: (_state: Record<string, unknown>): string => '',
};

export interface AutocodeMemorySystemStatus {
  enabled: boolean;
  available: boolean;
  database?: string;
  dbPath?: string;
  embeddingProvider?: string;
  reason?: string;
}

export interface AutocodeMemorySystemState {
  initialized: boolean;
  database?: string;
  episodeCount: number;
  lastSessionAt?: string;
  createdAt?: string;
  errorLog: Array<{ timestamp: string; error: string }>;
}

export interface AutocodeRendererMemory {
  id: string;
  type: MemoryType;
  content: string;
  confidence: number;
  tags: string[];
  relatedFiles: string[];
  relatedModules: string[];
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  scope: MemoryScope;
  source: MemorySource;
  needsReview?: boolean;
  userVerified?: boolean;
  citationText?: string;
  pinned?: boolean;
  methodology?: string;
  deprecated?: boolean;
  score?: number;
}

export type AutocodeMemoryEpisode = AutocodeRendererMemory;

export interface AutocodeContextSearchResult {
  content: string;
  score: number;
  type: string;
}

export interface AutocodeProjectContextData<TProjectIndex = unknown> {
  projectIndex: TProjectIndex | null;
  memoryStatus: AutocodeMemorySystemStatus | null;
  memoryState: AutocodeMemorySystemState | null;
  recentMemories: AutocodeRendererMemory[];
  isLoading: boolean;
  error?: string;
}

export function isAutocodeMemoryType(value: string): value is MemoryType {
  return (AUTOCODE_MEMORY_TYPES as readonly string[]).includes(value);
}

export function isAutocodeMemorySource(value: string): value is MemorySource {
  return (AUTOCODE_MEMORY_SOURCES as readonly string[]).includes(value);
}

export function isAutocodeMemoryScope(value: string): value is MemoryScope {
  return (AUTOCODE_MEMORY_SCOPES as readonly string[]).includes(value);
}

export function toAutocodeRendererMemory(memory: Memory): AutocodeRendererMemory {
  return {
    id: memory.id,
    type: memory.type,
    content: memory.content,
    confidence: memory.confidence,
    tags: memory.tags,
    relatedFiles: memory.relatedFiles,
    relatedModules: memory.relatedModules,
    createdAt: memory.createdAt,
    lastAccessedAt: memory.lastAccessedAt,
    accessCount: memory.accessCount,
    scope: memory.scope,
    source: memory.source,
    needsReview: memory.needsReview,
    userVerified: memory.userVerified,
    citationText: memory.citationText,
    pinned: memory.pinned,
    methodology: memory.methodology,
    deprecated: memory.deprecated,
  };
}

export function toAutocodeContextSearchResult(memory: Memory): AutocodeContextSearchResult {
  return {
    content: memory.content,
    score: memory.confidence,
    type: memory.type,
  };
}
