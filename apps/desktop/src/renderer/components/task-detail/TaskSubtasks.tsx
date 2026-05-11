import { useState, useCallback } from 'react';
import { CheckCircle2, Clock, XCircle, AlertCircle, ListChecks, FileCode, ChevronRight, ChevronsUpDown, Loader2, Trash2, ClipboardCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn, calculateProgress } from '../../lib/utils';
import { resolveActiveSubtaskIndex } from '../../lib/subtask-progress';
import { deleteSubtask } from '../../stores/task-store';
import type { Task } from '../../../shared/types';
import { TaskRuntimeLogs } from './TaskRuntimeLogs';

interface TaskSubtasksProps {
  task: Task;
}

interface CompletionSummaryRow {
  label: string;
  content: string;
}

type TranslationFn = ReturnType<typeof useTranslation>['t'];

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
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())
    .filter(Boolean);
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
  const match = SUMMARY_LABEL_PATTERNS.find(item => item.pattern.test(normalized));
  return match ? getSummaryLabel(match.key, t) : normalized;
}

function parseMarkdownSummaryTable(summary: string, t: TranslationFn): CompletionSummaryRow[] {
  const lines = summary.split(/\r?\n/).map(line => line.trim());
  const separatorIndex = lines.findIndex(isMarkdownTableSeparator);
  if (separatorIndex <= 0) {
    return [];
  }

  const tableEndIndex = lines.findIndex((line, index) =>
    index > separatorIndex && line && !line.trim().startsWith('|')
  );
  const effectiveTableEnd = tableEndIndex === -1 ? lines.length : tableEndIndex;
  const beforeTable = lines
    .slice(0, Math.max(0, separatorIndex - 1))
    .map(stripSummaryMarkup)
    .filter(Boolean);
  const afterTable = lines
    .slice(effectiveTableEnd)
    .map(stripSummaryMarkup)
    .filter(Boolean);

  const rows = lines
    .slice(separatorIndex + 1, effectiveTableEnd)
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

function CompletionSummaryTable({ summary, t }: { summary: string; t: TranslationFn }) {
  const rows = buildCompletionSummaryRows(summary, t);

  return (
    <div className="overflow-hidden rounded-md border border-success/20 bg-background/60">
      <table className="w-full border-collapse text-xs">
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.label}-${index}`} className="border-b border-success/10 last:border-b-0">
              <th className="w-28 bg-success/10 px-2.5 py-2 text-left align-top font-medium text-success">
                {row.label}
              </th>
              <td className="px-2.5 py-2 align-top text-foreground/85">
                <div className="whitespace-pre-wrap break-words leading-relaxed">
                  {row.content}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

export function TaskSubtasks({ task }: TaskSubtasksProps) {
  const { t } = useTranslation(['tasks']);
  const progress = calculateProgress(task.subtasks);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [deletingSubtaskId, setDeletingSubtaskId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const isTaskRunning = task.status === 'in_progress' || task.executionProgress?.phase === 'coding';
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

  const handleDeleteSubtask = useCallback(async (subtaskId: string, title: string) => {
    if (isTaskRunning || deletingSubtaskId) return;

    const confirmed = window.confirm(t('tasks:subtasks.deleteConfirm', {
      title,
      defaultValue: 'Delete subtask "{{title}}"? This removes it from the implementation plan.'
    }));
    if (!confirmed) return;

    setDeletingSubtaskId(subtaskId);
    setDeleteError(null);

    const result = await deleteSubtask(task.id, subtaskId);
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
  }, [deletingSubtaskId, isTaskRunning, t, task.id]);

  const allExpanded = expandedIds.size === task.subtasks.length && task.subtasks.length > 0;

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden">
      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
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
            const hasDetails = (subtask.description && subtask.description !== subtask.title) ||
              completionSummary ||
              (subtask.files && subtask.files.length > 0) ||
              subtask.verification;
            const isDerivedInProgress = isTaskRunning &&
              activeSubtaskIndex === index &&
              subtask.status !== 'completed' &&
              subtask.status !== 'failed';
            const isInProgress = subtask.status === 'in_progress' || isDerivedInProgress;

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
                              <Badge
                                variant="secondary"
                                className="text-xs font-mono cursor-help"
                              >
                                <FileCode className="mr-1 h-3 w-3" />
                                {file.split('/').pop()}
                              </Badge>
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
      <TaskRuntimeLogs task={task} className="w-[64%] min-w-[520px] max-w-[900px] shrink-0" />
    </div>
  );
}
