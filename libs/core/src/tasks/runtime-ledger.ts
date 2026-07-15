import { createHash } from 'node:crypto';

export const AUTOCODE_RUNTIME_LEDGER_SCHEMA = 'autocode-runtime-ledger/v1';

export interface AutocodeRuntimeDefinitionFingerprintInput {
  id: string;
  title: string;
  description: string;
  filesToCreate: string[];
  filesToModify: string[];
  patternFiles: string[];
  dependsOn: string[];
  requirements: string[];
  designRefs: string[];
  designFingerprint?: string;
  architecture?: string;
  evidence?: string;
  verification?: unknown;
}

export const AUTOCODE_RUNTIME_LEDGER_DYNAMIC_SUBTASK_FIELDS = [
  'completion_summary',
  'notes',
  'completed_at',
  'started_at',
  'active_started_at',
  'updated_at',
  'duration_ms',
  'retry_count',
  'attempt_count',
  'failure_reason',
  'blocked_reason',
  'git_commit',
  'git_commit_skipped',
  'changed_files',
  'work_package',
  'history_only',
  'upstream_task_ids',
  'upstream_source',
  'depends_on',
  'definition_fingerprint',
  'source_task_fingerprints',
] as const;

export const AUTOCODE_RUNTIME_TASK_DEFINITION_FIELDS = [
  'title',
  'description',
  'files',
  'files_to_create',
  'files_to_modify',
  'pattern_files',
  'requirements',
  'design_refs',
  'design_fingerprint',
  'design_task_fingerprints',
  'architecture',
  'evidence',
  'verification',
  'service',
] as const;

export function isAutocodeSlimRuntimeLedger(plan: Record<string, unknown>): boolean {
  if (plan.runtimeLedgerSchema === AUTOCODE_RUNTIME_LEDGER_SCHEMA) {
    return true;
  }
  const sourceTask = asRecord(plan.source_task);
  return sourceTask?.runtime_ledger_schema === AUTOCODE_RUNTIME_LEDGER_SCHEMA;
}

export function buildAutocodeRuntimeDefinitionFingerprint(
  tasks: AutocodeRuntimeDefinitionFingerprintInput[],
): string {
  const canonicalTasks = tasks
    .map((task) => ({
      id: singleLine(task.id),
      title: normalizeText(task.title),
      description: normalizeText(task.description),
      filesToCreate: normalizeList(task.filesToCreate),
      filesToModify: normalizeList(task.filesToModify),
      patternFiles: normalizeList(task.patternFiles),
      dependsOn: normalizeList(task.dependsOn),
      requirements: normalizeList(task.requirements),
      designRefs: normalizeList(task.designRefs.map((value) => value.toUpperCase())),
      designFingerprint: singleLine(task.designFingerprint ?? ''),
      architecture: normalizeText(task.architecture ?? ''),
      evidence: normalizeText(task.evidence ?? ''),
      verification: stableValue(task.verification),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return createHash('sha256')
    .update(JSON.stringify(canonicalTasks), 'utf8')
    .digest('hex');
}

function normalizeList(values: string[]): string[] {
  return Array.from(new Set(values.map(singleLine).filter(Boolean))).sort();
}

function normalizeText(value: string): string {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function singleLine(value: string): string {
  return normalizeText(value).replace(/\s+/g, ' ');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  const record = asRecord(value);
  if (record) {
    return Object.fromEntries(
      Object.entries(record)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
