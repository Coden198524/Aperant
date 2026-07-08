import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import { CheckCircle2, Clock, XCircle, AlertCircle, ListChecks, FileCode, ChevronRight, ChevronsUpDown, Loader2, Trash2, ClipboardCheck, Hash, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn, calculateProgress } from '../../lib/utils';
import { resolveActiveSubtaskIndex } from '../../lib/subtask-progress';
import { deleteSubtask } from '../../stores/task-store';
import type { Task, TaskLogs as TaskLogsData } from '../../../shared/types';
import {
  TaskRuntimeLogs,
  shouldSplitConcurrentWorkPackageLogs,
  type TaskRuntimeLogFocusTarget,
  type TaskRuntimeLogScope,
  useTaskModelLogs,
} from './TaskRuntimeLogs';

interface TaskSubtasksProps {
  task: Task;
}

interface CompletionSummaryRow {
  label: string;
  content: string;
}

interface SummaryVisualData {
  points: string[];
  files: string[];
  commands: string[];
  metrics: Array<{ label: string; value: string }>;
  status: 'passed' | 'failed' | 'warning' | 'neutral';
}

type TranslationFn = ReturnType<typeof useTranslation>['t'];

interface TaskSubtasksLayoutPreferences {
  subtasksWidthPercent: number;
  graphHeightPercent: number;
}

type TaskSubtasksResizeTarget = 'subtasks' | 'graph' | null;

const TASK_SUBTASKS_LAYOUT_STORAGE_KEY = 'task-subtasks-layout-preferences';
const DEFAULT_SUBTASKS_WIDTH_PERCENT = 46;
const MIN_SUBTASKS_WIDTH_PERCENT = 28;
const MAX_SUBTASKS_WIDTH_PERCENT = 70;
const DEFAULT_GRAPH_HEIGHT_PERCENT = 42;
const MIN_GRAPH_HEIGHT_PERCENT = 22;
const MAX_GRAPH_HEIGHT_PERCENT = 72;

function clampLayoutPercent(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readTaskSubtasksLayoutPreferences(): TaskSubtasksLayoutPreferences {
  const fallback: TaskSubtasksLayoutPreferences = {
    subtasksWidthPercent: DEFAULT_SUBTASKS_WIDTH_PERCENT,
    graphHeightPercent: DEFAULT_GRAPH_HEIGHT_PERCENT,
  };

  if (typeof window === 'undefined') {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(TASK_SUBTASKS_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }

    const parsed = JSON.parse(raw) as Partial<TaskSubtasksLayoutPreferences>;
    return {
      subtasksWidthPercent: typeof parsed.subtasksWidthPercent === 'number'
        ? clampLayoutPercent(parsed.subtasksWidthPercent, MIN_SUBTASKS_WIDTH_PERCENT, MAX_SUBTASKS_WIDTH_PERCENT)
        : fallback.subtasksWidthPercent,
      graphHeightPercent: typeof parsed.graphHeightPercent === 'number'
        ? clampLayoutPercent(parsed.graphHeightPercent, MIN_GRAPH_HEIGHT_PERCENT, MAX_GRAPH_HEIGHT_PERCENT)
        : fallback.graphHeightPercent,
    };
  } catch {
    return fallback;
  }
}

function getChineseSummaryLabelKey(label: string): CompletionSummaryRowKey | null {
  switch (label) {
    case '\u5b8c\u6210\u5185\u5bb9':
    case '\u53d8\u66f4\u5185\u5bb9':
    case '\u5b9e\u73b0\u5185\u5bb9':
      return 'changed';
    case '\u9a8c\u8bc1\u7ed3\u679c':
    case '\u6d4b\u8bd5\u7ed3\u679c':
      return 'verified';
    case '\u5ba1\u6838\u8981\u70b9':
    case '\u5ba1\u6838\u8bf4\u660e':
    case '\u98ce\u9669':
    case '\u6ce8\u610f\u4e8b\u9879':
      return 'reviewNotes';
    case '\u5176\u5b83':
    case '\u5176\u4ed6':
    case '\u8bf4\u660e':
      return 'other';
    default:
      return null;
  }
}

const SUMMARY_LABEL_PATTERNS: Array<{
  pattern: RegExp;
  key: 'changed' | 'verified' | 'reviewNotes' | 'other';
}> = [
  { pattern: /^(完成内容|变更内容|实现内容|what changed|changes?|implemented|implementation)$/i, key: 'changed' },
  { pattern: /^(验证结果|测试结果|verification|verified|tests?)$/i, key: 'verified' },
  { pattern: /^(审核要点|审核说明|review notes?|reviewer notes?|notes?|risks?|风险|注意事项)$/i, key: 'reviewNotes' },
  { pattern: /^(其它|其他|说明|details?|summary)$/i, key: 'other' },
];

function splitMarkdownTableRow(line: string): string[] {
  const normalizedLine = normalizeMarkdownTableLine(line);
  return normalizedLine
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())
    .filter(Boolean);
}

function normalizeMarkdownTableLine(line: string): string {
  return line.trim().replace(/\\\|/g, '|');
}

function isMarkdownTableLine(line: string): boolean {
  const normalizedLine = normalizeMarkdownTableLine(line);
  return normalizedLine.startsWith('|') && normalizedLine.endsWith('|') && splitMarkdownTableRow(normalizedLine).length >= 2;
}

function isSummaryTableHeader(cells: string[]): boolean {
  if (cells.length < 2) return false;

  const label = stripSummaryMarkup(cells[0]).toLowerCase();
  const content = stripSummaryMarkup(cells[1]).toLowerCase();

  return /^(item|\u9879\u76ee|\u9805\u76ee)$/.test(label) &&
    /^(details?|content|\u5185\u5bb9|\u5167\u5bb9)$/.test(content);
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function stripSummaryMarkup(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\*\*/g, '')
    .replace(/^[-*]\s+/, '')
    .trim();
}

function getSummaryLabel(key: CompletionSummaryRowKey, t: TranslationFn): string {
  const labels: Record<CompletionSummaryRowKey, string> = {
    changed: t('tasks:subtasks.summaryChanged', { defaultValue: 'What changed' }),
    verified: t('tasks:subtasks.summaryVerified', { defaultValue: 'Verification' }),
    reviewNotes: t('tasks:subtasks.summaryReviewNotes', { defaultValue: 'Review notes' }),
    other: t('tasks:subtasks.summaryOther', { defaultValue: 'Other' }),
  };

  return labels[key];
}

type CompletionSummaryRowKey = 'changed' | 'verified' | 'reviewNotes' | 'other';

function normalizeSummaryLabel(label: string, t: TranslationFn): string {
  const normalized = stripSummaryMarkup(label).replace(/[:：]$/, '').trim();
  const chineseKey = getChineseSummaryLabelKey(normalized);
  if (chineseKey) {
    return getSummaryLabel(chineseKey, t);
  }

  const match = SUMMARY_LABEL_PATTERNS.find(item => item.pattern.test(normalized));
  return match ? getSummaryLabel(match.key, t) : normalized;
}

function parseMarkdownSummaryTable(summary: string, t: TranslationFn): CompletionSummaryRow[] {
  const lines = summary.split(/\r?\n/).map(normalizeMarkdownTableLine);
  const separatorIndex = lines.findIndex(isMarkdownTableSeparator);
  const headerIndex = separatorIndex > 0
    ? separatorIndex - 1
    : lines.findIndex(line => isMarkdownTableLine(line) && isSummaryTableHeader(splitMarkdownTableRow(line)));

  if (headerIndex < 0) {
    return [];
  }

  const bodyStartIndex = separatorIndex > headerIndex ? separatorIndex + 1 : headerIndex + 1;
  const tableEndIndex = lines.findIndex((line, index) =>
    index >= bodyStartIndex && line && !isMarkdownTableLine(line)
  );
  const effectiveTableEnd = tableEndIndex === -1 ? lines.length : tableEndIndex;
  const beforeTable = lines
    .slice(0, Math.max(0, headerIndex))
    .map(stripSummaryMarkup)
    .filter(Boolean);
  const afterTable = lines
    .slice(effectiveTableEnd)
    .map(stripSummaryMarkup)
    .filter(Boolean);

  const rows = lines
    .slice(bodyStartIndex, effectiveTableEnd)
    .filter(line => isMarkdownTableLine(line) && !isMarkdownTableSeparator(line))
    .map(splitMarkdownTableRow)
    .filter(cells => cells.length >= 2)
    .map(cells => ({
      label: normalizeSummaryLabel(cells[0], t),
      content: stripSummaryMarkup(cells.slice(1).join(' | ')),
    }))
    .filter(row => row.label && row.content);

  const supplemental = [...beforeTable, ...afterTable].join('\n');
  if (supplemental) {
    rows.push({
      label: getSummaryLabel('other', t),
      content: supplemental,
    });
  }

  return rows;
}

function classifySummaryText(value: string): CompletionSummaryRowKey {
  const lower = value.toLowerCase();
  if (/(验证|测试|通过|失败|构建|typecheck|lint|test|build|verified|verification|passed|failed|npm|pytest|vitest)/i.test(lower)) {
    return 'verified';
  }
  if (/(审核|注意|风险|影响|后续|review|note|risk|caveat|follow-up|follow up|remaining)/i.test(lower)) {
    return 'reviewNotes';
  }
  return 'changed';
}

function splitSummarySentences(summary: string): string[] {
  const bulletLines = summary
    .split(/\r?\n/)
    .map(stripSummaryMarkup)
    .filter(Boolean);

  if (bulletLines.length > 1) {
    return bulletLines;
  }

  return summary
    .split(/(?<=[。！？.!?])\s+/)
    .map(stripSummaryMarkup)
    .filter(Boolean);
}

