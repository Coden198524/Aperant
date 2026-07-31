import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import {
  basename,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import { TextDecoder } from 'node:util';

import type {
  OpenSpecPlanningFileChange,
  OpenSpecPlanningReview,
  OpenSpecPlanningReviewSummary,
  Project,
  Task,
} from '../../shared/types';
import { writeFileAtomicSync } from '../utils/atomic-file';
import type { OpenSpecRuntimeStore } from './openspec-runtime-store';

const REVIEW_DIRECTORY = 'openspec-planning-reviews';
const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILE_COUNT = 10_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_REVIEW_RECORD_BYTES = 256 * 1024 * 1024;
const MAX_SUMMARY_RECORD_BYTES = 64 * 1024;

interface PlanningRoot {
  label: string;
  path: string;
}

interface PlanningFileSnapshot {
  relativePath: string;
  content: string;
}

interface PlanningReviewRecord {
  formatVersion: 1;
  runId: string;
  action: 'update';
  state: 'capturing' | 'ready' | 'error';
  createdAt: string;
  completedAt?: string;
  acknowledgedAt?: string;
  roots: PlanningRoot[];
  baseline?: PlanningFileSnapshot[];
  changes: OpenSpecPlanningFileChange[];
  error?: string;
}

interface PlanningReviewSummaryRecord extends OpenSpecPlanningReviewSummary {
  formatVersion: 1;
  acknowledgedAt?: string;
}

function requireRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error('Invalid OpenSpec planning review run ID.');
  }
  return runId;
}

function planningReviewPatch(
  relativePath: string,
  before: string,
  after: string,
): string {
  const normalizedBefore = before.replace(/\r\n?/g, '\n');
  const normalizedAfter = after.replace(/\r\n?/g, '\n');
  const beforeLines = normalizedBefore ? normalizedBefore.split('\n') : [];
  const afterLines = normalizedAfter ? normalizedAfter.split('\n') : [];
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n');
}

