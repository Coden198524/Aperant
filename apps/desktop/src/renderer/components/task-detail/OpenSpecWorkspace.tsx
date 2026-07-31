import { useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertCircle,
  Archive,
  Ban,
  Bot,
  CheckCircle2,
  CircleDot,
  FileCode2,
  GitCompare,
  History,
  Loader2,
  MessageSquareText,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
} from 'lucide-react';

import type {
  OpenSpecAction,
  OpenSpecArtifactSnapshot,
  OpenSpecBoardSnapshot,
  OpenSpecPlanningFileChange,
  Task,
} from '../../../shared/types';
import {
  formatOpenSpecStageDuration,
  summarizeOpenSpecStageTimings,
} from '../../../shared/utils/openspec-stage-timing';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Progress } from '../ui/progress';
import { ResizablePanels } from '../ui/resizable-panels';
import { ScrollArea } from '../ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Textarea } from '../ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { OpenSpecInteractionPanel } from './OpenSpecInteractionPanel';
import { useOpenSpecWorkspace } from './hooks/useOpenSpecWorkspace';
import {
  isOpenSpecActionDisabled,
  resolveOpenSpecAutomaticAction,
} from './openSpec-workspace-view-model';
import { formatLogMarkdownForDisplay } from './task-log-display';

const ACTIVE_RUN_STATES = new Set([
  'queued',
  'preparing',
  'running',
  'awaiting_user',
  'cancelling',
]);

const ACTION_TRANSLATION_KEYS: Record<OpenSpecAction, string> = {
  explore: 'explore',
  propose: 'propose',
  apply: 'apply',
  update: 'update',
  sync: 'sync',
  archive: 'archive',
  new: 'new',
  continue: 'continue',
  ff: 'ff',
  verify: 'verify',
  'bulk-archive': 'bulkArchive',
  onboard: 'onboard',
};

function actionLabel(t: TFunction, action: OpenSpecAction): string {
  return t(`tasks:openSpec.actions.${ACTION_TRANSLATION_KEYS[action]}`);
}

function diffBaseLabel(
  t: TFunction,
  base: 'git' | 'action-snapshot' | 'unavailable' | undefined,
): string {
  switch (base) {
    case 'git':
      return t('tasks:openSpec.preview.diffBase.git');
    case 'action-snapshot':
      return t('tasks:openSpec.preview.diffBase.actionSnapshot');
    case 'unavailable':
    case undefined:
      return t('tasks:openSpec.preview.diffBase.unavailable');
  }
}

type ArtifactMarkdownKind =
  | 'proposal'
  | 'specs'
  | 'design'
  | 'tasks'
  | 'default';

function artifactMarkdownKind(
  artifact: OpenSpecArtifactSnapshot | null,
): ArtifactMarkdownKind {
  const id = artifact?.id.toLowerCase();
  const outputPath = artifact?.outputPath.toLowerCase() ?? '';
  if (id === 'proposal' || outputPath.endsWith('proposal.md')) return 'proposal';
  if (id === 'specs' || outputPath.startsWith('specs/')) return 'specs';
  if (id === 'design' || outputPath.endsWith('design.md')) return 'design';
  if (id === 'tasks' || outputPath.endsWith('tasks.md')) return 'tasks';
  return 'default';
}

function localizedNextStep(
  t: TFunction,
  snapshot: OpenSpecBoardSnapshot | null,
): string | null {
  if (!snapshot) return null;
  if (snapshot.archived) {
    return t('tasks:openSpec.board.archivedNext');
  }
  if (!snapshot.initialized) {
    return t('tasks:openSpec.board.initializeNext');
  }
  if (!snapshot.changeName) {
    return t('tasks:openSpec.board.selectChangeNext');
  }
  return snapshot.nextSteps[0] ?? null;
}

function buildMarkdownComponents(
  t: TFunction,
  kind: ArtifactMarkdownKind,
): Components {
  const headingAccent = {
    proposal: 'border-blue-500/60',
    specs: 'border-violet-500/60',
    design: 'border-cyan-500/60',
    tasks: 'border-emerald-500/60',
    default: 'border-primary/50',
  }[kind];
  return {
    h1: ({ children }) => (
      <h1
        className={cn(
          'mb-5 mt-1 border-b-2 pb-3 text-2xl font-bold tracking-tight text-foreground',
          headingAccent,
        )}
      >
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2
        className={cn(
          'mb-3 mt-8 border-l-4 pl-3 text-xl font-semibold tracking-tight text-foreground',
          headingAccent,
        )}
      >
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-2 mt-6 text-lg font-semibold text-foreground/95">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-2 mt-5 text-sm font-semibold uppercase tracking-wide text-foreground/85">
        {children}
      </h4>
    ),
    p: ({ children }) => (
      <p className="my-3 leading-7 text-foreground/85">{children}</p>
    ),
    ul: ({ children, className }) => (
      <ul
        className={cn(
          'my-3 list-disc space-y-1.5 pl-6 marker:text-primary/70',
          className?.includes('contains-task-list') && 'list-none space-y-2 pl-0',
        )}
      >
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-3 list-decimal space-y-1.5 pl-6 marker:font-semibold marker:text-primary/70">
        {children}
      </ol>
    ),
    li: ({ children, className }) => (
      <li
        className={cn(
          'pl-1 leading-6 text-foreground/85',
          kind === 'tasks' &&
            className?.includes('task-list-item') &&
            [
              'flex items-start gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2',
              'has-[input:checked]:border-emerald-500/35',
              'has-[input:checked]:bg-emerald-500/10',
              'has-[input:checked]:text-emerald-800',
              'dark:has-[input:checked]:text-emerald-200',
            ],
        )}
      >
        {children}
      </li>
    ),
    input: ({ type, checked, disabled, className }) => (
      <input
        type={type}
        checked={checked}
        disabled={disabled}
        readOnly
        className={cn(
          type === 'checkbox' &&
            'mt-1 h-4 w-4 shrink-0 accent-emerald-600 opacity-100 disabled:opacity-100 dark:accent-emerald-400',
          className,
        )}
      />
    ),
    blockquote: ({ children }) => (
      <blockquote
        className={cn(
          'my-4 rounded-r-lg border-l-4 bg-muted/45 px-4 py-2 text-muted-foreground',
          headingAccent,
        )}
      >
        {children}
      </blockquote>
    ),
    pre: ({ children }) => (
      <pre className="my-4 max-w-full overflow-x-auto rounded-lg border border-slate-700 bg-slate-950 p-4 shadow-sm">
        {children}
      </pre>
    ),
    code: ({ children, className }) => className ? (
      <code className={cn('font-mono text-xs leading-6 text-slate-100', className)}>
        {children}
      </code>
    ) : (
      <code className="rounded-md border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[0.88em] text-foreground">
        {children}
      </code>
    ),
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto rounded-lg border border-border shadow-sm">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-r border-border bg-muted/80 px-3 py-2.5 text-left font-semibold text-foreground last:border-r-0">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-b border-r border-border/70 px-3 py-2.5 align-top text-foreground/80 last:border-r-0">
        {children}
      </td>
    ),
    a: ({ children, href }) => (
      <span
        className="cursor-not-allowed font-medium text-primary underline decoration-dotted underline-offset-2"
        title={href
          ? t('tasks:openSpec.preview.externalLinkBlocked', { href })
          : undefined}
      >
        {children}
      </span>
    ),
    img: ({ alt }) => (
      <span className="inline-flex rounded border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
        {t('tasks:openSpec.preview.remoteImageBlocked', {
          alt: alt ? `: ${alt}` : '',
        })}
      </span>
    ),
  };
}

function artifactStatusVisual(artifact: OpenSpecArtifactSnapshot): {
  labelKey: string;
  icon: typeof CheckCircle2;
  iconClassName: string;
} {
  if (artifact.inProgress) {
    return {
      labelKey: 'inProgress',
      icon: Loader2,
      iconClassName: 'animate-spin text-blue-500',
    };
  }
  switch (artifact.status) {
    case 'done':
      return {
        labelKey: 'complete',
        icon: CheckCircle2,
        iconClassName: 'text-emerald-500',
      };
    case 'ready':
      return {
        labelKey: 'ready',
        icon: CircleDot,
        iconClassName: 'text-blue-500',
      };
    case 'blocked':
      return {
        labelKey: 'waiting',
        icon: Ban,
        iconClassName: 'text-muted-foreground',
      };
    case 'unknown':
      return {
        labelKey: 'unsupported',
        icon: AlertCircle,
        iconClassName: 'text-amber-500',
      };
  }
}