function parseLabeledSummary(summary: string, t: TranslationFn): CompletionSummaryRow[] {
  const rows: Array<{ key: CompletionSummaryRowKey; content: string[] }> = [];
  let current: { key: CompletionSummaryRowKey; content: string[] } | null = null;

  for (const rawLine of summary.split(/\r?\n/)) {
    const line = stripSummaryMarkup(rawLine);
    if (!line) {
      continue;
    }

    const labeled = line.match(/^([^:：-]{2,40})\s*[:：-]\s*(.*)$/);
    const label = labeled ? stripSummaryMarkup(labeled[1]) : '';
    const labelMatch = label
      ? SUMMARY_LABEL_PATTERNS.find(item => item.pattern.test(label.replace(/[:：]$/, '').trim()))
      : undefined;

    if (labeled && labelMatch) {
      current = { key: labelMatch.key, content: [] };
      if (labeled[2]?.trim()) {
        current.content.push(stripSummaryMarkup(labeled[2]));
      }
      rows.push(current);
      continue;
    }

    if (current) {
      current.content.push(line);
    } else {
      const key = classifySummaryText(line);
      const existing = rows.find(row => row.key === key);
      if (existing) {
        existing.content.push(line);
      } else {
        rows.push({ key, content: [line] });
      }
    }
  }

  return rows
    .map(row => ({
      label: getSummaryLabel(row.key, t),
      content: row.content.join('\n'),
    }))
    .filter(row => row.content.trim());
}

function buildCompletionSummaryRows(summary: string, t: TranslationFn): CompletionSummaryRow[] {
  const tableRows = parseMarkdownSummaryTable(summary, t);
  if (tableRows.length > 0) {
    return tableRows;
  }

  const labeledRows = parseLabeledSummary(summary, t);
  if (labeledRows.length > 1) {
    return labeledRows;
  }

  const grouped = new Map<CompletionSummaryRowKey, string[]>();
  for (const sentence of splitSummarySentences(summary)) {
    const key = classifySummaryText(sentence);
    grouped.set(key, [...(grouped.get(key) ?? []), sentence]);
  }

  return Array.from(grouped.entries()).map(([key, values]) => ({
    label: getSummaryLabel(key, t),
    content: values.join('\n'),
  }));
}

function getSummaryRowStyle(label: string, t: TranslationFn): {
  icon: typeof ClipboardCheck;
  label: string;
  marker: string;
} {
  const changedLabel = getSummaryLabel('changed', t);
  const verifiedLabel = getSummaryLabel('verified', t);
  const reviewLabel = getSummaryLabel('reviewNotes', t);

  if (label === changedLabel) {
    return {
      icon: CheckCircle2,
      label: 'text-emerald-700 dark:text-emerald-300',
      marker: 'bg-emerald-500/80',
    };
  }

  if (label === verifiedLabel) {
    return {
      icon: ClipboardCheck,
      label: 'text-sky-700 dark:text-sky-300',
      marker: 'bg-sky-500/80',
    };
  }

  if (label === reviewLabel) {
    return {
      icon: AlertCircle,
      label: 'text-amber-700 dark:text-amber-300',
      marker: 'bg-amber-500/80',
    };
  }

  return {
    icon: ListChecks,
    label: 'text-muted-foreground',
    marker: 'bg-muted-foreground/70',
  };
}

function splitSummaryPoints(content: string): string[] {
  const lines = content
    .replace(/<br\s*\/?>/gi, '\n')
    .split(/\r?\n/)
    .map(stripSummaryMarkup)
    .filter(Boolean);

  if (lines.length > 1) {
    return lines;
  }

  return content
    .split(/(?<=[。！？.!?])\s+/)
    .map(stripSummaryMarkup)
    .filter(Boolean);
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function extractSummaryCommands(content: string): string[] {
  const commands = [
    ...content.matchAll(/`([^`]+)`/g),
    ...content.matchAll(/\b((?:npm|pnpm|yarn|bun|pytest|vitest|cargo|go|python|tsc|eslint|biome|make|cmake)\s+[^.;\n，。]*)/gi),
  ].map(match => match[1]);

  return uniqueValues(commands)
    .filter(command => !/[\\/][\w.-]+/.test(command) || /^(npm|pnpm|yarn|bun|pytest|vitest|cargo|go|python|tsc|eslint|biome|make|cmake)\b/i.test(command))
    .slice(0, 4);
}

function extractSummaryFiles(content: string): string[] {
  return uniqueValues([
    ...content.matchAll(/`([^`]+\.[A-Za-z0-9]{1,8})`/g),
    ...content.matchAll(/\b([\w@./-]+\.(?:ts|tsx|js|jsx|json|md|css|scss|html|py|go|rs|java|kt|cpp|c|h|yml|yaml))\b/g),
  ].map(match => match[1]))
    .filter(file => /[./\\]/.test(file) || file.includes('.'))
    .slice(0, 5);
}

function extractSummaryMetrics(content: string): Array<{ label: string; value: string }> {
  const metrics: Array<{ label: string; value: string }> = [];
  const lowered = content.toLowerCase();
  const pairs: Array<[RegExp, string]> = [
    [/\b(\d+)\s+files?\b/i, 'files'],
    [/\b(\d+)\s+tests?\b/i, 'tests'],
    [/\b(\d+)\s+checks?\b/i, 'checks'],
    [/\b(\d+)\s+steps?\b/i, 'steps'],
    [/\b(\d+)\s+tools?\b/i, 'tools'],
  ];

  for (const [pattern, label] of pairs) {
    const match = content.match(pattern);
    if (match) {
      metrics.push({ label, value: match[1] });
    }
  }

  if (/\b(pass(?:ed|es)?|success|ok|green|通过|成功)\b/i.test(lowered)) {
    metrics.push({ label: 'status', value: 'passed' });
  } else if (/\b(fail(?:ed|s)?|error|失败|错误)\b/i.test(lowered)) {
    metrics.push({ label: 'status', value: 'failed' });
  } else if (/\b(manual|review|audit|人工|审核)\b/i.test(lowered)) {
    metrics.push({ label: 'status', value: 'review' });
  }

  return metrics.slice(0, 4);
}

function inferSummaryStatus(content: string): SummaryVisualData['status'] {
  if (/\b(fail(?:ed|s)?|error|blocked|risk|失败|错误|阻塞|风险)\b/i.test(content)) {
    return 'failed';
  }
  if (/\b(manual|review|audit|caveat|follow-up|人工|审核|注意)\b/i.test(content)) {
    return 'warning';
  }
  if (/\b(pass(?:ed|es)?|verified|success|ok|完成|通过|成功)\b/i.test(content)) {
    return 'passed';
  }
  return 'neutral';
}

function buildSummaryVisualData(content: string): SummaryVisualData {
  const files = extractSummaryFiles(content);
  const commands = extractSummaryCommands(content);
  const points = splitSummaryPoints(content)
    .filter(point => point.length > 3)
    .slice(0, 4);

  return {
    points,
    files,
    commands,
    metrics: extractSummaryMetrics(content),
    status: inferSummaryStatus(content),
  };
}

function SummaryChip({
  children,
  title,
  tone = 'neutral',
}: {
  children: ReactNode;
  title?: string;
  tone?: 'neutral' | 'success' | 'info' | 'warning' | 'danger';
}) {
  const toneClass = {
    neutral: 'border-border bg-background/70 text-foreground/80',
    success: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    info: 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300',
    warning: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
    danger: 'border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300',
  }[tone];

  return (
    <span
      className={cn('inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] leading-4', toneClass)}
      title={title}
    >
      {children}
    </span>
  );
}