function buildPlanningChanges(
  before: readonly PlanningFileSnapshot[],
  after: readonly PlanningFileSnapshot[],
): OpenSpecPlanningFileChange[] {
  const beforeByPath = new Map(
    before.map((document) => [document.relativePath, document]),
  );
  const afterByPath = new Map(
    after.map((document) => [document.relativePath, document]),
  );
  const changes: OpenSpecPlanningFileChange[] = [];

  for (const document of after) {
    const previous = beforeByPath.get(document.relativePath);
    if (!previous) {
      changes.push({
        relativePath: document.relativePath,
        kind: 'created',
        patch: planningReviewPatch(document.relativePath, '', document.content),
      });
    } else if (
      previous.content.replace(/\r\n?/g, '\n') !==
      document.content.replace(/\r\n?/g, '\n')
    ) {
      changes.push({
        relativePath: document.relativePath,
        kind: 'modified',
        patch: planningReviewPatch(
          document.relativePath,
          previous.content,
          document.content,
        ),
      });
    }
  }

  for (const document of before) {
    if (!afterByPath.has(document.relativePath)) {
      changes.push({
        relativePath: document.relativePath,
        kind: 'deleted',
        patch: planningReviewPatch(document.relativePath, document.content, ''),
      });
    }
  }

  return changes.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function normalizePlanningRoots(paths: readonly string[]): PlanningRoot[] {
  if (paths.some((path) => !isAbsolute(path) || path.includes('\0'))) {
    throw new Error('OpenSpec planning review received an invalid write root.');
  }
  const uniquePaths = [...new Set(paths.map((path) => resolve(path)))];
  const labelCounts = new Map<string, number>();
  return uniquePaths.map((path) => {
    const baseLabel = basename(path).replace(/\\/g, '/') || 'planning';
    const count = (labelCounts.get(baseLabel) ?? 0) + 1;
    labelCounts.set(baseLabel, count);
    return {
      label: count === 1 ? baseLabel : `${baseLabel}-${count}`,
      path,
    };
  });
}

function samePlanningRoots(
  left: readonly PlanningRoot[],
  right: readonly PlanningRoot[],
): boolean {
  if (left.length !== right.length) return false;
  const labelByPath = new Map(
    right.map((root) => [resolve(root.path), root.label]),
  );
  return left.every(
    (root) => labelByPath.get(resolve(root.path)) === root.label,
  );
}

function capturePlanningFiles(roots: readonly PlanningRoot[]): PlanningFileSnapshot[] {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const documents: PlanningFileSnapshot[] = [];
  let totalBytes = 0;

  const visit = (
    root: PlanningRoot,
    directory: string,
    relativeSegments: string[],
  ): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        entry.name.includes('\0') ||
        entry.name.includes('/') ||
        entry.name.includes('\\')
      ) {
        throw new Error(
          `OpenSpec planning review encountered an unsafe file name below ${root.label}.`,
        );
      }
      const absolutePath = join(directory, entry.name);
      const nextSegments = [...relativeSegments, entry.name];
      const stats = lstatSync(absolutePath);
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
        throw new Error(
          `OpenSpec planning review cannot follow symbolic links: ${root.label}/${nextSegments.join('/')}`,
        );
      }
      if (entry.isDirectory() && stats.isDirectory()) {
        visit(root, absolutePath, nextSegments);
        continue;
      }
      if (!entry.isFile() || !stats.isFile()) {
        throw new Error(
          `OpenSpec planning review encountered an unsupported filesystem entry: ${root.label}/${nextSegments.join('/')}`,
        );
      }
      if (stats.size > MAX_FILE_BYTES) {
        throw new Error(
          `OpenSpec planning document exceeds the ${MAX_FILE_BYTES} byte review limit: ${root.label}/${nextSegments.join('/')}`,
        );
      }
      const buffer = readFileSync(absolutePath);
      if (buffer.length !== stats.size) {
        throw new Error(
          `OpenSpec planning document changed while its review snapshot was being captured: ${root.label}/${nextSegments.join('/')}`,
        );
      }
      totalBytes += buffer.length;
      if (totalBytes > MAX_SNAPSHOT_BYTES) {
        throw new Error(
          `OpenSpec planning documents exceed the ${MAX_SNAPSHOT_BYTES} byte review limit.`,
        );
      }
      if (documents.length >= MAX_FILE_COUNT) {
        throw new Error(
          `OpenSpec planning documents exceed the ${MAX_FILE_COUNT} file review limit.`,
        );
      }
      let content: string;
      try {
        content = decoder.decode(buffer);
      } catch {
        throw new Error(
          `OpenSpec planning review only supports UTF-8 text documents: ${root.label}/${nextSegments.join('/')}`,
        );
      }
      if (content.includes('\0')) {
        throw new Error(
          `OpenSpec planning review cannot display binary content: ${root.label}/${nextSegments.join('/')}`,
        );
      }
      documents.push({
        relativePath: `${root.label}/${nextSegments.join('/')}`,
        content,
      });
    }
  };

  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    const stats = lstatSync(root.path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `OpenSpec planning review root is not a trusted directory: ${root.label}`,
      );
    }
    visit(root, root.path, []);
  }
  return documents.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function publicReview(record: PlanningReviewRecord): OpenSpecPlanningReview | null {
  if (
    (record.state !== 'ready' && record.state !== 'error') ||
    !record.completedAt
  ) {
    return null;
  }
  return {
    runId: record.runId,
    state: record.state,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    changes: record.changes,
    ...(record.error ? { error: record.error } : {}),
  };
}

export function summarizeOpenSpecPlanningReview(
  review: OpenSpecPlanningReview,
): OpenSpecPlanningReviewSummary {
  return {
    runId: review.runId,
    state: review.state,
    createdAt: review.createdAt,
    completedAt: review.completedAt,
    changeCount: review.changes.length,
    ...(review.error ? { error: review.error } : {}),
  };
}

export class OpenSpecPlanningReviewStore {
  constructor(private readonly runtimeStore: OpenSpecRuntimeStore) {}

  private reviewDirectory(task: Task, project: Project): string {
    return join(this.runtimeStore.getSpecDir(task, project), REVIEW_DIRECTORY);
  }

  private reviewPath(task: Task, project: Project, runId: string): string {
    return join(this.reviewDirectory(task, project), `${requireRunId(runId)}.json`);
  }

  private summaryPath(task: Task, project: Project, runId: string): string {
    return join(
      this.reviewDirectory(task, project),
      `${requireRunId(runId)}.summary.json`,
    );
  }