function ArtifactNavigationItem({
  artifact,
  selected,
  disabled = false,
  onSelect,
}: {
  artifact: OpenSpecArtifactSnapshot;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('tasks');
  const visual = artifactStatusVisual(artifact);
  const StatusIcon = visual.icon;
  const checklist = artifact.checklist;
  return (
    <button
      type="button"
      data-testid={`openspec-artifact-${artifact.id}`}
      aria-label={t('openSpec.artifact.openAria', { id: artifact.id })}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      title={artifact.outputPath}
      className={cn(
        'group relative w-full rounded-lg border px-3 py-2.5 text-left transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled && 'cursor-not-allowed opacity-50',
        selected
          ? 'border-primary/40 bg-primary/[0.07] shadow-sm'
          : 'border-transparent bg-background/55 hover:border-border hover:bg-background',
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 rounded-full bg-background p-1 shadow-sm ring-1 ring-border">
          <StatusIcon className={cn('h-3.5 w-3.5', visual.iconClassName)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{artifact.id}</span>
            {artifact.blocksApply && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                title={t('openSpec.artifact.requiredBeforeImplementation')}
              />
            )}
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
              {t(`openSpec.artifact.status.${visual.labelKey}`)}
            </span>
          </div>
          {artifact.description && (
            <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
              {artifact.description}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
            {artifact.existingOutputPaths.length > 0 && (
              <span>
                {t('openSpec.artifact.documentCount', {
                  count: artifact.existingOutputPaths.length,
                })}
              </span>
            )}
            {artifact.metrics?.requirements !== undefined && (
              <span>
                {t('openSpec.artifact.requirementCount', {
                  count: artifact.metrics.requirements,
                })}
              </span>
            )}
            {artifact.metrics?.scenarios !== undefined && (
              <span>
                {t('openSpec.artifact.scenarioCount', {
                  count: artifact.metrics.scenarios,
                })}
              </span>
            )}
          </div>
          {checklist && (
            <div className="mt-2 flex items-center gap-2">
              <Progress
                value={checklist.total > 0 ? (checklist.completed / checklist.total) * 100 : 0}
                className="h-1 flex-1"
              />
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {checklist.completed}/{checklist.total}
              </span>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function planningChangeVisual(kind: OpenSpecPlanningFileChange['kind']): {
  containerClassName: string;
  badgeClassName: string;
  pathClassName: string;
} {
  switch (kind) {
    case 'created':
      return {
        containerClassName:
          'border-emerald-500/35 bg-emerald-500/[0.05] hover:bg-emerald-500/[0.09]',
        badgeClassName:
          'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        pathClassName: 'text-emerald-800 dark:text-emerald-200',
      };
    case 'modified':
      return {
        containerClassName:
          'border-sky-500/35 bg-sky-500/[0.05] hover:bg-sky-500/[0.09]',
        badgeClassName:
          'border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300',
        pathClassName: 'text-sky-800 dark:text-sky-200',
      };
    case 'deleted':
      return {
        containerClassName:
          'border-rose-500/35 bg-rose-500/[0.05] hover:bg-rose-500/[0.09]',
        badgeClassName:
          'border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300',
        pathClassName: 'text-rose-800 dark:text-rose-200',
      };
  }
}

function planningPatchLineClassName(line: string): string {
  if (line.startsWith('@@')) {
    return 'bg-sky-400/[0.08] text-sky-300';
  }
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return 'bg-emerald-400/[0.08] text-emerald-300';
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return 'bg-rose-400/[0.08] text-rose-300';
  }
  if (line.startsWith('+++') || line.startsWith('---')) {
    return 'text-slate-400';
  }
  return 'text-slate-200';
}

function PlanningReviewPatch({ patch }: { patch: string }) {
  const lines = patch.replace(/\r\n?/g, '\n').split('\n');
  const occurrences = new Map<string, number>();
  const keyedLines = lines.map((line) => {
    const occurrence = (occurrences.get(line) ?? 0) + 1;
    occurrences.set(line, occurrence);
    return {
      key: `${line}\0${occurrence}`,
      line,
    };
  });
  return (
    <pre
      className="max-h-[58vh] overflow-auto bg-[#0b1017] p-3 font-mono text-[11px] leading-5"
      data-testid="openspec-planning-review-diff"
    >
      {keyedLines.map(({ key, line }) => (
        <span
          key={key}
          className={cn(
            'block min-h-5 whitespace-pre-wrap break-words px-1',
            planningPatchLineClassName(line),
          )}
          data-diff-line={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'added'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'deleted'
                : line.startsWith('@@')
                  ? 'hunk'
                  : 'context'
          }
        >
          {line || '\u00a0'}
        </span>
      ))}
    </pre>
  );
}

type ConsoleTone =
  | 'text'
  | 'tool'
  | 'toolCommand'
  | 'toolRead'
  | 'toolWrite'
  | 'warning'
  | 'error'
  | 'success'
  | 'heading'
  | 'muted';

function consoleTone(line: string): ConsoleTone {
  const value = line.trim();
  if (!value) return 'muted';
  const tool = value.match(
    /^\[(Bash|Shell|PowerShell|Exec|Read|Glob|Grep|Search|WebSearch|WebFetch|Write|Edit|MultiEdit|ApplyPatch|NotebookEdit|Tool|Task|Skill|TodoWrite|AskUserQuestion)\]/i,
  )?.[1];
  if (tool) {
    return /\b(?:done|complete|completed|succeeded)\b|(?:成功|已完成|完成)/i.test(value)
      ? 'success'
      : /^(?:Write|Edit|MultiEdit|ApplyPatch|NotebookEdit)$/i.test(tool)
        ? 'toolWrite'
        : /^(?:Bash|Shell|PowerShell|Exec)$/i.test(tool)
          ? 'toolCommand'
          : /^(?:Read|Glob|Grep|Search|WebSearch|WebFetch)$/i.test(tool)
            ? 'toolRead'
            : 'tool';
  }
  if (
    /\b(?:error|failed|failure|denied|blocked|exception|fatal)\b|(?:错误|失败|拒绝|阻塞|异常|致命)/i
      .test(value)
  ) {
    return 'error';
  }
  if (
    /\b(?:retry|retrying|temporarily unavailable|overloaded|rate limit)\b|(?:重试|暂时不可用|临时不可用|过载|限流|速率限制)/i
      .test(value)
  ) {
    return 'warning';
  }
  if (/^(?:✓|✔|success\b|completed\b|done\b|成功|已完成|完成)/i.test(value)) {
    return 'success';
  }
  if (/^#{1,6}\s/.test(value) || /^\*\*[^*]+\*\*$/.test(value)) return 'heading';
  return 'text';
}

function consoleToneClassName(tone: ConsoleTone): string {
  switch (tone) {
    case 'tool':
      return 'border-teal-400/50 bg-teal-400/[0.08] text-teal-200';
    case 'toolCommand':
      return 'border-violet-400/55 bg-violet-400/[0.09] text-violet-200';
    case 'toolRead':
      return 'border-sky-400/50 bg-sky-400/[0.08] text-sky-200';
    case 'toolWrite':
      return 'border-fuchsia-400/55 bg-fuchsia-400/[0.09] text-fuchsia-200';
    case 'warning':
      return 'border-amber-300/40 bg-amber-300/[0.06] text-amber-200';
    case 'error':
      return 'border-rose-400/50 bg-rose-400/[0.08] text-rose-300';
    case 'success':
      return 'border-emerald-400/40 bg-emerald-400/[0.06] text-emerald-300';
    case 'heading':
      return 'border-amber-300/40 text-amber-200';
    case 'muted':
      return 'border-transparent text-slate-600';
    case 'text':
      return 'border-transparent text-slate-200';
  }
}

function isToolConsoleTone(tone: ConsoleTone): boolean {
  return (
    tone === 'tool' ||
    tone === 'toolCommand' ||
    tone === 'toolRead' ||
    tone === 'toolWrite'
  );
}

function buildActivityMarkdownComponents(t: TFunction): Components {
  const renderParagraph = (children: React.ReactNode) => {
    if (typeof children !== 'string' || !children.includes('\n')) {
      const tone = typeof children === 'string' ? consoleTone(children) : 'text';
      return (
        <p
          data-console-kind={isToolConsoleTone(tone) ? 'tool-command' : 'log-content'}
          data-console-tone={tone}
          className={cn(
            'my-1 whitespace-pre-wrap break-words border-l-2 px-2 py-0.5 leading-relaxed',
            consoleToneClassName(tone),
            isToolConsoleTone(tone) && 'font-mono font-medium',
          )}
        >
          {children}
        </p>
      );
    }

    let offset = 0;
    return (
      <p className="my-1">
        {children.split('\n').map((line) => {
          const key = `${offset}:${line.slice(0, 24)}`;
          offset += line.length + 1;
          const tone = consoleTone(line);
          return (
            <span
              key={key}
              data-console-kind={
                isToolConsoleTone(tone) ? 'tool-command' : 'log-content'
              }
              data-console-tone={tone}
              className={cn(
                'block min-h-[1.15rem] whitespace-pre-wrap break-words border-l-2 px-2 py-px',
                consoleToneClassName(tone),
                isToolConsoleTone(tone) && 'font-mono font-medium',
              )}
            >
              {line || '\u00a0'}
            </span>
          );
        })}
      </p>
    );
  };

  return {
    h1: ({ children }) => (
      <h1 className="mb-2 mt-3 border-l-2 border-amber-300/40 px-2 text-base font-semibold text-amber-100">
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className="mb-2 mt-3 border-l-2 border-amber-300/40 px-2 text-sm font-semibold text-amber-100">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-1.5 mt-2.5 border-l-2 border-amber-300/40 px-2 text-[13px] font-semibold text-amber-200">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-1 mt-2 border-l-2 border-amber-300/40 px-2 text-xs font-semibold text-amber-200">
        {children}
      </h4>
    ),
    p: ({ children }) => renderParagraph(children),
    ul: ({ children }) => (
      <ul className="my-1.5 ml-6 list-disc space-y-1 pr-2 text-slate-300 marker:text-sky-300">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="my-1.5 ml-6 list-decimal space-y-1 pr-2 text-slate-300 marker:text-sky-300">
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="pl-1 leading-relaxed">{children}</li>,
    strong: ({ children }) => (
      <strong className="font-semibold text-slate-100">{children}</strong>
    ),
    em: ({ children }) => <em className="text-slate-400">{children}</em>,
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-2 border-sky-400/40 bg-sky-400/[0.05] py-1 pl-3 pr-2 text-slate-300">
        {children}
      </blockquote>
    ),
    code: ({ children, className }) => className ? (
      <code
        className={cn(
          'block whitespace-pre font-mono text-[11px] leading-relaxed text-slate-200',
          className,
        )}
      >
        {children}
      </code>
    ) : (
      <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-[0.9em] text-sky-200">
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="my-2 max-w-full overflow-x-auto rounded-md border border-slate-700 bg-slate-950/70 p-2.5">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="my-2 max-w-full overflow-x-auto rounded-md border border-slate-700">
        <table className="w-full border-collapse text-[11px] text-slate-300">
          {children}
        </table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-r border-slate-700 bg-slate-800/80 px-2 py-1.5 text-left font-semibold text-slate-100 last:border-r-0">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border-b border-r border-slate-800 px-2 py-1.5 align-top last:border-r-0">
        {children}
      </td>
    ),
    hr: () => <hr className="my-3 border-slate-700" />,
    a: ({ children, href }) => (
      <span
        className="cursor-not-allowed text-sky-300 underline decoration-dotted"
        title={href
          ? t('tasks:openSpec.preview.externalLinkBlocked', { href })
          : undefined}
      >
        {children}
      </span>
    ),
    img: ({ alt }) => (
      <span className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-400">
        {t('tasks:openSpec.preview.remoteImageBlocked', {
          alt: alt ? `: ${alt}` : '',
        })}
      </span>
    ),
  };
}

export function OpenSpecWorkspace({ task }: { task: Task }) {
  const { t } = useTranslation(['tasks', 'common']);
  const workspace = useOpenSpecWorkspace(task);
  const previewKind = artifactMarkdownKind(workspace.selectedArtifact);
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(t, previewKind),
    [previewKind, t],
  );
  const activityMarkdownComponents = useMemo(
    () => buildActivityMarkdownComponents(t),
    [t],
  );
  const [previewTab, setPreviewTab] = useState('rendered');
  const [activityTab, setActivityTab] = useState('activity');
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [actionInput, setActionInput] = useState('');
  const [planningIterationOpen, setPlanningIterationOpen] = useState(false);
  const [planningIterationInput, setPlanningIterationInput] = useState('');
  const [planningIterationSubmitting, setPlanningIterationSubmitting] = useState(false);
  const [planningReviewAcknowledging, setPlanningReviewAcknowledging] = useState(false);
  const [planningReviewRetrying, setPlanningReviewRetrying] = useState(false);
  const [selectedPlanningChangeState, setSelectedPlanningChangeState] =
    useState<{
      runId: string;
      change: OpenSpecPlanningFileChange;
    } | null>(null);
  const [confirmAction, setConfirmAction] = useState<'archive' | 'bulk-archive' | null>(null);
  const [confirmRecovery, setConfirmRecovery] = useState(false);
  const [bulkSelection, setBulkSelection] = useState<Set<string>>(new Set());
  const [timingNowMs, setTimingNowMs] = useState(() => Date.now());
  const consoleEndRef = useRef<HTMLDivElement>(null);

  const snapshot = workspace.snapshot;
  const planningReviewSummary = workspace.planningReviewSummary;
  const planningReview = workspace.planningReview;
  const selectedPlanningChange =
    selectedPlanningChangeState &&
      selectedPlanningChangeState.runId === planningReview?.runId
      ? selectedPlanningChangeState.change
      : null;
  const planningReviewBusy =
    workspace.planningReviewLoading ||
    planningReviewAcknowledging ||
    planningReviewRetrying;
  const selectedPlanningChangeVisual = selectedPlanningChange
    ? planningChangeVisual(selectedPlanningChange.kind)
    : null;
  const selectedChangeStale = workspace.selectedChangeStale;
  const selectedChangeUnavailable = Boolean(
    snapshot?.changeName &&
    !snapshot.archived &&
    !workspace.selectedChangeReady,
  );
  const activeRun = snapshot?.activeRun;
  const actionRunning = Boolean(activeRun && ACTIVE_RUN_STATES.has(activeRun.state));
  const availableActions = new Set(
    selectedChangeUnavailable ? [] : snapshot?.availableActions ?? [],
  );

  const activeChanges = workspace.changes.filter((change) => !change.archived);
  const archivedChanges = workspace.changes.filter((change) => change.archived);
  const displayedArtifacts = selectedChangeUnavailable
    ? []
    : snapshot?.artifacts ?? [];
  const primaryNextStep = selectedChangeUnavailable
    ? null
    : localizedNextStep(t, snapshot);
  const interruptedRun = activeRun?.state === 'interrupted' ? activeRun : null;
  const lastRun = workspace.runHistory.length
    ? workspace.runHistory[workspace.runHistory.length - 1]
    : null;
  const automaticAction = useMemo(
    () => selectedChangeUnavailable
      ? null
      : resolveOpenSpecAutomaticAction(snapshot, {
        preferredStartAction: task.metadata?.openSpec?.startAction,
        hasChanges: activeChanges.length > 0,
        lastRun,
      }),
    [
      activeChanges.length,
      lastRun,
      selectedChangeUnavailable,
      snapshot,
      task.metadata?.openSpec?.startAction,
    ],
  );
  const automaticPending = automaticAction
    ? workspace.actionPending === automaticAction.action
    : false;
  const planningIterationAvailable = Boolean(
    !selectedChangeUnavailable &&
    snapshot?.changeName &&
    !snapshot.archived &&
    !snapshot.unsupportedStatus &&
    availableActions.has('update'),
  );
  const planningIterationPending = workspace.actionPending === 'update';
  const planningIterationBusy =
    planningIterationSubmitting || planningIterationPending;
  const continuingVerifiedIteration = snapshot?.workflowStage === 'verified';
  const artifactCount = displayedArtifacts.length;
  const completedArtifacts = displayedArtifacts.filter(
    (artifact) => artifact.status === 'done',
  ).length;
  const planningPercent = artifactCount > 0
    ? (completedArtifacts / artifactCount) * 100
    : 0;
  const implementationPercent = snapshot?.taskProgress &&
    snapshot.taskProgress.total > 0
    ? (snapshot.taskProgress.completed / snapshot.taskProgress.total) * 100
    : 0;
  const implementationHasStarted = Boolean(
    snapshot?.workflowStage === 'implementation' ||
    snapshot?.workflowStage === 'verified' ||
    (
      !snapshot?.workflowStage &&
      (
        activeRun?.action === 'apply' ||
        snapshot?.taskProgress?.completed ||
        workspace.runHistory.some((run) => run.action === 'apply')
      )
    ),
  );
  const showImplementationProgress = Boolean(
    snapshot?.taskProgress &&
    implementationHasStarted,
  );
  const stageTimings = useMemo(
    () => summarizeOpenSpecStageTimings(workspace.runHistory, timingNowMs),
    [timingNowMs, workspace.runHistory],
  );
  const activityRuns = useMemo(() => {
    const runs: Array<{
      runId: string;
      content: string;
      markdown: string;
      truncated: boolean;
    }> = [];
    const runIndexes = new Map<string, number>();

    for (const line of workspace.consoleLines) {
      let runIndex = runIndexes.get(line.runId);
      if (runIndex === undefined) {
        runIndex = runs.length;
        runIndexes.set(line.runId, runIndex);
        runs.push({
          runId: line.runId,
          content: '',
          markdown: '',
          truncated: false,
        });
      }
      const run = runs[runIndex];
      run.content += line.text.replace(/\r\n?/g, '\n');
      run.truncated ||= Boolean(line.truncated);
    }

    return runs.map((run) => ({
      ...run,
      markdown: formatLogMarkdownForDisplay(run.content),
    }));
  }, [workspace.consoleLines]);

  useEffect(() => {
    if (activityRuns.length > 0) {
      consoleEndRef.current?.scrollIntoView?.({ block: 'end' });
    }
  }, [activityRuns]);

  useEffect(() => {
    if (!actionRunning) return;
    const timer = window.setInterval(() => {
      setTimingNowMs(Date.now());
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [actionRunning]);

  const invokeAction = async (action: OpenSpecAction) => {
    if (action === 'archive' || action === 'bulk-archive') {
      void workspace.runValidation().catch(() => undefined);
      setConfirmAction(action);
      return;
    }
    const explicitArguments = actionInput.trim();
    const argumentsForAction = explicitArguments ||
      (action === 'new' && snapshot?.archived
        ? t('tasks:openSpec.automatic.followUpIteration.defaultGuidance', {
            change: snapshot.changeName ?? t('tasks:openSpec.common.unknown'),
            description: task.description.slice(0, 30_000),
          })
        : undefined);
    try {
      await workspace.runAction(action, {
        arguments: argumentsForAction,
      });
      setActionInput('');
    } catch {
      // The hook exposes the safe error in the workspace.
    }
  };

  const openPlanningIteration = () => {
    setPlanningIterationInput((current) => current || actionInput);
    setPlanningIterationOpen(true);
  };

  const runPlanningIteration = async () => {
    const requirements = planningIterationInput.trim();
    if (!requirements) return;
    setPlanningIterationSubmitting(true);
    try {
      await workspace.runAction('update', {
        arguments: requirements,
      });
      setActionInput('');
      setPlanningIterationInput('');
      setPlanningIterationOpen(false);
    } catch {
      // Keep the dialog and draft open so the user can retry safely.
    } finally {
      setPlanningIterationSubmitting(false);
    }
  };

  const acknowledgePlanningReview = async () => {
    if (!planningReview || planningReview.state !== 'ready') return;
    setPlanningReviewAcknowledging(true);
    try {
      await workspace.acknowledgePlanningReview();
    } catch {
      // The hook keeps the review open and exposes the safe error.
    } finally {
      setPlanningReviewAcknowledging(false);
    }
  };

  const retryPlanningReview = async () => {
    if (!planningReview || planningReview.state !== 'error') return;
    setPlanningReviewRetrying(true);
    try {
      await workspace.retryPlanningReview();
    } catch {
      // The hook keeps the persisted review open and exposes the safe error.
    } finally {
      setPlanningReviewRetrying(false);
    }
  };

  const confirmDestructiveAction = async () => {
    if (!confirmAction) return;
    try {
      await workspace.runAction(confirmAction, {
        arguments: actionInput.trim() || undefined,
        selectedChanges: confirmAction === 'bulk-archive' ? [...bulkSelection] : undefined,
        confirmed: true,
      });
      setActionInput('');
      setConfirmAction(null);
    } catch {
      // Keep the dialog open so the user can inspect the error.
    }
  };

  const resumeInterruptedAction = async (confirmed = false) => {
    if (!interruptedRun) return;
    if (
      !confirmed &&
      (interruptedRun.action === 'archive' || interruptedRun.action === 'bulk-archive')
    ) {
      setConfirmRecovery(true);
      return;
    }
    try {
      await workspace.resumeAction(confirmed);
      setConfirmRecovery(false);
    } catch {
      // The hook exposes the safe error in the workspace.
    }
  };

  if (workspace.loading && !snapshot) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('tasks:openSpec.loading')}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="openspec-workspace"
    >
      <div className="shrink-0 border-b border-border bg-card/95 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
            <Sparkles className="h-4 w-4" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-sm font-semibold">
                {t('tasks:openSpec.header.title')}
              </span>
              <Select
                value={
                  snapshot?.archived || selectedChangeUnavailable
                    ? undefined
                    : snapshot?.changeName ?? undefined
                }
                onValueChange={(value) => void workspace.selectChange(value)}
                disabled={actionRunning || activeChanges.length === 0}
              >
                <SelectTrigger
                  className="h-7 min-w-0 max-w-[300px] border-0 bg-muted/70 px-2.5 font-mono text-xs shadow-none"
                  aria-label={t('tasks:openSpec.header.selectChangeAria')}
                >
                  <SelectValue
                    placeholder={t('tasks:openSpec.header.selectChange')}
                  />
                </SelectTrigger>
                <SelectContent>
                  {activeChanges.map((change) => (
                    <SelectItem key={change.name} value={change.name}>
                      {change.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Badge
                variant="outline"
                className="hidden shrink-0 text-[10px] lg:inline-flex"
                title={t('tasks:openSpec.header.rootVersion', {
                  root: snapshot?.rootLabel ?? t('tasks:openSpec.header.rootFallback'),
                  version: snapshot?.openSpecVersion ?? '1.6.0',
                })}
              >
                {snapshot?.schema.name ?? 'spec-driven'}
              </Badge>
              {activeRun && (
                <Badge
                  variant={activeRun.state === 'failed' ? 'destructive' : 'info'}
                  className="shrink-0 text-[10px]"
                  title={activeRun.waitingReason}
                >
                  {t(`tasks:openSpec.runStates.${activeRun.state}`)}
                </Badge>
              )}
              {snapshot?.archived && (
                <Badge variant="secondary">
                  {t('tasks:openSpec.header.archived')}
                </Badge>
              )}
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {selectedChangeStale
                ? t('tasks:openSpec.notice.selectionExpired')
                : automaticAction
                ? t(automaticAction.descriptionKey)
                : primaryNextStep ??
                (snapshot?.changeName
                  ? t('tasks:openSpec.header.upToDate')
                  : t('tasks:openSpec.header.selectExisting'))}
            </div>
          </div>

          <div className="hidden w-40 shrink-0 xl:block">
            <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>
                {showImplementationProgress
                  ? t('tasks:openSpec.phase.implementation')
                  : t('tasks:openSpec.phase.planning')}
              </span>
              <span className="tabular-nums">
                {showImplementationProgress && snapshot?.taskProgress
                  ? `${snapshot.taskProgress.completed}/${snapshot.taskProgress.total}`
                  : `${completedArtifacts}/${artifactCount}`}
              </span>
            </div>
            <Progress
              className="h-1.5"
              value={showImplementationProgress
                ? implementationPercent
                : planningPercent}
            />
          </div>

          {planningIterationAvailable && (
            <Button
              data-testid="openspec-refine-plan"
              variant="outline"
              size="sm"
              className="h-9 shrink-0"
              disabled={actionRunning || planningIterationBusy}
              onClick={openPlanningIteration}
            >
              {planningIterationBusy ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <MessageSquareText className="mr-1.5 h-4 w-4" />
              )}
              {automaticAction?.action === 'archive'
                ? t('tasks:openSpec.planIteration.afterVerify')
                : t('tasks:openSpec.planIteration.refine')}
            </Button>
          )}

          <Button
            data-testid="openspec-auto-action"
            size="sm"
            className="h-9 min-w-[150px] shrink-0 shadow-sm"
            disabled={
              !automaticAction ||
              isOpenSpecActionDisabled({
                snapshot,
                action: automaticAction?.action ?? 'explore',
                actionRunning,
                pending: automaticPending,
              })
            }
            onClick={() => automaticAction && void invokeAction(automaticAction.action)}
          >
            {automaticPending || actionRunning ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : automaticAction?.retry ? (
              <RotateCcw className="mr-1.5 h-4 w-4" />
            ) : automaticAction?.action === 'archive' ? (
              <Archive className="mr-1.5 h-4 w-4" />
            ) : automaticAction?.action === 'new' && snapshot?.archived ? (
              <Sparkles className="mr-1.5 h-4 w-4" />
            ) : (
              <Bot className="mr-1.5 h-4 w-4" />
            )}
            {automaticAction
              ? t(automaticAction.labelKey)
              :
              (actionRunning
                ? t('tasks:openSpec.primaryAction.working')
                : snapshot?.archived
                  ? t('tasks:openSpec.primaryAction.archived')
                  : !snapshot?.changeName && activeChanges.length > 0
                    ? t('tasks:openSpec.primaryAction.selectChange')
                    : t('tasks:openSpec.primaryAction.none'))}
          </Button>

          {actionRunning && activeRun && (
            <Button
              variant="destructive"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={() => void workspace.cancelAction()}
              aria-label={t('tasks:openSpec.toolbar.stopAria')}
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0"
                aria-label={t('tasks:openSpec.toolbar.moreAria')}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                onSelect={() => void workspace.runValidation()}
                disabled={
                  selectedChangeUnavailable ||
                  !snapshot?.changeName ||
                  snapshot.archived ||
                  actionRunning
                }
              >
                <ShieldCheck className="mr-2 h-4 w-4" />
                {t('tasks:openSpec.toolbar.validate')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void workspace.refresh()}
                disabled={workspace.loading}
              >
                <RefreshCw className={cn('mr-2 h-4 w-4', workspace.loading && 'animate-spin')} />
                {t('tasks:openSpec.toolbar.refresh')}
              </DropdownMenuItem>
              {(availableActions.has('archive') || availableActions.has('bulk-archive')) && (
                <DropdownMenuSeparator />
              )}
              {availableActions.has('archive') && (
                <DropdownMenuItem
                  data-testid="openspec-action-archive"
                  onSelect={() => void invokeAction('archive')}
                  disabled={actionRunning}
                >
                  <Archive className="mr-2 h-4 w-4" />
                  {t('tasks:openSpec.toolbar.archive')}
                </DropdownMenuItem>
              )}
              {availableActions.has('bulk-archive') && (
                <DropdownMenuItem
                  data-testid="openspec-action-bulk-archive"
                  onSelect={() => void invokeAction('bulk-archive')}
                  disabled={actionRunning}
                >
                  <Archive className="mr-2 h-4 w-4" />
                  {t('tasks:openSpec.toolbar.bulkArchive')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <Collapsible open={guidanceOpen} onOpenChange={setGuidanceOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <MessageSquareText className="h-3.5 w-3.5" />
              {actionInput
                ? t('tasks:openSpec.guidance.added')
                : t('tasks:openSpec.guidance.add')}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Input
              aria-label={t('tasks:openSpec.guidance.aria')}
              value={actionInput}
              onChange={(event) => setActionInput(event.target.value)}
              placeholder={t('tasks:openSpec.guidance.placeholder')}
              className="mt-2 h-8 bg-background"
              maxLength={32_000}
              disabled={actionRunning}
            />
          </CollapsibleContent>
        </Collapsible>
      </div>

      {workspace.error && (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-sm text-destructive">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{workspace.error}</span>
            <Button variant="ghost" size="sm" className="h-6" onClick={() => workspace.setError(null)}>
              {t('common:labels.dismiss')}
            </Button>
          </div>
        </div>
      )}

      {selectedChangeStale && (
        <div
          className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-sm text-amber-800 dark:text-amber-200"
          data-testid="openspec-stale-change-notice"
          role="status"
        >
          {t('tasks:openSpec.notice.selectionExpired')}
        </div>
      )}

      {snapshot?.unsupportedStatus && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-sm text-amber-700 dark:text-amber-300">
          {t('tasks:openSpec.notice.unsupportedStatus')}
        </div>
      )}

      {snapshot?.actionContext?.requiresAffectedAreaSelection && (
        <div
          className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-5 py-2 text-sm text-amber-700 dark:text-amber-300"
          role="alert"
        >
          {t('tasks:openSpec.notice.affectedAreaSelection')}
        </div>
      )}

      {snapshot?.archived && (
        <div className="shrink-0 border-b border-border bg-muted/50 px-5 py-2 text-sm text-muted-foreground">
          {t('tasks:openSpec.notice.archived')}
        </div>
      )}

      {activeRun?.waitingReason && (
        <div className="shrink-0 border-b border-blue-500/30 bg-blue-500/10 px-5 py-2 text-sm text-blue-800 dark:text-blue-200">
          {activeRun.waitingReason}
        </div>
      )}

      {interruptedRun && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-5 py-3 text-sm text-amber-800 dark:text-amber-200">
          <div className="flex flex-wrap items-center gap-3">
            <RotateCcw className="h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {t('tasks:openSpec.interrupted.title', {
                  action: actionLabel(t, interruptedRun.action),
                })}
              </div>
              <div className="text-xs opacity-80">
                {t('tasks:openSpec.interrupted.description')}
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => void resumeInterruptedAction()}
              disabled={!interruptedRun.recoverable || workspace.actionPending !== null}
            >
              {workspace.actionPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {t('tasks:openSpec.interrupted.continue')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void workspace.cancelAction()}
              disabled={workspace.actionPending !== null}
            >
              {t('tasks:openSpec.interrupted.cancel')}
            </Button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <ResizablePanels
          storageKey="openspec-workflow-navigation-width"
          defaultLeftWidth={21}
          minLeftWidth={16}
          maxLeftWidth={30}
          className="h-full"
          leftPanel={(
            <section
              className="flex h-full min-h-0 flex-col bg-muted/[0.18]"
              data-testid="openspec-workflow-stages"
            >
              <div className="shrink-0 border-b border-border px-3.5 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('tasks:openSpec.board.title')}
                    </div>
                    <div className="mt-0.5 text-sm font-medium">
                      {showImplementationProgress && snapshot?.taskProgress
                        ? t('tasks:openSpec.board.implementationProgress', {
                            completed: snapshot.taskProgress.completed,
                            total: snapshot.taskProgress.total,
                          })
                        : t('tasks:openSpec.board.progress', {
                            completed: completedArtifacts,
                            total: artifactCount,
                          })}
                    </div>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    {snapshot?.schema.name ?? 'spec-driven'}
                  </Badge>
                </div>
                <Progress
                  value={showImplementationProgress
                    ? implementationPercent
                    : planningPercent}
                  className="mt-2 h-1.5"
                />
                {showImplementationProgress && (
                  <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span>
                      {t('tasks:openSpec.board.planningComplete', {
                        completed: completedArtifacts,
                        total: artifactCount,
                      })}
                    </span>
                    <span>{t('tasks:openSpec.phase.implementation')}</span>
                  </div>
                )}
                <div
                  className="mt-3 border-t border-border/70 pt-2.5"
                  data-testid="openspec-stage-timings"
                >
                  <div className="mb-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span className="font-medium">
                      {t('tasks:openSpec.timing.title')}
                    </span>
                    <span>{t('tasks:openSpec.timing.scope')}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {stageTimings.map((timing) => (
                      <div
                        key={timing.stage}
                        className={cn(
                          'rounded-md border border-border/70 bg-background/65 px-2 py-1.5',
                          timing.active && 'border-blue-500/30 bg-blue-500/[0.06]',
                        )}
                        data-testid={`openspec-stage-timing-${timing.stage}`}
                        title={timing.active
                          ? t('tasks:openSpec.timing.active')
                          : undefined}
                      >
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          {timing.active && (
                            <span
                              className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-500"
                              aria-hidden="true"
                            />
                          )}
                          <span
                            className="truncate"
                            title={t(`tasks:openSpec.phase.${timing.stage}`)}
                          >
                            {t(`tasks:openSpec.phase.${timing.stage}`)}
                          </span>
                        </div>
                        <div className="mt-0.5 font-mono text-xs font-semibold tabular-nums">
                          {timing.runCount > 0
                            ? formatOpenSpecStageDuration(timing.durationMs)
                            : '—'}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {primaryNextStep && (
                  <div className="mt-2.5 rounded-md border border-blue-500/15 bg-blue-500/[0.06] px-2.5 py-2 text-[11px] leading-4 text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {t('tasks:openSpec.board.next')}
                    </span>{' '}
                    {primaryNextStep}
                  </div>
                )}
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-1.5 p-2.5">
                  {displayedArtifacts.map((artifact) => (
                    <ArtifactNavigationItem
                      key={artifact.id}
                      artifact={artifact}
                      selected={workspace.selectedArtifact?.id === artifact.id}
                      onSelect={() => workspace.setSelectedArtifactId(artifact.id)}
                    />
                  ))}
                  {artifactCount === 0 && (
                    <div className="rounded-lg border border-dashed border-border p-5 text-center text-xs text-muted-foreground">
                      {t('tasks:openSpec.board.empty')}
                    </div>
                  )}
                </div>
              </ScrollArea>
              <div className="shrink-0 border-t border-border px-3 py-2 text-[10px] text-muted-foreground">
                <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
                {t('tasks:openSpec.artifact.requiredBeforeImplementation')}
              </div>
            </section>
          )}
          rightPanel={(
            <ResizablePanels
              storageKey="openspec-document-activity-width"
              defaultLeftWidth={65}
              minLeftWidth={48}
              maxLeftWidth={76}
              className="h-full"
              leftPanel={(
                <section className="flex h-full min-h-0 flex-col bg-background">
                  <Tabs
                    value={previewTab}
                    onValueChange={setPreviewTab}
                    className="flex h-full min-h-0 flex-col"
                  >
                    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm font-medium">
                          {workspace.selectedArtifact?.id ??
                            t('tasks:openSpec.preview.title')}
                        </span>
                      </div>
                      <TabsList className="ml-2 h-8 bg-muted/60">
                        <TabsTrigger value="rendered" className="h-7 text-xs">
                          {t('tasks:openSpec.preview.tabs.preview')}
                        </TabsTrigger>
                        <TabsTrigger value="source" className="h-7 text-xs">
                          {t('tasks:openSpec.preview.tabs.source')}
                        </TabsTrigger>
                        <TabsTrigger value="diff" className="h-7 text-xs">
                          {t('tasks:openSpec.preview.tabs.diff')}
                        </TabsTrigger>
                        <TabsTrigger value="dependencies" className="h-7 text-xs">
                          {t('tasks:openSpec.preview.tabs.context')}
                        </TabsTrigger>
                      </TabsList>
                      <div className="ml-auto flex min-w-0 items-center gap-2">
                        {workspace.selectedArtifact &&
                          workspace.selectedArtifact.existingOutputPaths.length > 1 && (
                          <Select
                            value={workspace.selectedRelativePath ?? undefined}
                            onValueChange={workspace.setSelectedRelativePath}
                          >
                            <SelectTrigger className="h-7 w-[220px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {workspace.selectedArtifact.existingOutputPaths.map((path) => (
                                <SelectItem key={path} value={path}>{path}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        {workspace.selectedRelativePath && (
                          <span
                            className="hidden max-w-[260px] truncate font-mono text-[10px] text-muted-foreground 2xl:block"
                            title={workspace.selectedRelativePath}
                          >
                            {workspace.selectedRelativePath}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="min-h-0 flex-1">
                      {workspace.artifactLoading ? (
                        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {t('tasks:openSpec.preview.loading')}
                        </div>
                      ) : !workspace.selectedArtifact ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                          <FileCode2 className="h-8 w-8 opacity-30" />
                          {t('tasks:openSpec.preview.selectStage')}
                        </div>
                      ) : (
                        <>
                          <TabsContent value="rendered" className="m-0 h-full">
                            <ScrollArea className="h-full">
                              <article
                                className="mx-auto max-w-4xl px-7 py-6 text-sm"
                                data-artifact-kind={previewKind}
                                data-testid="openspec-preview-rendered"
                              >
                                {workspace.artifactContent ? (
                                  <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    skipHtml
                                    components={markdownComponents}
                                  >
                                    {workspace.artifactContent.content}
                                  </ReactMarkdown>
                                ) : (
                                  <div className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground">
                                    {t('tasks:openSpec.preview.noDocument')}
                                  </div>
                                )}
                              </article>
                            </ScrollArea>
                          </TabsContent>

                          <TabsContent value="source" className="m-0 h-full">
                            <ScrollArea className="h-full bg-muted/[0.12]">
                              <pre
                                className="min-h-full whitespace-pre-wrap break-words p-6 font-mono text-xs leading-6 text-foreground/85"
                                data-testid="openspec-preview-source"
                              >
                                {workspace.artifactContent?.content ??
                                  t('tasks:openSpec.preview.noSource')}
                              </pre>
                            </ScrollArea>
                          </TabsContent>

                          <TabsContent value="diff" className="m-0 h-full">
                            <ScrollArea className="h-full bg-muted/[0.12]">
                              <div className="border-b border-border px-5 py-2 text-xs text-muted-foreground">
                                <GitCompare className="mr-1.5 inline h-3.5 w-3.5" />
                                {t('tasks:openSpec.preview.base')}{' '}
                                {diffBaseLabel(t, workspace.artifactDiff?.base)}
                              </div>
                              <pre
                                className="whitespace-pre-wrap break-words p-6 font-mono text-xs leading-6"
                                data-testid="openspec-preview-diff"
                              >
                                {workspace.artifactDiff?.patch ||
                                  t('tasks:openSpec.preview.noDiff')}
                              </pre>
                            </ScrollArea>
                          </TabsContent>

                          <TabsContent value="dependencies" className="m-0 h-full">
                            <ScrollArea className="h-full">
                              <div
                                className="grid gap-4 p-6 text-sm xl:grid-cols-2"
                                data-testid="openspec-preview-dependencies"
                              >
                                <div className="rounded-lg border border-border p-4">
                                  <div className="font-medium">
                                    {t('tasks:openSpec.preview.dependencies')}
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-1">
                                    {workspace.selectedArtifact.dependencies.length
                                      ? workspace.selectedArtifact.dependencies.map((dependency) => (
                                          <Badge key={dependency} variant="outline">{dependency}</Badge>
                                        ))
                                      : (
                                          <span className="text-muted-foreground">
                                            {t('tasks:openSpec.common.none')}
                                          </span>
                                        )}
                                  </div>
                                  <div className="mt-4 font-medium">
                                    {t('tasks:openSpec.preview.unlocks')}
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-1">
                                    {workspace.selectedArtifact.unlocks.length
                                      ? workspace.selectedArtifact.unlocks.map((dependency) => (
                                          <Badge key={dependency} variant="outline">{dependency}</Badge>
                                        ))
                                      : (
                                          <span className="text-muted-foreground">
                                            {t('tasks:openSpec.common.none')}
                                          </span>
                                        )}
                                  </div>
                                </div>
                                <div className="rounded-lg border border-border p-4">
                                  <div className="font-medium">
                                    {t('tasks:openSpec.preview.officialInstructions')}
                                  </div>
                                  <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted/60 p-3 text-xs leading-5">
                                    {workspace.selectedArtifact.instruction ||
                                      t('tasks:openSpec.preview.noInstructions')}
                                  </pre>
                                  {workspace.selectedArtifact.template && (
                                    <>
                                      <div className="mt-4 font-medium">
                                        {t('tasks:openSpec.preview.officialTemplate')}
                                      </div>
                                      <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted/60 p-3 text-xs leading-5">
                                        {workspace.selectedArtifact.template}
                                      </pre>
                                    </>
                                  )}
                                </div>
                                {snapshot?.actionContext && (
                                  <div
                                    className="space-y-3 rounded-lg border border-border p-4 xl:col-span-2"
                                    data-testid="openspec-action-context"
                                  >
                                    <div className="font-medium">
                                      {t('tasks:openSpec.context.title')}
                                    </div>
                                    <dl className="grid gap-2 text-xs sm:grid-cols-[140px_minmax(0,1fr)]">
                                      <dt className="text-muted-foreground">
                                        {t('tasks:openSpec.context.planningHome')}
                                      </dt>
                                      <dd className="break-all font-mono">
                                        {snapshot.actionContext.planningHome.kind ??
                                          t('tasks:openSpec.common.unknown')} ·{' '}
                                        {snapshot.actionContext.planningHome.root}
                                      </dd>
                                      <dt className="text-muted-foreground">
                                        {t('tasks:openSpec.context.sourceOfTruth')}
                                      </dt>
                                      <dd>
                                        {snapshot.actionContext.sourceOfTruth ??
                                          t('tasks:openSpec.common.unspecified')}
                                      </dd>
                                      <dt className="text-muted-foreground">
                                        {t('tasks:openSpec.context.allowedEditRoots')}
                                      </dt>
                                      <dd className="space-y-1">
                                        {snapshot.actionContext.allowedEditRoots.length > 0
                                          ? snapshot.actionContext.allowedEditRoots.map((editRoot) => (
                                              <div key={editRoot} className="break-all font-mono">
                                                {editRoot}
                                              </div>
                                            ))
                                          : t('tasks:openSpec.common.none')}
                                      </dd>
                                      <dt className="text-muted-foreground">
                                        {t('tasks:openSpec.context.linkedContext')}
                                      </dt>
                                      <dd>
                                        {snapshot.actionContext.linkedContext.length > 0
                                          ? snapshot.actionContext.linkedContext.join(', ')
                                          : t('tasks:openSpec.common.none')}
                                      </dd>
                                    </dl>
                                    {snapshot.actionContext.constraints.length > 0 && (
                                      <div>
                                        <div className="text-xs font-medium">
                                          {t('tasks:openSpec.context.constraints')}
                                        </div>
                                        <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                                          {snapshot.actionContext.constraints.map((constraint) => (
                                            <li key={constraint}>{constraint}</li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </ScrollArea>
                          </TabsContent>
                        </>
                      )}
                    </div>
                  </Tabs>
                </section>
              )}
              rightPanel={(
                <section className="flex h-full min-h-0 flex-col bg-card/40">
                  <Tabs
                    value={activityTab}
                    onValueChange={setActivityTab}
                    className="flex h-full min-h-0 flex-col"
                  >
                    <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
                      <TabsList className="h-8 bg-muted/60">
                        <TabsTrigger value="activity" className="h-7 gap-1.5 text-xs">
                          <TerminalSquare className="h-3.5 w-3.5" />
                          {t('tasks:openSpec.activity.title')}
                        </TabsTrigger>
                        <TabsTrigger value="history" className="h-7 gap-1.5 text-xs">
                          <History className="h-3.5 w-3.5" />
                          {t('tasks:openSpec.history.title')}
                        </TabsTrigger>
                      </TabsList>
                      {workspace.validation && (
                        <Badge
                          variant={workspace.validation.valid ? 'success' : 'destructive'}
                          className="ml-auto text-[10px]"
                        >
                          {workspace.validation.valid
                            ? t('tasks:openSpec.validation.valid')
                            : t('tasks:openSpec.validation.issuesFound')}
                        </Badge>
                      )}
                    </div>

                    <TabsContent value="activity" className="m-0 min-h-0 flex-1">
                      <div className="flex h-full min-h-0 flex-col">
                        {workspace.interaction && (
                          <div className="max-h-[48%] shrink-0 overflow-y-auto border-b border-blue-500/20 bg-blue-500/[0.04] p-3">
                            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-blue-700 dark:text-blue-300">
                              <MessageSquareText className="h-4 w-4" />
                              {t('tasks:openSpec.interaction.needsInput')}
                            </div>
                            <OpenSpecInteractionPanel
                              interaction={workspace.interaction}
                              disabled={Boolean(interruptedRun)}
                              onSubmit={workspace.answerInteraction}
                            />
                          </div>
                        )}
                        <div className="flex h-9 shrink-0 items-center border-b border-white/5 bg-[#0b1017] px-3 text-[11px] text-slate-400">
                          <span className="mr-2 h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.45)]" />
                          {t('tasks:openSpec.console.title')}
                          {activeRun && (
                            <span className="ml-auto font-mono text-slate-500">
                              {actionLabel(t, activeRun.action)} ·{' '}
                              {t(`tasks:openSpec.runStates.${activeRun.state}`)}
                            </span>
                          )}
                        </div>
                        <ScrollArea className="min-h-0 flex-1 bg-[#0b1017]">
                          <div
                            className="min-h-full py-2 text-[11px] leading-[1.65]"
                            aria-label={t('tasks:openSpec.console.aria')}
                            aria-live="polite"
                            role="log"
                            data-testid="openspec-action-console"
                          >
                            {workspace.consoleLines.length ? (
                              activityRuns.map((run) => (
                                <div
                                  key={run.runId}
                                  className="border-b border-white/5 px-3 py-1.5 last:border-b-0"
                                  data-testid="openspec-activity-run"
                                  data-run-id={run.runId}
                                >
                                  {run.truncated && (
                                    <div className="mb-1.5 border-l-2 border-amber-300/40 bg-amber-300/[0.06] px-2 py-1 text-amber-200">
                                      {t('tasks:openSpec.console.earlierOutputTruncated')}
                                    </div>
                                  )}
                                  {run.markdown && (
                                    <div className="max-w-none">
                                      <ReactMarkdown
                                        remarkPlugins={[remarkGfm]}
                                        skipHtml
                                        components={activityMarkdownComponents}
                                      >
                                        {run.markdown}
                                      </ReactMarkdown>
                                    </div>
                                  )}
                                </div>
                              ))
                            ) : (
                              <div className="flex min-h-[180px] flex-col items-center justify-center px-6 text-center text-slate-500">
                                <Bot className="mb-2 h-7 w-7 text-slate-600" />
                                <span>{t('tasks:openSpec.console.empty')}</span>
                              </div>
                            )}
                            <div ref={consoleEndRef} />
                          </div>
                        </ScrollArea>
                      </div>
                    </TabsContent>

                    <TabsContent value="history" className="m-0 min-h-0 flex-1">
                      <ScrollArea className="h-full">
                        <div
                          className="space-y-3 p-3 text-xs"
                          data-testid="openspec-history"
                        >
                          {workspace.runHistory.slice().reverse().map((run) => (
                            <div key={run.runId} className="rounded-lg border border-border bg-background/70 p-2.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium">
                                  {actionLabel(t, run.action)}
                                </span>
                                <Badge
                                  variant={
                                    run.state === 'failed'
                                      ? 'destructive'
                                      : run.state === 'succeeded'
                                        ? 'success'
                                        : 'outline'
                                  }
                                  className="text-[10px]"
                                >
                                  {t(`tasks:openSpec.runStates.${run.state}`)}
                                </Badge>
                              </div>
                              <div className="mt-1 text-[10px] text-muted-foreground">
                                {new Date(run.startedAt).toLocaleString()}
                                {run.durationMs !== undefined && (
                                  <> · {formatOpenSpecStageDuration(run.durationMs)}</>
                                )}
                              </div>
                              {run.error && <div className="mt-1 text-destructive">{run.error}</div>}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="mt-1 h-6 px-1.5 text-[10px]"
                                onClick={() => {
                                  void workspace.loadRunLog(run.runId).then(() => {
                                    setActivityTab('activity');
                                  });
                                }}
                              >
                                {t('tasks:openSpec.history.viewLog')}
                              </Button>
                            </div>
                          ))}
                          {workspace.validation?.issues.map((issue) => (
                            <div
                              key={`${issue.severity}:${issue.path ?? ''}:${issue.message}`}
                              className={cn(
                                'rounded-lg border p-2.5',
                                issue.severity === 'error'
                                  ? 'border-destructive/40 bg-destructive/5'
                                  : 'border-border bg-background/70',
                              )}
                            >
                              <div className="font-medium">
                                {t(`tasks:openSpec.validation.severity.${issue.severity}`)}
                              </div>
                              {issue.path && (
                                <div className="mt-0.5 break-all font-mono text-muted-foreground">
                                  {issue.path}
                                </div>
                              )}
                              <div className="mt-1">{issue.message}</div>
                            </div>
                          ))}
                          {workspace.runHistory.length === 0 && !workspace.validation && (
                            <div className="rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground">
                              {t('tasks:openSpec.history.empty')}
                            </div>
                          )}
                          {archivedChanges.length > 0 && (
                            <div className="rounded-lg border border-border bg-background/70 p-2.5">
                              <div className="mb-2 font-medium">
                                {t('tasks:openSpec.history.archivedChanges')}
                              </div>
                              {archivedChanges.map((change) => (
                                <Badge key={change.name} variant="secondary" className="mb-1 mr-1">
                                  {change.name}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    </TabsContent>
                  </Tabs>
                </section>
              )}
            />
          )}
        />
      </div>

      <Dialog
        open={planningIterationOpen}
        onOpenChange={(open) => {
          if (!planningIterationBusy) {
            setPlanningIterationOpen(open);
          }
        }}
      >
        <DialogContent className="sm:max-w-xl" hideCloseButton={planningIterationBusy}>
          <DialogHeader>
            <DialogTitle>
              {t(continuingVerifiedIteration
                ? 'tasks:openSpec.planIteration.dialog.titleContinue'
                : 'tasks:openSpec.planIteration.dialog.titleRefine')}
            </DialogTitle>
            <DialogDescription>
              {t(continuingVerifiedIteration
                ? 'tasks:openSpec.planIteration.dialog.descriptionContinue'
                : 'tasks:openSpec.planIteration.dialog.descriptionRefine')}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-2">
            <Label htmlFor="openspec-planning-iteration-input">
              {t('tasks:openSpec.planIteration.dialog.label')}
            </Label>
            <Textarea
              id="openspec-planning-iteration-input"
              value={planningIterationInput}
              onChange={(event) => setPlanningIterationInput(event.target.value)}
              placeholder={t('tasks:openSpec.planIteration.dialog.placeholder')}
              className="min-h-36 resize-y"
              maxLength={32_000}
              autoFocus
              disabled={planningIterationBusy}
            />
            <div className="text-right text-[10px] tabular-nums text-muted-foreground">
              {planningIterationInput.length.toLocaleString()}/32,000
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPlanningIterationOpen(false)}
              disabled={planningIterationBusy}
            >
              {t('common:buttons.cancel')}
            </Button>
            <Button
              data-testid="openspec-submit-plan-iteration"
              onClick={() => void runPlanningIteration()}
              disabled={
                planningIterationBusy ||
                planningIterationInput.trim().length === 0
              }
            >
              {planningIterationBusy && (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              )}
              {t('tasks:openSpec.planIteration.dialog.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={planningReviewSummary !== null}>
        <DialogContent
          className="max-h-[85vh] sm:max-w-4xl"
          hideCloseButton
        >
          <DialogHeader>
            <DialogTitle>
              {t('tasks:openSpec.planIteration.review.title')}
            </DialogTitle>
            <DialogDescription>
              {workspace.planningReviewLoading
                ? t('tasks:openSpec.planIteration.review.loading')
                : workspace.planningReviewLoadError
                  ? t('tasks:openSpec.planIteration.review.loadFailed')
                  : planningReview?.state === 'error'
                    ? t('tasks:openSpec.planIteration.review.captureFailed')
                    : t('tasks:openSpec.planIteration.review.description', {
                        count: planningReview?.changes.length ?? 0,
                      })}
            </DialogDescription>
          </DialogHeader>

          {workspace.planningReviewLoading ? (
            <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('tasks:openSpec.planIteration.review.loading')}
            </div>
          ) : workspace.planningReviewLoadError ? (
            <div
              className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
              data-testid="openspec-planning-review-load-error"
              role="alert"
            >
              {workspace.planningReviewLoadError}
            </div>
          ) : planningReview?.state === 'error' ? (
            <div
              className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200"
              data-testid="openspec-planning-review-capture-error"
              role="alert"
            >
              {planningReview.error ??
                t('tasks:openSpec.planIteration.review.captureFailed')}
            </div>
          ) : (
            <ScrollArea className="mt-4 min-h-0 flex-1">
              <div
                className="space-y-3 pr-3"
                data-testid="openspec-planning-review"
              >
                {planningReview?.changes.map((change) => {
                  const visual = planningChangeVisual(change.kind);
                  return (
                    <button
                      key={change.relativePath}
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg border px-3 py-3 text-left transition-colors',
                        visual.containerClassName,
                      )}
                      aria-label={t(
                        'tasks:openSpec.planIteration.review.openDiff',
                        { path: change.relativePath },
                      )}
                      data-testid="openspec-planning-review-file"
                      data-change-kind={change.kind}
                      onClick={() => {
                        if (planningReview) {
                          setSelectedPlanningChangeState({
                            runId: planningReview.runId,
                            change,
                          });
                        }
                      }}
                    >
                      <Badge
                        variant="outline"
                        className={cn('text-[10px]', visual.badgeClassName)}
                      >
                        {t(`tasks:openSpec.planIteration.review.kind.${change.kind}`)}
                      </Badge>
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate font-mono text-xs font-medium',
                          visual.pathClassName,
                        )}
                      >
                        {change.relativePath}
                      </span>
                      <GitCompare
                        className={cn('h-4 w-4 shrink-0', visual.pathClassName)}
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}

                {planningReview?.changes.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                    {t('tasks:openSpec.planIteration.review.noChanges')}
                  </div>
                )}
              </div>
            </ScrollArea>
          )}

          <DialogFooter>
            {workspace.planningReviewLoadError ? (
              <Button
                onClick={workspace.reloadPlanningReview}
                disabled={planningReviewBusy}
              >
                {t('tasks:openSpec.planIteration.review.retryLoad')}
              </Button>
            ) : planningReview?.state === 'error' ? (
              <Button
                onClick={() => void retryPlanningReview()}
                disabled={planningReviewBusy}
              >
                {planningReviewRetrying && (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                )}
                {planningReviewRetrying
                  ? t('tasks:openSpec.planIteration.review.retrying')
                  : t('tasks:openSpec.planIteration.review.retry')}
              </Button>
            ) : (
              <Button
                onClick={() => void acknowledgePlanningReview()}
                disabled={planningReviewBusy || planningReview?.state !== 'ready'}
              >
                {planningReviewAcknowledging && (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                )}
                {planningReviewAcknowledging
                  ? t('tasks:openSpec.planIteration.review.acknowledging')
                  : t('tasks:openSpec.planIteration.review.acknowledge')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={selectedPlanningChange !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedPlanningChangeState(null);
        }}
      >
        <DialogContent className="max-h-[88vh] sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {t('tasks:openSpec.planIteration.review.diffTitle')}
            </DialogTitle>
            <DialogDescription>
              {selectedPlanningChange
                ? t('tasks:openSpec.planIteration.review.diffDescription', {
                    kind: t(
                      `tasks:openSpec.planIteration.review.kind.${selectedPlanningChange.kind}`,
                    ),
                    path: selectedPlanningChange.relativePath,
                  })
                : null}
            </DialogDescription>
          </DialogHeader>
          {selectedPlanningChange && selectedPlanningChangeVisual && (
            <div
              className={cn(
                'mt-4 min-h-0 overflow-hidden rounded-lg border',
                selectedPlanningChangeVisual.containerClassName,
              )}
              data-testid="openspec-planning-review-diff-dialog"
              data-change-kind={selectedPlanningChange.kind}
            >
              <div className="flex items-center gap-2 border-b border-current/10 px-3 py-2.5">
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px]',
                    selectedPlanningChangeVisual.badgeClassName,
                  )}
                >
                  {t(
                    `tasks:openSpec.planIteration.review.kind.${selectedPlanningChange.kind}`,
                  )}
                </Badge>
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate font-mono text-xs font-medium',
                    selectedPlanningChangeVisual.pathClassName,
                  )}
                  title={selectedPlanningChange.relativePath}
                >
                  {selectedPlanningChange.relativePath}
                </span>
              </div>
              <PlanningReviewPatch patch={selectedPlanningChange.patch} />
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="openspec-planning-review-diff-close"
              onClick={() => setSelectedPlanningChangeState(null)}
            >
              {t('common:buttons.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => !open && setConfirmAction(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('tasks:openSpec.dialogs.confirm.title', {
                action: confirmAction
                  ? actionLabel(t, confirmAction)
                  : t('tasks:openSpec.common.action'),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  {t('tasks:openSpec.dialogs.confirm.description', {
                    root: snapshot?.rootLabel,
                  })}
                </p>
                {confirmAction === 'archive' && (
                  <div className="rounded border border-border p-3">
                    {t('tasks:openSpec.dialogs.confirm.changeLabel')}{' '}
                    <span className="font-mono text-foreground">
                      {snapshot?.changeName}
                    </span>
                  </div>
                )}
                {confirmAction === 'bulk-archive' && (
                  <div className="max-h-56 space-y-2 overflow-y-auto rounded border border-border p-3">
                    {activeChanges.map((change) => (
                      <Label key={change.name} className="flex cursor-pointer items-center gap-2">
                        <Checkbox
                          checked={bulkSelection.has(change.name)}
                          onCheckedChange={(checked) => {
                            setBulkSelection((current) => {
                              const next = new Set(current);
                              if (checked === true) next.add(change.name);
                              else next.delete(change.name);
                              return next;
                            });
                          }}
                        />
                        <span className="font-mono">{change.name}</span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {change.completedTasks}/{change.totalTasks}
                        </span>
                      </Label>
                    ))}
                  </div>
                )}
                {workspace.validation && (
                  <div className={cn(
                    'rounded border p-3',
                    workspace.validation.valid
                      ? 'border-success/30 bg-success/5'
                      : 'border-destructive/30 bg-destructive/5',
                  )}>
                    {workspace.validation.valid
                      ? t('tasks:openSpec.dialogs.confirm.validationValid')
                      : t('tasks:openSpec.dialogs.confirm.validationIssues', {
                          count: workspace.validation.issues.length,
                        })}
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:buttons.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void confirmDestructiveAction();
              }}
              disabled={
                workspace.actionPending !== null ||
                (confirmAction === 'bulk-archive' && bulkSelection.size < 2)
              }
            >
              {workspace.actionPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {t('tasks:openSpec.dialogs.confirm.run', {
                action: confirmAction
                  ? actionLabel(t, confirmAction)
                  : t('tasks:openSpec.common.action'),
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmRecovery}
        onOpenChange={(open) => setConfirmRecovery(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('tasks:openSpec.dialogs.resume.title', {
                action: interruptedRun
                  ? actionLabel(t, interruptedRun.action)
                  : t('tasks:openSpec.common.action'),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('tasks:openSpec.dialogs.resume.description', {
                root: snapshot?.rootLabel,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:buttons.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void resumeInterruptedAction(true);
              }}
              disabled={workspace.actionPending !== null}
            >
              {t('tasks:openSpec.dialogs.resume.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