function CompletionSummaryTable({ summary, t }: { summary: string; t: TranslationFn }) {
  const rows = buildCompletionSummaryRows(summary, t);

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-background/60">
      {rows.map((row, index) => {
        const style = getSummaryRowStyle(row.label, t);
        const Icon = style.icon;
        const visual = buildSummaryVisualData(row.content);
        const points = visual.points.length > 0 ? visual.points : splitSummaryPoints(row.content);

        return (
          <div
            key={`${row.label}-${index}`}
            className="grid min-w-0 border-b border-border/50 last:border-b-0 md:grid-cols-[112px_minmax(0,1fr)]"
          >
            <div className="flex items-center gap-1.5 border-b border-border/40 bg-muted/30 px-2 py-1.5 md:border-b-0 md:border-r">
              <Icon className={cn('h-3.5 w-3.5 shrink-0', style.label)} />
              <span className={cn('truncate text-xs font-semibold', style.label)}>
                {row.label}
              </span>
            </div>
            <div className="min-w-0 px-2.5 py-1.5">
              {points.length > 1 ? (
                <ul className="space-y-1 text-xs leading-5 text-foreground/85">
                  {points.map((point, pointIndex) => (
                    <li key={`${point}-${pointIndex}`} className="flex min-w-0 gap-1.5">
                      <span className={cn('mt-2 h-1.5 w-1.5 shrink-0 rounded-full', style.marker)} />
                      <span className="min-w-0 break-words">{point}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="break-words text-xs leading-5 text-foreground/85">{points[0] ?? row.content}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function getSubtaskStatusIcon(status: string, isInProgress: boolean) {
  if (isInProgress) {
    return <Clock className="h-4 w-4 text-[var(--info)] animate-pulse" />;
  }

  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-[var(--error)]" />;
    default:
      return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
  }
}

function PaneResizeHandle({
  orientation,
  isDragging,
  label,
  onPointerDown,
}: {
  orientation: 'vertical' | 'horizontal';
  isDragging: boolean;
  label: string;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const isVertical = orientation === 'vertical';

  return (
    <div
      role="separator"
      aria-orientation={isVertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      onPointerDown={onPointerDown}
      className={cn(
        'group relative z-20 shrink-0 touch-none bg-border/40 transition-colors hover:bg-primary/20',
        isVertical ? 'flex w-2 cursor-col-resize items-center justify-center' : 'flex h-2 cursor-row-resize items-center justify-center',
        isDragging && 'bg-primary/30'
      )}
    >
      <div
        className={cn(
          'rounded-full bg-muted-foreground/35 transition-colors group-hover:bg-primary/70',
          isVertical ? 'h-10 w-0.5' : 'h-0.5 w-10',
          isDragging && 'bg-primary'
        )}
      />
    </div>
  );
}

interface ExecutionGraphTimeInterval {
  startedMs: number;
  completedMs: number;
}

interface ExecutionGraphNode {
  id: string;
  title: string;
  status: string;
  level: number;
  row: number;
  order: number;
  durationMs?: number;
  activeDurationMs?: number;
  activeStartedMs?: number;
  activeIntervals?: ExecutionGraphTimeInterval[];
  startedMs?: number;
  completedMs?: number;
  timingSource?: 'recorded' | 'logs';
}

interface ExecutionGraphEdge {
  from: string;
  to: string;
}

interface ExecutionGraphEdgeTone {
  id: string;
  strokeClass: string;
  markerClass: string;
}

interface ExecutionGraphPoint {
  x: number;
  y: number;
}

interface ExecutionGraphRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ExecutionGraphRouteBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface ExecutionGraphAnalysis {
  nodes: ExecutionGraphNode[];
  edges: ExecutionGraphEdge[];
  sequentialUnits: number;
  parallelUnits: number;
  savedUnits: number;
  sequentialDurationMs?: number;
  parallelDurationMs?: number;
  savedDurationMs?: number;
  timedNodeCount: number;
  maxParallel: number;
  hasCycle: boolean;
}

const EXECUTION_GRAPH_EDGE_TONES: ExecutionGraphEdgeTone[] = [
  { id: 'sky', strokeClass: 'stroke-sky-500/80', markerClass: 'fill-sky-500/80' },
  { id: 'emerald', strokeClass: 'stroke-emerald-500/80', markerClass: 'fill-emerald-500/80' },
  { id: 'amber', strokeClass: 'stroke-amber-500/85', markerClass: 'fill-amber-500/85' },
  { id: 'cyan', strokeClass: 'stroke-cyan-500/80', markerClass: 'fill-cyan-500/80' },
  { id: 'rose', strokeClass: 'stroke-rose-500/75', markerClass: 'fill-rose-500/75' },
];
const EXECUTION_GRAPH_DEFAULT_EDGE_TONE: ExecutionGraphEdgeTone = {
  id: 'default',
  strokeClass: 'stroke-border',
  markerClass: 'fill-border',
};
const EXECUTION_GRAPH_EDGE_CLEARANCE = 8;
const EXECUTION_GRAPH_ROUTE_TURN_PENALTY = 4;

function hashExecutionGraphId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function getExecutionGraphEdgeTone(edge: ExecutionGraphEdge): ExecutionGraphEdgeTone {
  return EXECUTION_GRAPH_EDGE_TONES[hashExecutionGraphId(edge.from) % EXECUTION_GRAPH_EDGE_TONES.length];
}

function isExecutionGraphEdgeSelected(edge: ExecutionGraphEdge, selectedNodeId: string | null): boolean {
  return selectedNodeId === edge.from || selectedNodeId === edge.to;
}

function normalizeExecutionGraphCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

function getExecutionGraphNodeRect({
  node,
  paddingX,
  paddingY,
  columnGap,
  rowGap,
  nodeWidth,
  nodeHeight,
}: {
  node: ExecutionGraphNode;
  paddingX: number;
  paddingY: number;
  columnGap: number;
  rowGap: number;
  nodeWidth: number;
  nodeHeight: number;
}): ExecutionGraphRect {
  const left = paddingX + node.level * columnGap;
  const top = paddingY + node.row * rowGap;

  return {
    left: left - EXECUTION_GRAPH_EDGE_CLEARANCE,
    top: top - EXECUTION_GRAPH_EDGE_CLEARANCE,
    right: left + nodeWidth + EXECUTION_GRAPH_EDGE_CLEARANCE,
    bottom: top + nodeHeight + EXECUTION_GRAPH_EDGE_CLEARANCE,
  };
}

function pointIntersectsExecutionGraphRect(point: ExecutionGraphPoint, rect: ExecutionGraphRect): boolean {
  return point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom;
}

function segmentIntersectsExecutionGraphRect(
  start: ExecutionGraphPoint,
  end: ExecutionGraphPoint,
  rect: ExecutionGraphRect,
): boolean {
  if (Math.abs(start.y - end.y) < 0.01) {
    const y = start.y;
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    return y > rect.top && y < rect.bottom && maxX > rect.left && minX < rect.right;
  }

  if (Math.abs(start.x - end.x) < 0.01) {
    const x = start.x;
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    return x > rect.left && x < rect.right && maxY > rect.top && minY < rect.bottom;
  }

  return true;
}

function segmentIntersectsExecutionGraphObstacles(
  start: ExecutionGraphPoint,
  end: ExecutionGraphPoint,
  obstacles: ExecutionGraphRect[],
): boolean {
  return obstacles.some(rect => segmentIntersectsExecutionGraphRect(start, end, rect));
}

function clampExecutionGraphRouteCoordinate(value: number, min: number, max: number): number {
  return normalizeExecutionGraphCoordinate(Math.max(min, Math.min(max, value)));
}

function getExecutionGraphRouteKey(point: ExecutionGraphPoint, direction: 'h' | 'v' | 'start'): string {
  return `${point.x},${point.y},${direction}`;
}

function isDirectModeTask(task: Task): boolean {
  return task.metadata?.developmentMode === 'direct' || task.metadata?.workflowMode === 'off';
}

function getExecutionGraphPointKey(point: ExecutionGraphPoint): string {
  return `${point.x},${point.y}`;
}

function simplifyExecutionGraphRoute(points: ExecutionGraphPoint[]): ExecutionGraphPoint[] {
  const withoutDuplicates = points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });
  const simplified: ExecutionGraphPoint[] = [];

  for (const point of withoutDuplicates) {
    const previous = simplified[simplified.length - 1];
    const beforePrevious = simplified[simplified.length - 2];
    if (
      previous &&
      beforePrevious &&
      ((beforePrevious.x === previous.x && previous.x === point.x) ||
        (beforePrevious.y === previous.y && previous.y === point.y))
    ) {
      simplified[simplified.length - 1] = point;
    } else {
      simplified.push(point);
    }
  }

  return simplified;
}

function routeExecutionGraphEdge(input: {
  start: ExecutionGraphPoint;
  end: ExecutionGraphPoint;
  obstacles: ExecutionGraphRect[];
  bounds: ExecutionGraphRouteBounds;
}): ExecutionGraphPoint[] | null {
  const { start, end, obstacles, bounds } = input;
  const xCandidates = new Set<number>([
    normalizeExecutionGraphCoordinate(start.x),
    normalizeExecutionGraphCoordinate(end.x),
  ]);
  const yCandidates = new Set<number>([
    normalizeExecutionGraphCoordinate(start.y),
    normalizeExecutionGraphCoordinate(end.y),
  ]);

  for (const rect of obstacles) {
    xCandidates.add(clampExecutionGraphRouteCoordinate(rect.left - EXECUTION_GRAPH_EDGE_CLEARANCE, bounds.minX, bounds.maxX));
    xCandidates.add(clampExecutionGraphRouteCoordinate(rect.right + EXECUTION_GRAPH_EDGE_CLEARANCE, bounds.minX, bounds.maxX));
    yCandidates.add(clampExecutionGraphRouteCoordinate(rect.top - EXECUTION_GRAPH_EDGE_CLEARANCE, bounds.minY, bounds.maxY));
    yCandidates.add(clampExecutionGraphRouteCoordinate(rect.bottom + EXECUTION_GRAPH_EDGE_CLEARANCE, bounds.minY, bounds.maxY));
  }

  const xs = [...xCandidates].sort((left, right) => left - right);
  const ys = [...yCandidates].sort((left, right) => left - right);
  const xIndexByValue = new Map(xs.map((value, index) => [value, index]));
  const yIndexByValue = new Map(ys.map((value, index) => [value, index]));
  const startPoint = {
    x: normalizeExecutionGraphCoordinate(start.x),
    y: normalizeExecutionGraphCoordinate(start.y),
  };
  const endPoint = {
    x: normalizeExecutionGraphCoordinate(end.x),
    y: normalizeExecutionGraphCoordinate(end.y),
  };
  const endPointKey = getExecutionGraphPointKey(endPoint);
  const isPointBlocked = (point: ExecutionGraphPoint): boolean =>
    obstacles.some(rect => pointIntersectsExecutionGraphRect(point, rect));
  const isSegmentBlocked = (from: ExecutionGraphPoint, to: ExecutionGraphPoint): boolean =>
    segmentIntersectsExecutionGraphObstacles(from, to, obstacles);
  const queue: Array<{ point: ExecutionGraphPoint; direction: 'h' | 'v' | 'start'; cost: number }> = [
    { point: startPoint, direction: 'start', cost: 0 },
  ];
  const startKey = getExecutionGraphRouteKey(startPoint, 'start');
  const distances = new Map<string, number>([[startKey, 0]]);
  const previousByKey = new Map<string, string>();
  const pointByKey = new Map<string, ExecutionGraphPoint>([[startKey, startPoint]]);
  let finalKey: string | null = null;

  while (queue.length > 0) {
    queue.sort((left, right) => left.cost - right.cost);
    const current = queue.shift();
    if (!current) {
      break;
    }

    const currentKey = getExecutionGraphRouteKey(current.point, current.direction);
    if ((distances.get(currentKey) ?? Number.POSITIVE_INFINITY) < current.cost) {
      continue;
    }

    if (getExecutionGraphPointKey(current.point) === endPointKey) {
      finalKey = currentKey;
      break;
    }

    const xIndex = xIndexByValue.get(current.point.x);
    const yIndex = yIndexByValue.get(current.point.y);
    if (xIndex === undefined || yIndex === undefined) {
      continue;
    }

    const neighbors: Array<{ point: ExecutionGraphPoint; direction: 'h' | 'v' }> = [];
    for (const nextX of [xs[xIndex - 1], xs[xIndex + 1]]) {
      if (nextX !== undefined) {
        neighbors.push({ point: { x: nextX, y: current.point.y }, direction: 'h' });
      }
    }
    for (const nextY of [ys[yIndex - 1], ys[yIndex + 1]]) {
      if (nextY !== undefined) {
        neighbors.push({ point: { x: current.point.x, y: nextY }, direction: 'v' });
      }
    }

    for (const neighbor of neighbors) {
      if (
        getExecutionGraphPointKey(neighbor.point) !== endPointKey &&
        isPointBlocked(neighbor.point)
      ) {
        continue;
      }
      if (isSegmentBlocked(current.point, neighbor.point)) {
        continue;
      }

      const distance = Math.abs(neighbor.point.x - current.point.x) + Math.abs(neighbor.point.y - current.point.y);
      const turnPenalty = current.direction !== 'start' && current.direction !== neighbor.direction
        ? EXECUTION_GRAPH_ROUTE_TURN_PENALTY
        : 0;
      const nextCost = current.cost + distance + turnPenalty;
      const nextKey = getExecutionGraphRouteKey(neighbor.point, neighbor.direction);
      if (nextCost >= (distances.get(nextKey) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }

      distances.set(nextKey, nextCost);
      previousByKey.set(nextKey, currentKey);
      pointByKey.set(nextKey, neighbor.point);
      queue.push({ point: neighbor.point, direction: neighbor.direction, cost: nextCost });
    }
  }

  if (!finalKey) {
    return null;
  }

  const route: ExecutionGraphPoint[] = [];
  let cursor: string | undefined = finalKey;
  while (cursor) {
    const point = pointByKey.get(cursor);
    if (point) {
      route.push(point);
    }
    cursor = previousByKey.get(cursor);
  }

  return simplifyExecutionGraphRoute(route.reverse());
}

function formatExecutionGraphPath(points: ExecutionGraphPoint[]): string {
  const route = simplifyExecutionGraphRoute(points);
  if (route.length === 0) {
    return '';
  }

  const first = route[0];
  if (!first) {
    return '';
  }

  let path = `M ${first.x} ${first.y}`;
  for (let index = 1; index < route.length; index += 1) {
    const previous = route[index - 1];
    const point = route[index];
    if (!previous || !point) {
      continue;
    }
    if (previous && Math.abs(previous.y - point.y) < 0.01) {
      path = `${path} H ${point.x}`;
      continue;
    }
    if (previous && Math.abs(previous.x - point.x) < 0.01) {
      path = `${path} V ${point.y}`;
      continue;
    }
    path = `${path} L ${point.x} ${point.y}`;
  }

  return path;
}

function getExecutionGraphEdgePath({
  x1,
  y1,
  x2,
  y2,
  edgeIndex,
  obstacles = [],
  bounds,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  edgeIndex: number;
  obstacles?: ExecutionGraphRect[];
  bounds: ExecutionGraphRouteBounds;
}): string {
  const endX = x2 - 8;
  const start = {
    x: normalizeExecutionGraphCoordinate(x1),
    y: normalizeExecutionGraphCoordinate(y1),
  };
  const end = {
    x: normalizeExecutionGraphCoordinate(endX),
    y: normalizeExecutionGraphCoordinate(y2),
  };

  if (
    Math.abs(y1 - y2) < 1 &&
    !segmentIntersectsExecutionGraphObstacles(start, end, obstacles)
  ) {
    return `M ${x1} ${y1} H ${endX}`;
  }

  const routeStart = {
    x: clampExecutionGraphRouteCoordinate(
      x1 + (endX >= x1 ? EXECUTION_GRAPH_EDGE_CLEARANCE : -EXECUTION_GRAPH_EDGE_CLEARANCE),
      bounds.minX,
      bounds.maxX,
    ),
    y: normalizeExecutionGraphCoordinate(y1),
  };
  const routed = routeExecutionGraphEdge({
    start: routeStart,
    end,
    obstacles,
    bounds,
  });
  if (routed) {
    return formatExecutionGraphPath([start, ...routed]);
  }

  const baseMidX = x1 + Math.max(16, (x2 - x1) / 2);
  const laneOffset = ((edgeIndex % 5) - 2) * 3;
  const midX = Math.max(x1 + 10, Math.min(endX - 6, baseMidX + laneOffset));
  return `M ${x1} ${y1} H ${midX} V ${y2} H ${endX}`;
}

function getSubtaskDependencies(subtask: Task['subtasks'][number]): string[] {
  const withDependencies = subtask as Task['subtasks'][number] & {
    dependsOn?: unknown;
    depends_on?: unknown;
  };
  const raw = Array.isArray(withDependencies.dependsOn)
    ? withDependencies.dependsOn
    : Array.isArray(withDependencies.depends_on)
      ? withDependencies.depends_on
      : [];

  return [...new Set(raw.map(String).map(value => value.trim()).filter(Boolean))];
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function getSubtaskRecordedTiming(subtask: Task['subtasks'][number]): {
  startedMs?: number;
  completedMs?: number;
  durationMs?: number;
} {
  const timedSubtask = subtask as Task['subtasks'][number] & {
    startedAt?: unknown;
    completedAt?: unknown;
    started_at?: unknown;
    completed_at?: unknown;
    durationMs?: unknown;
    duration_ms?: unknown;
  };
  const startedMs = parseTimestampMs(timedSubtask.startedAt ?? timedSubtask.started_at);
  const completedMs = parseTimestampMs(timedSubtask.completedAt ?? timedSubtask.completed_at);
  const rawDuration = typeof timedSubtask.durationMs === 'number'
    ? timedSubtask.durationMs
    : typeof timedSubtask.duration_ms === 'number'
      ? timedSubtask.duration_ms
      : undefined;
  const durationMs = rawDuration !== undefined && rawDuration >= 0
    ? rawDuration
    : startedMs !== undefined && completedMs !== undefined && completedMs >= startedMs
      ? completedMs - startedMs
      : undefined;

  return {
    ...(startedMs !== undefined ? { startedMs } : {}),
    ...(completedMs !== undefined ? { completedMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

type ExecutionGraphLogTiming = {
  startedMs: number;
  completedMs?: number;
  durationMs?: number;
  activeDurationMs?: number;
  activeStartedMs?: number;
  activeIntervals?: ExecutionGraphTimeInterval[];
};

function getLogInferredTimingBySubtaskId(logs: TaskLogsData | null | undefined): Map<string, ExecutionGraphLogTiming> {
  const timingById = new Map<string, {
    startedMs: number;
    latestMs: number;
    activeDurationMs: number;
    activeStartedMs?: number;
    activeIntervals: ExecutionGraphTimeInterval[];
    terminal: boolean;
  }>();
  if (!logs) {
    return new Map();
  }

  const entries = [
    ...logs.phases.planning.entries,
    ...logs.phases.coding.entries,
    ...logs.phases.validation.entries,
  ]
    .map(entry => ({ entry, timestamp: parseTimestampMs(entry.timestamp) }))
    .filter((item): item is { entry: TaskLogsData['phases']['coding']['entries'][number]; timestamp: number } =>
      Boolean(item.entry.subtask_id) && item.timestamp !== undefined
    )
    .sort((left, right) => left.timestamp - right.timestamp);

  for (const { entry, timestamp } of entries) {
    const subtaskId = entry.subtask_id;
    if (!subtaskId) {
      continue;
    }

    let timing = timingById.get(subtaskId);
    if (!timing) {
      timing = {
        startedMs: timestamp,
        latestMs: timestamp,
        activeDurationMs: 0,
        activeIntervals: [],
        terminal: false,
      };
      timingById.set(subtaskId, timing);
    }

    const isStart = isExecutionGraphWorkItemStartLogEntry(entry, subtaskId);
    if (isStart) {
      if (timing.activeStartedMs !== undefined) {
        const completedMs = Math.max(timing.latestMs, timing.activeStartedMs);
        timing.activeDurationMs += Math.max(0, completedMs - timing.activeStartedMs);
        timing.activeIntervals.push({ startedMs: timing.activeStartedMs, completedMs });
      }
      timing.activeStartedMs = timestamp;
      timing.terminal = false;
    } else if (timing.activeStartedMs === undefined && !timing.terminal) {
      timing.activeStartedMs = timestamp;
    }

    timing.startedMs = Math.min(timing.startedMs, timestamp);
    timing.latestMs = Math.max(timing.latestMs, timestamp);

    if (isTerminalSubtaskLogEntry(entry)) {
      const activeStartedMs = timing.activeStartedMs ?? timestamp;
      timing.activeDurationMs += Math.max(0, timestamp - activeStartedMs);
      timing.activeIntervals.push({ startedMs: activeStartedMs, completedMs: timestamp });
      timing.activeStartedMs = undefined;
      timing.terminal = true;
    }
  }

  const result = new Map<string, ExecutionGraphLogTiming>();
  for (const [subtaskId, timing] of timingById) {
    if (!timing.terminal) {
      result.set(subtaskId, {
        startedMs: timing.startedMs,
        activeDurationMs: timing.activeDurationMs,
        ...(timing.activeStartedMs !== undefined ? { activeStartedMs: timing.activeStartedMs } : {}),
        ...(timing.activeIntervals.length > 0 ? { activeIntervals: timing.activeIntervals } : {}),
      });
      continue;
    }

    result.set(subtaskId, {
      startedMs: timing.startedMs,
      completedMs: timing.latestMs,
      durationMs: timing.activeDurationMs,
      ...(timing.activeIntervals.length > 0 ? { activeIntervals: timing.activeIntervals } : {}),
    });
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isExecutionGraphWorkItemStartLogEntry(entry: { content?: string }, subtaskId: string): boolean {
  const escapedId = escapeRegExp(subtaskId);
  return new RegExp(
    `\\b(?:coding|started)\\s+(?:work\\s+(?:item|package)|subtask)\\s+${escapedId}\\b`,
    'i',
  ).test(String(entry.content || ''));
}

function isTerminalSubtaskLogEntry(entry: { type?: string; content?: string }): boolean {
  const type = String(entry.type || '').toLowerCase();
  if (type === 'success') {
    return true;
  }
  if (type !== 'error') {
    return false;
  }
  return /\b(work item|subtask)\b.+\b(failed|blocked|cancelled|completed)\b/i.test(String(entry.content || ''));
}

function resolveSubtaskTiming(
  subtask: Task['subtasks'][number],
  logTimingBySubtaskId: Map<string, ExecutionGraphLogTiming>,
): Pick<ExecutionGraphNode, 'startedMs' | 'completedMs' | 'durationMs' | 'activeDurationMs' | 'activeStartedMs' | 'activeIntervals' | 'timingSource'> {
  const recorded = getSubtaskRecordedTiming(subtask);
  const inferred = logTimingBySubtaskId.get(subtask.id);

  if (subtask.status === 'in_progress') {
    const startedMs = [recorded.startedMs, inferred?.startedMs]
      .filter((value): value is number => value !== undefined)
      .reduce<number | undefined>((earliest, value) => earliest === undefined ? value : Math.min(earliest, value), undefined);
    const activeStartedMs = inferred?.activeStartedMs ?? recorded.startedMs;
    const activeDurationMs = Math.max(
      inferred?.activeDurationMs ?? inferred?.durationMs ?? 0,
      recorded.durationMs ?? 0,
    );

    if (startedMs !== undefined || activeStartedMs !== undefined || recorded.completedMs !== undefined || recorded.durationMs !== undefined) {
      return {
        ...recorded,
        ...(startedMs !== undefined ? { startedMs } : {}),
        ...(activeDurationMs > 0 ? { activeDurationMs } : {}),
        ...(activeStartedMs !== undefined ? { activeStartedMs } : {}),
        ...(inferred?.activeIntervals ? { activeIntervals: inferred.activeIntervals } : {}),
        timingSource: inferred ? 'logs' : 'recorded',
      };
    }
  }

  if (recorded.startedMs !== undefined || recorded.completedMs !== undefined || recorded.durationMs !== undefined) {
    return {
      ...recorded,
      timingSource: 'recorded',
    };
  }

  if (inferred) {
    return {
      ...inferred,
      timingSource: 'logs',
    };
  }

  return {};
}
function formatExecutionDuration(ms: number): string {
  if (ms <= 0) {
    return '0s';
  }

  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}

function getExecutionGraphNodeMetricLabel(node: ExecutionGraphNode, nowMs: number, t: TranslationFn): string | null {
  if (node.status === 'pending') {
    return t('tasks:subtasks.graphTimeSlot', {
      count: node.level + 1,
      defaultValue: 'Round {{count}}',
    });
  }

  if (node.status === 'in_progress') {
    const elapsedMs = node.activeStartedMs !== undefined
      ? (node.activeDurationMs ?? 0) + Math.max(0, nowMs - node.activeStartedMs)
      : node.activeDurationMs ?? (node.startedMs !== undefined ? Math.max(0, nowMs - node.startedMs) : node.durationMs);

    if (elapsedMs !== undefined) {
      return t('tasks:subtasks.graphNodeDuration', {
        duration: formatExecutionDuration(elapsedMs),
        defaultValue: '{{duration}}',
      });
    }

    return null;
  }

  if (node.durationMs !== undefined) {
    return t('tasks:subtasks.graphNodeDuration', {
      duration: formatExecutionDuration(node.durationMs),
      defaultValue: '{{duration}}',
    });
  }

  return null;
}

function calculateExecutionIntervalUnionDuration(intervals: ExecutionGraphTimeInterval[]): number | undefined {
  const normalized = intervals
    .filter(interval => interval.completedMs >= interval.startedMs)
    .sort((left, right) => left.startedMs - right.startedMs || left.completedMs - right.completedMs);
  if (normalized.length === 0) {
    return undefined;
  }

  let total = 0;
  let currentStart = normalized[0].startedMs;
  let currentEnd = normalized[0].completedMs;

  for (const interval of normalized.slice(1)) {
    if (interval.startedMs <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.completedMs);
      continue;
    }

    total += Math.max(0, currentEnd - currentStart);
    currentStart = interval.startedMs;
    currentEnd = interval.completedMs;
  }

  return total + Math.max(0, currentEnd - currentStart);
}

function getExecutionGraphNodeCompletedIntervals(node: ExecutionGraphNode): ExecutionGraphTimeInterval[] {
  if (node.activeIntervals && node.activeIntervals.length > 0) {
    return node.activeIntervals;
  }

  if (
    node.startedMs !== undefined &&
    node.completedMs !== undefined &&
    node.durationMs !== undefined &&
    Math.abs(node.completedMs - node.startedMs - node.durationMs) < 1000
  ) {
    return [{ startedMs: node.startedMs, completedMs: node.completedMs }];
  }

  return [];
}
function calculateParallelDurationFromTimedNodes(
  nodes: ExecutionGraphNode[],
  dependenciesById: Map<string, string[]>,
  hasCycle: boolean,
): number | undefined {
  const timedNodes = nodes.filter(node => node.durationMs !== undefined);
  if (timedNodes.length !== nodes.length || timedNodes.length === 0) {
    return undefined;
  }

  const activeIntervalsByNode = timedNodes.map(getExecutionGraphNodeCompletedIntervals);
  if (activeIntervalsByNode.every(intervals => intervals.length > 0)) {
    return calculateExecutionIntervalUnionDuration(activeIntervalsByNode.flat());
  }

  const nodesWithWallClock = timedNodes.filter(node =>
    node.startedMs !== undefined &&
    node.completedMs !== undefined &&
    node.completedMs >= node.startedMs
  );
  const wallClockMatchesRecordedDurations = nodesWithWallClock.every(node =>
    node.durationMs === undefined ||
    Math.abs((node.completedMs ?? 0) - (node.startedMs ?? 0) - node.durationMs) < 1000
  );
  if (nodesWithWallClock.length === nodes.length && wallClockMatchesRecordedDurations) {
    const minStart = Math.min(...nodesWithWallClock.map(node => node.startedMs ?? 0));
    const maxCompleted = Math.max(...nodesWithWallClock.map(node => node.completedMs ?? 0));
    return Math.max(0, maxCompleted - minStart);
  }

  if (hasCycle) {
    return undefined;
  }

  const durationById = new Map(nodes.map(node => [node.id, node.durationMs ?? 0]));
  const ordered = [...nodes].sort((left, right) => left.level - right.level || left.order - right.order);
  const finishById = new Map<string, number>();
  for (const node of ordered) {
    const dependencyFinish = (dependenciesById.get(node.id) ?? [])
      .reduce((maxFinish, dependencyId) => Math.max(maxFinish, finishById.get(dependencyId) ?? 0), 0);
    finishById.set(node.id, dependencyFinish + (durationById.get(node.id) ?? 0));
  }

  return Math.max(...finishById.values());
}

function calculateMaxConcurrentTimedNodes(nodes: ExecutionGraphNode[]): number | undefined {
  const events: Array<{ time: number; delta: number }> = [];
  for (const node of nodes) {
    if (
      node.startedMs === undefined ||
      node.completedMs === undefined ||
      node.completedMs < node.startedMs
    ) {
      continue;
    }
    events.push({ time: node.startedMs, delta: 1 });
    events.push({ time: node.completedMs, delta: -1 });
  }

  if (events.length === 0) {
    return undefined;
  }

  events.sort((left, right) => left.time - right.time || left.delta - right.delta);
  let active = 0;
  let maxActive = 0;
  for (const event of events) {
    active += event.delta;
    maxActive = Math.max(maxActive, active);
  }
  return maxActive;
}

function analyzeSubtaskExecutionGraph(
  subtasks: Task['subtasks'],
  logs?: TaskLogsData | null,
): ExecutionGraphAnalysis {
  const logTimingBySubtaskId = getLogInferredTimingBySubtaskId(logs);
  const ids = new Set(subtasks.map(subtask => subtask.id));
  const orderById = new Map(subtasks.map((subtask, index) => [subtask.id, index]));
  const dependenciesById = new Map<string, string[]>();
  const childrenById = new Map<string, string[]>();
  const inDegreeById = new Map<string, number>();

  for (const subtask of subtasks) {
    const dependencies = getSubtaskDependencies(subtask)
      .filter(dependencyId => dependencyId !== subtask.id && ids.has(dependencyId));
    dependenciesById.set(subtask.id, dependencies);
    inDegreeById.set(subtask.id, dependencies.length);
    childrenById.set(subtask.id, []);
  }

  for (const [id, dependencies] of dependenciesById) {
    for (const dependencyId of dependencies) {
      childrenById.get(dependencyId)?.push(id);
    }
  }

  const sortedIds: string[] = [];
  const ready = subtasks
    .filter(subtask => (inDegreeById.get(subtask.id) ?? 0) === 0)
    .map(subtask => subtask.id);

  while (ready.length > 0) {
    ready.sort((left, right) => (orderById.get(left) ?? 0) - (orderById.get(right) ?? 0));
    const id = ready.shift();
    if (!id) {
      continue;
    }
    sortedIds.push(id);

    for (const childId of childrenById.get(id) ?? []) {
      const nextDegree = Math.max(0, (inDegreeById.get(childId) ?? 0) - 1);
      inDegreeById.set(childId, nextDegree);
      if (nextDegree === 0) {
        ready.push(childId);
      }
    }
  }

  const hasCycle = sortedIds.length < subtasks.length;
  const effectiveOrder = hasCycle ? subtasks.map(subtask => subtask.id) : sortedIds;
  const levelById = new Map<string, number>();

  for (const id of effectiveOrder) {
    const dependencies = hasCycle ? [] : dependenciesById.get(id) ?? [];
    const level = dependencies.reduce(
      (maxLevel, dependencyId) => Math.max(maxLevel, (levelById.get(dependencyId) ?? 0) + 1),
      0,
    );
    levelById.set(id, level);
  }

  const rowCounters = new Map<number, number>();
  const nodes = subtasks.map((subtask, index) => {
    const level = levelById.get(subtask.id) ?? 0;
    const row = rowCounters.get(level) ?? 0;
    rowCounters.set(level, row + 1);
    const timing = resolveSubtaskTiming(subtask, logTimingBySubtaskId);
    return {
      id: subtask.id,
      title: subtask.title || subtask.id,
      status: subtask.status,
      level,
      row,
      order: index,
      ...timing,
    };
  });
  const edges = [...dependenciesById.entries()]
    .flatMap(([to, dependencies]) => dependencies.map(from => ({ from, to })));
  const parallelUnits = nodes.length > 0
    ? Math.max(...nodes.map(node => node.level)) + 1
    : 0;
  const maxParallel = rowCounters.size > 0
    ? Math.max(...rowCounters.values())
    : 0;
  const timedNodeCount = nodes.filter(node => node.durationMs !== undefined).length;
  const sequentialDurationMs = timedNodeCount === nodes.length && timedNodeCount > 0
    ? nodes.reduce((total, node) => total + (node.durationMs ?? 0), 0)
    : undefined;
  const parallelDurationMs = sequentialDurationMs !== undefined
    ? calculateParallelDurationFromTimedNodes(nodes, dependenciesById, hasCycle)
    : undefined;
  const savedDurationMs = sequentialDurationMs !== undefined && parallelDurationMs !== undefined
    ? Math.max(0, sequentialDurationMs - parallelDurationMs)
    : undefined;
  const timedMaxParallel = calculateMaxConcurrentTimedNodes(nodes);

  return {
    nodes,
    edges,
    sequentialUnits: nodes.length,
    parallelUnits: hasCycle ? nodes.length : parallelUnits,
    savedUnits: hasCycle ? 0 : Math.max(0, nodes.length - parallelUnits),
    ...(sequentialDurationMs !== undefined ? { sequentialDurationMs } : {}),
    ...(parallelDurationMs !== undefined ? { parallelDurationMs } : {}),
    ...(savedDurationMs !== undefined ? { savedDurationMs } : {}),
    timedNodeCount,
    maxParallel: timedMaxParallel ?? maxParallel,
    hasCycle,
  };
}

function getExecutionGraphNodeClass(status: string): string {
  switch (status) {
    case 'completed':
      return 'border-success/50 bg-success/10 text-success';
    case 'failed':
      return 'border-destructive/50 bg-destructive/10 text-destructive';
    case 'in_progress':
      return 'border-info/60 bg-info/10 text-info';
    default:
      return 'border-border bg-background text-foreground';
  }
}

function ExecutionGraphPanel({
  task,
  modelLogs,
  selectedNodeId,
  onSelectNode,
  onClearSelection,
  heightPercent,
}: {
  task: Task;
  modelLogs?: TaskLogsData | null;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onClearSelection: () => void;
  heightPercent: number;
}) {
  const { t } = useTranslation(['tasks']);
  const graph = useMemo(() => analyzeSubtaskExecutionGraph(task.subtasks, modelLogs), [task.subtasks, modelLogs]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasRunningTimedNode = useMemo(
    () => graph.nodes.some(node => node.status === 'in_progress' && (node.activeStartedMs !== undefined || node.startedMs !== undefined)),
    [graph.nodes],
  );

  useEffect(() => {
    if (!hasRunningTimedNode) {
      return;
    }

    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [hasRunningTimedNode]);

  if (task.subtasks.length === 0) {
    return null;
  }

  const nodeWidth = 118;
  const nodeHeight = 42;
  const columnGap = 148;
  const rowGap = 56;
  const paddingX = 18;
  const paddingY = 16;
  const width = Math.max(420, paddingX * 2 + (Math.max(...graph.nodes.map(node => node.level), 0) * columnGap) + nodeWidth);
  const height = Math.max(118, paddingY * 2 + (Math.max(...graph.nodes.map(node => node.row), 0) * rowGap) + nodeHeight);
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const nodeRectById = new Map(graph.nodes.map(node => [
    node.id,
    getExecutionGraphNodeRect({ node, paddingX, paddingY, columnGap, rowGap, nodeWidth, nodeHeight }),
  ]));
  const routeBounds: ExecutionGraphRouteBounds = {
    minX: EXECUTION_GRAPH_EDGE_CLEARANCE,
    maxX: Math.max(EXECUTION_GRAPH_EDGE_CLEARANCE, width - EXECUTION_GRAPH_EDGE_CLEARANCE),
    minY: EXECUTION_GRAPH_EDGE_CLEARANCE,
    maxY: Math.max(EXECUTION_GRAPH_EDGE_CLEARANCE, height - EXECUTION_GRAPH_EDGE_CLEARANCE),
  };
  const speedup = graph.parallelUnits > 0
    ? ((graph.sequentialDurationMs !== undefined && graph.parallelDurationMs && graph.parallelDurationMs > 0)
        ? graph.sequentialDurationMs / graph.parallelDurationMs
        : graph.sequentialUnits / graph.parallelUnits).toFixed(1)
    : '1.0';
  const hasDurationStats = graph.sequentialDurationMs !== undefined && graph.parallelDurationMs !== undefined;
  const graphEdges = [...graph.edges].sort((left, right) =>
    Number(isExecutionGraphEdgeSelected(left, selectedNodeId)) -
    Number(isExecutionGraphEdgeSelected(right, selectedNodeId))
  );

  return (
    <section
      className="flex min-h-[10rem] shrink-0 flex-col border-b border-border bg-muted/10"
      data-testid="subtask-execution-graph"
      style={{ height: `${heightPercent}%` }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium text-foreground">
            {t('tasks:subtasks.executionGraph', { defaultValue: 'Execution graph' })}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          <span className="rounded-md border border-border bg-background px-1.5 py-0.5 tabular-nums">
            {hasDurationStats
              ? t('tasks:subtasks.sequentialDuration', {
                  duration: formatExecutionDuration(graph.sequentialDurationMs ?? 0),
                  defaultValue: 'Sequential {{duration}}',
                })
              : t('tasks:subtasks.sequentialTime', {
                  count: graph.sequentialUnits,
                  defaultValue: 'Sequential {{count}} rounds',
                })}
          </span>
          <span className="rounded-md border border-border bg-background px-1.5 py-0.5 tabular-nums">
            {hasDurationStats
              ? t('tasks:subtasks.parallelDuration', {
                  duration: formatExecutionDuration(graph.parallelDurationMs ?? 0),
                  defaultValue: 'Parallel {{duration}}',
                })
              : t('tasks:subtasks.parallelTime', {
                  count: graph.parallelUnits,
                  defaultValue: 'Parallel {{count}} rounds',
                })}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 px-4 py-2 text-[11px] text-muted-foreground">
        <span>
          {hasDurationStats
            ? t('tasks:subtasks.savedDuration', {
                duration: formatExecutionDuration(graph.savedDurationMs ?? 0),
                defaultValue: 'Saves {{duration}}',
              })
            : t('tasks:subtasks.savedTime', {
                count: graph.savedUnits,
                defaultValue: 'Saves {{count}} rounds',
              })}
        </span>
        <span className="text-muted-foreground/40">/</span>
        <span>
          {t('tasks:subtasks.maxParallel', {
            count: graph.maxParallel,
            defaultValue: 'Max parallel {{count}}',
          })}
        </span>
        <span className="text-muted-foreground/40">/</span>
        <span className="tabular-nums">
          {t('tasks:subtasks.speedup', {
            value: speedup,
            defaultValue: '{{value}}x',
          })}
        </span>
        {!hasDurationStats && graph.timedNodeCount > 0 && (
          <>
            <span className="text-muted-foreground/40">/</span>
            <span>
              {t('tasks:subtasks.timingPartial', {
                count: graph.timedNodeCount,
                total: graph.nodes.length,
                defaultValue: 'Timed {{count}}/{{total}}',
              })}
            </span>
          </>
        )}
        {graph.hasCycle && (
          <span className="ml-auto rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-destructive">
            {t('tasks:subtasks.dependencyCycle', { defaultValue: 'Dependency cycle' })}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pb-3 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
        <div
          className="relative rounded-md border border-border/60 bg-background/65"
          data-testid="execution-graph-canvas"
          onClick={onClearSelection}
          style={{ width, height }}
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={width}
            height={height}
            aria-hidden="true"
          >
            <defs>
              {[EXECUTION_GRAPH_DEFAULT_EDGE_TONE, ...EXECUTION_GRAPH_EDGE_TONES].map(tone => (
                <marker
                  key={tone.id}
                  id={`subtask-graph-arrow-${tone.id}`}
                  markerWidth="7"
                  markerHeight="7"
                  refX="6"
                  refY="3.5"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M0,0 L7,3.5 L0,7 Z" className={tone.markerClass} />
                </marker>
              ))}
            </defs>
            {graphEdges.map((edge, edgeIndex) => {
              const from = nodeById.get(edge.from);
              const to = nodeById.get(edge.to);
              if (!from || !to) {
                return null;
              }
              const tone = getExecutionGraphEdgeTone(edge);
              const isSelected = isExecutionGraphEdgeSelected(edge, selectedNodeId);
              const x1 = paddingX + from.level * columnGap + nodeWidth;
              const y1 = paddingY + from.row * rowGap + nodeHeight / 2;
              const x2 = paddingX + to.level * columnGap;
              const y2 = paddingY + to.row * rowGap + nodeHeight / 2;
              const obstacles = graph.nodes
                .filter(node => node.id !== edge.from && node.id !== edge.to)
                .map(node => nodeRectById.get(node.id))
                .filter((rect): rect is ExecutionGraphRect => Boolean(rect));
              const visibleTone = isSelected ? tone : EXECUTION_GRAPH_DEFAULT_EDGE_TONE;
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  data-edge-from={edge.from}
                  data-edge-to={edge.to}
                  d={getExecutionGraphEdgePath({ x1, y1, x2, y2, edgeIndex, obstacles, bounds: routeBounds })}
                  className={cn(
                    'fill-none transition-opacity',
                    visibleTone.strokeClass,
                    selectedNodeId && !isSelected && 'opacity-70',
                    isSelected && 'opacity-100 drop-shadow-sm'
                  )}
                  strokeWidth={isSelected ? 2.3 : 1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  markerEnd={`url(#subtask-graph-arrow-${visibleTone.id})`}
                />
              );
            })}
          </svg>

          {graph.nodes.map(node => {
            const isSelected = node.id === selectedNodeId;
            const metricLabel = getExecutionGraphNodeMetricLabel(node, nowMs, t);

            return (
              <Tooltip key={node.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={t('tasks:subtasks.graphNodeAriaLabel', {
                      id: node.id,
                      title: node.title,
                      defaultValue: 'Show model output for {{id}} {{title}}',
                    })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectNode(node.id);
                    }}
                    className={cn(
                      'absolute flex h-[42px] w-[118px] flex-col justify-center rounded-md border px-2 text-left shadow-sm transition-all hover:shadow',
                      getExecutionGraphNodeClass(node.status),
                      isSelected && 'border-primary/70 bg-primary/10 ring-2 ring-primary/35'
                    )}
                    style={{
                      left: paddingX + node.level * columnGap,
                      top: paddingY + node.row * rowGap,
                    }}
                  >
                    <div className="truncate text-[11px] font-semibold tabular-nums">{node.id}</div>
                    {metricLabel && (
                      <div className="truncate text-[10px] opacity-80">
                        {metricLabel}
                      </div>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  <div className="text-xs font-medium">{node.id}</div>
                  <div className="text-xs text-muted-foreground">{node.title}</div>
                  {node.durationMs !== undefined && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {t('tasks:subtasks.graphNodeDurationTooltip', {
                        duration: formatExecutionDuration(node.durationMs),
                        source: node.timingSource === 'recorded'
                          ? t('tasks:subtasks.timingSourceRecorded', { defaultValue: 'recorded' })
                          : t('tasks:subtasks.timingSourceLogs', { defaultValue: 'from logs' }),
                        defaultValue: 'Duration {{duration}} · {{source}}',
                      })}
                    </div>
                  )}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>
    </section>
  );
}

interface WorkPackageFilePreview {
  subtaskId: string;
  subtaskTitle: string;
  filePath: string;
}

interface WorkPackageFileDiffDialogProps {
  preview: WorkPackageFilePreview | null;
  diff: string | null;
  isLoading: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
}

function getPatchLineClassName(line: string): string {
  if (line.startsWith('@@')) {
    return 'bg-warning/10 text-warning';
  }

  if (line.startsWith('+')) {
    return 'bg-success/10 text-success';
  }

  if (line.startsWith('-')) {
    return 'bg-destructive/10 text-destructive';
  }

  if (
    line.startsWith('diff --git')
    || line.startsWith('index ')
    || line.startsWith('--- ')
    || line.startsWith('+++ ')
    || line.startsWith('rename from ')
    || line.startsWith('rename to ')
    || line.startsWith('new file mode')
    || line.startsWith('deleted file mode')
    || line.startsWith('similarity index')
  ) {
    return 'text-muted-foreground';
  }

  return 'text-foreground';
}

function WorkPackageFileDiffDialog({
  preview,
  diff,
  isLoading,
  error,
  onOpenChange,
}: WorkPackageFileDiffDialogProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const hasPreview = diff !== null && diff.length > 0;

  return (
    <AlertDialog open={preview !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent className="flex max-h-[85vh] max-w-5xl flex-col overflow-hidden">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5 text-info" />
            {t('tasks:subtasks.fileDiffTitle', { defaultValue: 'File change preview' })}
          </AlertDialogTitle>
          <AlertDialogDescription className="font-mono text-xs break-all">
            {preview?.filePath ?? ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border/60 bg-background/70">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('tasks:subtasks.fileDiffLoading', { defaultValue: 'Loading file changes...' })}
            </div>
          ) : error ? (
            <div className="p-4 text-sm text-destructive">{error}</div>
          ) : hasPreview ? (
            <div className="min-w-full p-3 text-xs font-mono">
              {diff.split(/\r?\n/).map((line, lineIndex) => (
                <div
                  key={`${preview?.filePath ?? 'file'}-${lineIndex}`}
                  className={cn('whitespace-pre rounded-sm px-2 py-0.5', getPatchLineClassName(line))}
                >
                  {line || ' '}
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 text-sm text-muted-foreground">
              {t('tasks:subtasks.fileDiffEmpty', { defaultValue: 'No preview available for this file.' })}
            </div>
          )}
        </div>
        <AlertDialogFooter className="mt-4">
          <AlertDialogCancel>{t('common:buttons.close', { defaultValue: 'Close' })}</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
export function TaskSubtasks({ task }: TaskSubtasksProps) {
  const { t } = useTranslation(['tasks']);
  const progress = calculateProgress(task.subtasks);
  const layoutContainerRef = useRef<HTMLDivElement | null>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [layoutPreferences, setLayoutPreferences] = useState<TaskSubtasksLayoutPreferences>(readTaskSubtasksLayoutPreferences);
  const [activeResizeTarget, setActiveResizeTarget] = useState<TaskSubtasksResizeTarget>(null);
  const [deletingSubtaskId, setDeletingSubtaskId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [fileDiffPreview, setFileDiffPreview] = useState<WorkPackageFilePreview | null>(null);
  const [fileDiffContent, setFileDiffContent] = useState<string | null>(null);
  const [fileDiffError, setFileDiffError] = useState<string | null>(null);
  const [isLoadingFileDiff, setIsLoadingFileDiff] = useState(false);
  const isTaskRunning = task.status === 'in_progress' || task.executionProgress?.phase === 'coding';
  const { modelLogs } = useTaskModelLogs(task);
  const isDirectTask = isDirectModeTask(task);
  const splitConcurrentWorkPackageLogs = shouldSplitConcurrentWorkPackageLogs(task);
  const selectedGraphSubtask = useMemo(
    () => task.subtasks.find(subtask => subtask.id === selectedGraphNodeId) ?? null,
    [selectedGraphNodeId, task.subtasks]
  );
  const selectedScopedSubtask = splitConcurrentWorkPackageLogs && selectedGraphSubtask
    ? selectedGraphSubtask
    : null;
  const runtimeLogScope = useMemo<TaskRuntimeLogScope>(() => {
    if (selectedScopedSubtask) {
      return { type: 'work-item', workItemId: selectedScopedSubtask.id };
    }

    if (splitConcurrentWorkPackageLogs) {
      return { type: 'none' };
    }

    return { type: 'global' };
  }, [selectedScopedSubtask, splitConcurrentWorkPackageLogs]);
  const runtimeLogFocusTarget = useMemo<TaskRuntimeLogFocusTarget | null>(() => {
    if (!isDirectTask || !selectedGraphSubtask) {
      return null;
    }

    return {
      subtaskId: selectedGraphSubtask.id,
      title: selectedGraphSubtask.title,
      startedAt: selectedGraphSubtask.startedAt,
      directMode: true,
    };
  }, [isDirectTask, selectedGraphSubtask]);
  const runtimeLogTitle = selectedScopedSubtask
    ? t('tasks:subtasks.selectedWorkPackageModelOutput', {
        title: selectedScopedSubtask.title || selectedScopedSubtask.id,
        defaultValue: 'Model output · {{title}}',
      })
    : isDirectTask && selectedGraphSubtask
      ? t('tasks:subtasks.selectedTaskModelOutput', {
          title: selectedGraphSubtask.title || selectedGraphSubtask.id,
          defaultValue: 'Model output · {{title}}',
        })
      : undefined;
  const activeSubtaskIndex = resolveActiveSubtaskIndex({
    subtasks: task.subtasks,
    currentSubtask: task.executionProgress?.currentSubtask,
    isRunning: isTaskRunning,
    phase: task.executionProgress?.phase,
  });

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setExpandedIds(prev => {
      if (prev.size === task.subtasks.length) {
        return new Set();
      }
      return new Set(task.subtasks.map(s => s.id));
    });
  }, [task.subtasks]);

  const handleSelectGraphNode = useCallback((nodeId: string) => {
    setSelectedGraphNodeId(current => current === nodeId ? null : nodeId);
  }, []);

  const handleClearGraphSelection = useCallback(() => {
    setSelectedGraphNodeId(null);
  }, []);

  const handleResizeStart = useCallback((target: Exclude<TaskSubtasksResizeTarget, null>) => (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setActiveResizeTarget(target);
  }, []);

  useEffect(() => {
    if (activeResizeTarget !== null) {
      return;
    }

    try {
      window.localStorage.setItem(TASK_SUBTASKS_LAYOUT_STORAGE_KEY, JSON.stringify(layoutPreferences));
    } catch {
      // Ignore storage failures; resizing should still work for the current session.
    }
  }, [activeResizeTarget, layoutPreferences]);

  useEffect(() => {
    if (!activeResizeTarget) {
      return;
    }

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = activeResizeTarget === 'subtasks' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (event: PointerEvent) => {
      if (activeResizeTarget === 'subtasks') {
        const container = layoutContainerRef.current;
        if (!container) {
          return;
        }

        const rect = container.getBoundingClientRect();
        if (rect.width <= 0) {
          return;
        }

        const nextWidth = ((event.clientX - rect.left) / rect.width) * 100;
        setLayoutPreferences(current => ({
          ...current,
          subtasksWidthPercent: clampLayoutPercent(
            nextWidth,
            MIN_SUBTASKS_WIDTH_PERCENT,
            MAX_SUBTASKS_WIDTH_PERCENT
          ),
        }));
        return;
      }

      const rightPane = rightPaneRef.current;
      if (!rightPane) {
        return;
      }

      const rect = rightPane.getBoundingClientRect();
      if (rect.height <= 0) {
        return;
      }

      const nextHeight = ((event.clientY - rect.top) / rect.height) * 100;
      setLayoutPreferences(current => ({
        ...current,
        graphHeightPercent: clampLayoutPercent(
          nextHeight,
          MIN_GRAPH_HEIGHT_PERCENT,
          MAX_GRAPH_HEIGHT_PERCENT
        ),
      }));
    };

    const handlePointerEnd = () => {
      setActiveResizeTarget(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [activeResizeTarget]);

  const handleDeleteSubtask = useCallback(async (subtaskId: string, title: string) => {
    if (isTaskRunning || deletingSubtaskId) return;

    const confirmed = window.confirm(t('tasks:subtasks.deleteConfirm', {
      title,
      defaultValue: 'Delete subtask "{{title}}"? This removes it from the implementation plan.'
    }));
    if (!confirmed) return;

    setDeletingSubtaskId(subtaskId);
    setDeleteError(null);

    const result = await deleteSubtask(task.id, subtaskId, task.projectId);
    if (result.success) {
      setExpandedIds(prev => {
        const next = new Set(prev);
        next.delete(subtaskId);
        return next;
      });
    } else {
      setDeleteError(result.error || t('tasks:subtasks.deleteFailed', 'Failed to delete subtask'));
    }

    setDeletingSubtaskId(null);
  }, [deletingSubtaskId, isTaskRunning, t, task.id, task.projectId]);

  const handleOpenFileDiff = useCallback(async (subtaskId: string, subtaskTitle: string, filePath: string) => {
    setFileDiffPreview({ subtaskId, subtaskTitle, filePath });
    setFileDiffContent(null);
    setFileDiffError(null);
    setIsLoadingFileDiff(true);

    try {
      const result = await window.electronAPI.getWorktreeFileDiff(task.id, filePath, task.projectId);
      if (result.success) {
        const previewContent = result.data ?? '';
        setFileDiffContent(previewContent.trim().length > 0
          ? previewContent
          : t('tasks:subtasks.fileDiffUnavailableForFile', {
              file: filePath,
              defaultValue: 'No diff or current file content found for {{file}}. The file may have been deleted or no longer exists in the task worktree.',
            }));
      } else {
        setFileDiffError(result.error || t('tasks:subtasks.fileDiffFailed', { defaultValue: 'Failed to load file changes' }));
      }
    } catch (error) {
      setFileDiffError(error instanceof Error
        ? error.message
        : t('tasks:subtasks.fileDiffFailed', { defaultValue: 'Failed to load file changes' }));
    } finally {
      setIsLoadingFileDiff(false);
    }
  }, [task.id, task.projectId, t]);

  const handleFileDiffOpenChange = useCallback((open: boolean) => {
    if (open) {
      return;
    }

    setFileDiffPreview(null);
    setFileDiffContent(null);
    setFileDiffError(null);
    setIsLoadingFileDiff(false);
  }, []);

  const allExpanded = expandedIds.size === task.subtasks.length && task.subtasks.length > 0;

  return (
    <>
      <div ref={layoutContainerRef} className="flex h-full min-h-0 w-full overflow-hidden">
      <div
        className="min-w-[20rem] shrink-0 overflow-y-auto overflow-x-hidden p-4 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
        style={{ flexBasis: `${layoutPreferences.subtasksWidthPercent}%` }}
      >
        <div className="space-y-3">
          {task.subtasks.length === 0 ? (
            <div className="text-center py-12">
              <ListChecks className="h-10 w-10 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground mb-1">
                {t('tasks:subtasks.emptyTitle', 'No subtasks defined')}
              </p>
              <p className="text-xs text-muted-foreground/70">
                {t('tasks:subtasks.emptyDescription', 'Implementation subtasks will appear here after planning')}
              </p>
            </div>
          ) : (
            <>
              {/* Progress summary */}
              <div className="flex items-center justify-between text-xs text-muted-foreground pb-2 border-b border-border/50">
                <span>
                  {t('tasks:subtasks.completedSummary', {
                    completed: task.subtasks.filter(c => c.status === 'completed').length,
                    total: task.subtasks.length,
                    defaultValue: '{{completed}} of {{total}} completed'
                  })}
                </span>
                <div className="flex items-center gap-2">
                  <span className="tabular-nums">{progress}%</span>
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-secondary"
                  >
                    <ChevronsUpDown className="h-3 w-3" />
                    {allExpanded ? t('tasks:subtasks.collapseAll', 'Collapse all') : t('tasks:subtasks.expandAll', 'Expand all')}
                  </button>
                </div>
              </div>
              {deleteError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {deleteError}
                </div>
              )}
              {task.subtasks.map((subtask, index) => {
            const isExpanded = expandedIds.has(subtask.id);
            const completionSummary = subtask.status === 'completed' ? subtask.completionSummary?.trim() : undefined;
            const isDerivedInProgress = isTaskRunning &&
              activeSubtaskIndex === index &&
              subtask.status !== 'completed' &&
              subtask.status !== 'failed';
            const isInProgress = subtask.status === 'in_progress' || isDerivedInProgress;
            const hasDetails = (subtask.description && subtask.description !== subtask.title) ||
              completionSummary ||
              (subtask.files && subtask.files.length > 0) ||
              subtask.verification;

            return (
              <div
                key={subtask.id}
                className={cn(
                  'rounded-xl border border-border bg-secondary/30 transition-all duration-200 hover:bg-secondary/50 overflow-hidden',
                  isInProgress && 'border-[var(--info)]/50 bg-[var(--info-light)] ring-1 ring-info/20',
                  subtask.status === 'completed' && 'border-[var(--success)]/50 bg-[var(--success-light)]',
                  subtask.status === 'failed' && 'border-[var(--error)]/50 bg-[var(--error-light)]'
                )}
              >
                {/* Collapsed header — always visible */}
                <div className="flex items-center gap-1 p-3">
                  <button
                    type="button"
                    onClick={() => toggleExpand(subtask.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <div className="shrink-0">
                      {getSubtaskStatusIcon(subtask.status, isInProgress)}
                    </div>
                    <span className={cn(
                      'text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0',
                      subtask.status === 'completed' ? 'bg-success/20 text-success' :
                      isInProgress ? 'bg-info/20 text-info' :
                      subtask.status === 'failed' ? 'bg-destructive/20 text-destructive' :
                      'bg-muted text-muted-foreground'
                    )}>
                      #{index + 1}
                    </span>
                    <span className="text-sm font-medium text-foreground flex-1 min-w-0 line-clamp-2">
                      {subtask.title || t('tasks:subtasks.untitled')}
                    </span>
                    {hasDetails && (
                      <ChevronRight className={cn(
                        'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                        isExpanded && 'rotate-90'
                      )} />
                    )}
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => handleDeleteSubtask(
                          subtask.id,
                          subtask.title || t('tasks:subtasks.untitled')
                        )}
                        disabled={isTaskRunning || deletingSubtaskId !== null}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={t('tasks:subtasks.deleteAriaLabel', {
                          title: subtask.title || t('tasks:subtasks.untitled'),
                          defaultValue: 'Delete subtask {{title}}'
                        })}
                      >
                        {deletingSubtaskId === subtask.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      {isTaskRunning
                        ? t('tasks:subtasks.deleteDisabledRunning', 'Stop the task before deleting subtasks')
                        : t('tasks:subtasks.deleteTooltip', 'Delete subtask')}
                    </TooltipContent>
                  </Tooltip>
                </div>

                {/* Expanded details */}
                {isExpanded && hasDetails && (
                  <div className="px-3 pb-3 pt-0 ml-6 border-t border-border/30 mt-0">
                    {subtask.description && subtask.description !== subtask.title && (
                      <p className="mt-2 text-xs text-muted-foreground break-words whitespace-pre-wrap">
                        {subtask.description}
                      </p>
                    )}
                    {completionSummary && (
                      <div className="mt-2 rounded-md border border-success/20 bg-success/10 px-2.5 py-2">
                        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-success">
                          <ClipboardCheck className="h-3.5 w-3.5" />
                          {t('tasks:subtasks.completionSummary', 'Completion summary')}
                        </div>
                        <CompletionSummaryTable summary={completionSummary} t={t} />
                      </div>
                    )}
                    {subtask.files && subtask.files.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {subtask.files.map((file) => (
                          <Tooltip key={file}>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleOpenFileDiff(
                                    subtask.id,
                                    subtask.title || subtask.id,
                                    file
                                  );
                                }}
                                className="inline-flex items-center rounded-md border border-transparent bg-secondary px-2.5 py-0.5 text-xs font-semibold font-mono text-secondary-foreground transition-colors hover:bg-secondary/80 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                                aria-label={t('tasks:subtasks.previewFileDiffAriaLabel', {
                                  file,
                                  title: subtask.title || subtask.id,
                                  defaultValue: 'Preview changes for {{file}} in {{title}}',
                                })}
                              >
                                <FileCode className="mr-1 h-3 w-3" />
                                {file.split('/').pop()}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="font-mono text-xs">
                              {file}
                            </TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                    )}
                    {subtask.verification && (
                      <div className="mt-2 text-xs text-muted-foreground/80">
                        <span className="font-medium">{t('tasks:subtasks.verification', 'Verification:')}</span>{' '}
                        {subtask.verification.type}
                        {subtask.verification.run && (
                          <code className="ml-1 text-[11px] bg-muted px-1 py-0.5 rounded">{subtask.verification.run}</code>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
              })}
            </>
          )}
        </div>
      </div>
      <PaneResizeHandle
        orientation="vertical"
        isDragging={activeResizeTarget === 'subtasks'}
        label={t('tasks:subtasks.resizeSubtasksPane', { defaultValue: 'Resize subtasks pane' })}
        onPointerDown={handleResizeStart('subtasks')}
      />
      <div ref={rightPaneRef} className="flex min-h-0 min-w-[28rem] flex-1 flex-col bg-muted/10">
        <ExecutionGraphPanel
          task={task}
          modelLogs={modelLogs}
          selectedNodeId={selectedGraphNodeId}
          onSelectNode={handleSelectGraphNode}
          onClearSelection={handleClearGraphSelection}
          heightPercent={layoutPreferences.graphHeightPercent}
        />
        <PaneResizeHandle
          orientation="horizontal"
          isDragging={activeResizeTarget === 'graph'}
          label={t('tasks:subtasks.resizeGraphPane', { defaultValue: 'Resize execution graph pane' })}
          onPointerDown={handleResizeStart('graph')}
        />
        <TaskRuntimeLogs
          task={task}
          modelLogs={modelLogs}
          scope={runtimeLogScope}
          focusTarget={runtimeLogFocusTarget}
          title={runtimeLogTitle}
          className="min-h-0 flex-1 border-l-0"
        />
      </div>
    </div>
      <WorkPackageFileDiffDialog
        preview={fileDiffPreview}
        diff={fileDiffContent}
        isLoading={isLoadingFileDiff}
        error={fileDiffError}
        onOpenChange={handleFileDiffOpenChange}
      />
    </>
  );
}