  private writeRecord(
    task: Task,
    project: Project,
    record: PlanningReviewRecord,
  ): void {
    const directory = this.reviewDirectory(task, project);
    mkdirSync(directory, { recursive: true });
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REVIEW_RECORD_BYTES) {
      throw new Error(
        `OpenSpec planning review exceeds the ${MAX_REVIEW_RECORD_BYTES} byte persistence limit.`,
      );
    }
    writeFileAtomicSync(
      this.reviewPath(task, project, record.runId),
      serialized,
    );
  }

  private writeSummaryRecord(
    task: Task,
    project: Project,
    record: PlanningReviewSummaryRecord,
  ): void {
    const directory = this.reviewDirectory(task, project);
    mkdirSync(directory, { recursive: true });
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SUMMARY_RECORD_BYTES) {
      throw new Error('OpenSpec planning review summary is too large.');
    }
    writeFileAtomicSync(
      this.summaryPath(task, project, record.runId),
      serialized,
    );
  }

  private readSummaryRecord(
    task: Task,
    project: Project,
    runId: string,
  ): PlanningReviewSummaryRecord | null {
    const path = this.summaryPath(task, project, runId);
    if (!existsSync(path)) return null;
    const stats = lstatSync(path);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.size > MAX_SUMMARY_RECORD_BYTES
    ) {
      throw new Error('OpenSpec planning review summary is invalid or too large.');
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error('OpenSpec planning review summary could not be read.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('OpenSpec planning review summary is malformed.');
    }
    const summary = value as PlanningReviewSummaryRecord;
    if (
      summary.formatVersion !== 1 ||
      summary.runId !== runId ||
      (summary.state !== 'ready' && summary.state !== 'error') ||
      typeof summary.createdAt !== 'string' ||
      typeof summary.completedAt !== 'string' ||
      !Number.isSafeInteger(summary.changeCount) ||
      summary.changeCount < 0 ||
      (summary.error !== undefined && typeof summary.error !== 'string') ||
      (
        summary.acknowledgedAt !== undefined &&
        typeof summary.acknowledgedAt !== 'string'
      )
    ) {
      throw new Error('OpenSpec planning review summary is malformed.');
    }
    return summary;
  }

  private readRecord(
    task: Task,
    project: Project,
    runId: string,
  ): PlanningReviewRecord | null {
    const path = this.reviewPath(task, project, runId);
    if (!existsSync(path)) return null;
    const stats = lstatSync(path);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.size > MAX_REVIEW_RECORD_BYTES
    ) {
      throw new Error('OpenSpec planning review record is invalid or too large.');
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error('OpenSpec planning review record could not be read.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('OpenSpec planning review record is malformed.');
    }
    const record = value as PlanningReviewRecord;
    if (
      record.formatVersion !== 1 ||
      record.runId !== runId ||
      record.action !== 'update' ||
      !['capturing', 'ready', 'error'].includes(record.state) ||
      !Array.isArray(record.roots) ||
      !record.roots.every((root) =>
        root &&
        typeof root.label === 'string' &&
        typeof root.path === 'string' &&
        isAbsolute(root.path)) ||
      (
        record.baseline !== undefined &&
        (
          !Array.isArray(record.baseline) ||
          !record.baseline.every((document) =>
            document &&
            typeof document.relativePath === 'string' &&
            typeof document.content === 'string')
        )
      ) ||
      !Array.isArray(record.changes) ||
      !record.changes.every((change) =>
        change &&
        typeof change.relativePath === 'string' &&
        ['created', 'modified', 'deleted'].includes(change.kind) &&
        typeof change.patch === 'string') ||
      (record.error !== undefined && typeof record.error !== 'string')
    ) {
      throw new Error('OpenSpec planning review record is malformed.');
    }
    return record;
  }

  begin(
    task: Task,
    project: Project,
    runId: string,
    allowedWritePaths: readonly string[],
    options: { inheritBaselineFromRunId?: string } = {},
  ): void {
    const roots = normalizePlanningRoots(allowedWritePaths);
    if (roots.length === 0) {
      throw new Error(
        'OpenSpec Update did not expose a planning write root for change review.',
      );
    }
    const inherited = options.inheritBaselineFromRunId
      ? this.takeInterruptedBaseline(
          task,
          project,
          options.inheritBaselineFromRunId,
          roots,
        )
      : null;
    const baseline = inherited ?? capturePlanningFiles(roots);
    this.writeRecord(task, project, {
      formatVersion: 1,
      runId: requireRunId(runId),
      action: 'update',
      state: 'capturing',
      createdAt: new Date().toISOString(),
      roots,
      baseline,
      changes: [],
    });
  }

  /**
   * An Update interrupted by an Aperant exit leaves its original baseline in a
   * `capturing` record. Resuming the same official Action must diff against
   * that original baseline, otherwise the review would only list the documents
   * touched after recovery and silently hide the earlier edits. Returns null
   * whenever the previous baseline cannot be trusted for the current roots, so
   * the caller falls back to a fresh capture instead of a wrong diff.
   */
  private takeInterruptedBaseline(
    task: Task,
    project: Project,
    previousRunId: string,
    roots: readonly PlanningRoot[],
  ): PlanningFileSnapshot[] | null {
    let previous: PlanningReviewRecord | null = null;
    try {
      previous = this.readRecord(task, project, previousRunId);
    } catch {
      return null;
    }
    if (
      !previous ||
      previous.state !== 'capturing' ||
      !previous.baseline ||
      !samePlanningRoots(previous.roots, roots)
    ) {
      return null;
    }
    const baseline = previous.baseline;
    this.discard(task, project, previousRunId);
    return baseline;
  }

  private assertRecordedRootsAllowed(
    record: PlanningReviewRecord,
    allowedWritePaths: readonly string[],
    requireExact: boolean,
  ): void {
    const allowedRoots = normalizePlanningRoots(allowedWritePaths);
    const allowedByPath = new Map(
      allowedRoots.map((root) => [resolve(root.path), root]),
    );
    for (const recordedRoot of record.roots) {
      const allowed = allowedByPath.get(resolve(recordedRoot.path));
      if (!allowed || allowed.label !== recordedRoot.label) {
        throw new Error(
          'OpenSpec planning roots changed after the Update Action; review capture was blocked.',
        );
      }
    }
    if (requireExact && allowedRoots.length !== record.roots.length) {
      throw new Error(
        'OpenSpec planning roots changed during the Update Action; review capture was blocked.',
      );
    }
  }

  complete(
    task: Task,
    project: Project,
    runId: string,
    allowedWritePaths: readonly string[],
  ): OpenSpecPlanningReview {
    const record = this.readRecord(task, project, runId);
    if (!record?.baseline) {
      throw new Error('OpenSpec planning review baseline is missing.');
    }
    this.assertRecordedRootsAllowed(record, allowedWritePaths, true);
    const completedAt = new Date().toISOString();
    try {
      const latest = capturePlanningFiles(record.roots);
      const ready: PlanningReviewRecord = {
        formatVersion: 1,
        runId: record.runId,
        action: 'update',
        state: 'ready',
        createdAt: record.createdAt,
        completedAt,
        roots: record.roots,
        changes: buildPlanningChanges(record.baseline, latest),
      };
      this.writeRecord(task, project, ready);
      const review = publicReview(ready) as OpenSpecPlanningReview;
      this.writeSummaryRecord(task, project, {
        formatVersion: 1,
        ...summarizeOpenSpecPlanningReview(review),
      });
      return review;
    } catch (error) {
      const failed: PlanningReviewRecord = {
        ...record,
        state: 'error',
        completedAt,
        changes: [],
        error: error instanceof Error ? error.message : String(error),
      };
      this.writeRecord(task, project, failed);
      const review = publicReview(failed) as OpenSpecPlanningReview;
      this.writeSummaryRecord(task, project, {
        formatVersion: 1,
        ...summarizeOpenSpecPlanningReview(review),
      });
      return review;
    }
  }

  fail(
    task: Task,
    project: Project,
    runId: string,
    error: unknown,
  ): OpenSpecPlanningReview {
    let existing: PlanningReviewRecord | null = null;
    try {
      existing = this.readRecord(task, project, runId);
    } catch {
      // Replace an unreadable internal record with a safe, renderer-visible
      // failure so the completed Update never loses its review requirement.
    }
    const completedAt = new Date().toISOString();
    const failed: PlanningReviewRecord = {
      formatVersion: 1,
      runId: requireRunId(runId),
      action: 'update',
      state: 'error',
      createdAt: existing?.createdAt ?? completedAt,
      completedAt,
      roots: existing?.roots ?? [],
      ...(existing?.baseline ? { baseline: existing.baseline } : {}),
      changes: [],
      error: error instanceof Error ? error.message : String(error),
    };
    this.writeRecord(task, project, failed);
    const review = publicReview(failed) as OpenSpecPlanningReview;
    this.writeSummaryRecord(task, project, {
      formatVersion: 1,
      ...summarizeOpenSpecPlanningReview(review),
    });
    return review;
  }

  retry(
    task: Task,
    project: Project,
    runId: string,
    allowedWritePaths: readonly string[],
  ): OpenSpecPlanningReview {
    const record = this.readRecord(task, project, runId);
    if (!record?.baseline || record.state !== 'error') {
      throw new Error('OpenSpec planning review is not available for retry.');
    }
    this.assertRecordedRootsAllowed(record, allowedWritePaths, false);
    return this.complete(
      task,
      project,
      runId,
      record.roots.map((root) => root.path),
    );
  }

  discard(task: Task, project: Project, runId: string): void {
    const path = this.reviewPath(task, project, runId);
    if (existsSync(path)) unlinkSync(path);
    const summaryPath = this.summaryPath(task, project, runId);
    if (existsSync(summaryPath)) unlinkSync(summaryPath);
  }

  read(
    task: Task,
    project: Project,
    runId: string,
  ): OpenSpecPlanningReview {
    const record = this.readRecord(task, project, runId);
    const review = record ? publicReview(record) : null;
    if (!review) {
      throw new Error('OpenSpec planning review is not ready.');
    }
    return review;
  }

  readPending(
    task: Task,
    project: Project,
  ): OpenSpecPlanningReviewSummary | null {
    const directory = this.reviewDirectory(task, project);
    if (!existsSync(directory)) return null;
    const runIds = new Set<string>();
    const summaryRunIds = new Set<string>();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.summary.json')) {
        const runId = entry.name.slice(0, -'.summary.json'.length);
        if (RUN_ID_PATTERN.test(runId)) {
          runIds.add(runId);
          summaryRunIds.add(runId);
        }
        continue;
      }
      if (entry.name.endsWith('.json')) {
        const runId = entry.name.slice(0, -'.json'.length);
        if (RUN_ID_PATTERN.test(runId)) runIds.add(runId);
      }
    }
    const pending: Array<{
      summary: PlanningReviewSummaryRecord;
    }> = [];
    for (const runId of runIds) {
      let summary: PlanningReviewSummaryRecord | null = null;
      let summaryError: unknown;
      try {
        summary = this.readSummaryRecord(task, project, runId);
      } catch (error) {
        summaryError = error;
      }
      if (!summary) {
        try {
          const record = this.readRecord(task, project, runId);
          const review = record ? publicReview(record) : null;
          if (review) {
            summary = {
              formatVersion: 1,
              ...summarizeOpenSpecPlanningReview(review),
            };
            this.writeSummaryRecord(task, project, summary);
          }
        } catch (error) {
          throw new Error(
            'An OpenSpec planning review index is damaged and could not be recovered.',
            { cause: error },
          );
        }
      }
      if (!summary && (summaryError || summaryRunIds.has(runId))) {
        throw new Error(
          'An OpenSpec planning review index is damaged and could not be recovered.',
          { cause: summaryError },
        );
      }
      if (summary && !summary.acknowledgedAt) {
        pending.push({ summary });
      }
    }
    pending.sort((left, right) =>
      left.summary.createdAt.localeCompare(right.summary.createdAt),
    );
    if (!pending[0]) return null;
    const { formatVersion: _formatVersion, acknowledgedAt: _acknowledgedAt, ...summary } =
      pending[0].summary;
    return summary;
  }

  acknowledge(
    task: Task,
    project: Project,
    runId: string,
  ): OpenSpecPlanningReviewSummary | null {
    const summary = this.readSummaryRecord(task, project, runId);
    if (!summary) {
      throw new Error('OpenSpec planning review is not ready to acknowledge.');
    }
    this.writeSummaryRecord(task, project, {
      ...summary,
      acknowledgedAt: summary.acknowledgedAt ?? new Date().toISOString(),
    });
    return this.readPending(task, project);
  }
}

export const __openSpecPlanningReviewStoreTestUtils = {
  buildPlanningChanges,
  capturePlanningFiles,
  normalizePlanningRoots,
  planningReviewPatch,
  samePlanningRoots,
};
