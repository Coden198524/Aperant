import { useState, useRef, useLayoutEffect, useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Target,
  Bug,
  Wrench,
  FileCode,
  Shield,
  Gauge,
  Palette,
  Lightbulb,
  Users,
  GitBranch,
  GitPullRequest,
  ListChecks,
  Clock,
  ExternalLink,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn, formatRelativeTime, formatTokenCount } from '../../lib/utils';
import {
  TASK_CATEGORY_COLORS,
  TASK_COMPLEXITY_COLORS,
  TASK_IMPACT_COLORS,
  TASK_PRIORITY_COLORS,
  JSON_ERROR_PREFIX
} from '../../../shared/constants';
import type { Task, TaskCategory } from '../../../shared/types';
import type { IdeationType } from '../../../shared/types/insights';
import {
  getIdeationTypeLabel,
  getTaskCategoryLabel,
  getTaskComplexityLabel,
  getTaskImpactLabel,
  getTaskPriorityLabel,
  getTaskSeverityLabel,
  getTaskSourceTypeLabel
} from '../../lib/i18n-labels';

const CategoryIcon: Record<TaskCategory, typeof Target> = {
  feature: Target,
  bug_fix: Bug,
  refactoring: Wrench,
  documentation: FileCode,
  security: Shield,
  performance: Gauge,
  ui_ux: Palette,
  infrastructure: Wrench,
  testing: FileCode
};

interface TaskMetadataProps {
  task: Task;
}

const COLLAPSED_HEIGHT = 200;

export function TaskMetadata({ task }: TaskMetadataProps) {
  const { t } = useTranslation(['tasks', 'errors']);
  const { t: tCommon } = useTranslation('common');
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const contentId = useId();

  const displayDescription = (() => {
    if (!task.description) return null;
    if (task.description.startsWith(JSON_ERROR_PREFIX)) {
      const errorMessage = task.description.slice(JSON_ERROR_PREFIX.length);
      return t('errors:task.jsonError.description', { error: errorMessage });
    }
    return task.description;
  })();

  // biome-ignore lint/correctness/useExhaustiveDependencies: content height depends on rendered description
  useLayoutEffect(() => {
    setIsExpanded(false);
    const element = contentRef.current;
    if (element) {
      setHasOverflow(element.scrollHeight > COLLAPSED_HEIGHT);
    }
  }, [task.id, task.description]);

  const hasClassification = task.metadata && (
    task.metadata.category ||
    task.metadata.priority ||
    task.metadata.complexity ||
    task.metadata.impact ||
    task.metadata.securitySeverity ||
    task.metadata.sourceType
  );

  const tokenStatItems = useMemo(() => {
    if (!task.tokenUsage?.totalTokens) return [];

    const items = [
      {
        key: 'prompt',
        label: t('tasks:detail.promptTokens', { defaultValue: 'Prompt' }),
        value: task.tokenUsage.promptTokens,
      },
      {
        key: 'completion',
        label: t('tasks:detail.completionTokens', { defaultValue: 'Completion' }),
        value: task.tokenUsage.completionTokens,
      },
      {
        key: 'total',
        label: t('tasks:detail.totalTokens', { defaultValue: 'Total' }),
        value: task.tokenUsage.totalTokens,
      },
    ];

    if (task.tokenUsage.thinkingTokens) {
      items.push({
        key: 'thinking',
        label: t('tasks:detail.thinkingTokens', { defaultValue: 'Thinking' }),
        value: task.tokenUsage.thinkingTokens,
      });
    }

    if (task.tokenUsage.cacheReadTokens) {
      items.push({
        key: 'cache-read',
        label: t('tasks:detail.cacheReadTokens', { defaultValue: 'Cache Read' }),
        value: task.tokenUsage.cacheReadTokens,
      });
    }

    if (task.tokenUsage.cacheCreationTokens) {
      items.push({
        key: 'cache-write',
        label: t('tasks:detail.cacheCreationTokens', { defaultValue: 'Cache Write' }),
        value: task.tokenUsage.cacheCreationTokens,
      });
    }

    return items;
  }, [
    task.tokenUsage?.promptTokens,
    task.tokenUsage?.completionTokens,
    task.tokenUsage?.totalTokens,
    task.tokenUsage?.thinkingTokens,
    task.tokenUsage?.cacheReadTokens,
    task.tokenUsage?.cacheCreationTokens,
    t,
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-border">
        {hasClassification && (
          <div className="flex flex-wrap items-center gap-1.5">
            {task.metadata?.category && (
              <Badge
                variant="outline"
                className={cn('text-xs', TASK_CATEGORY_COLORS[task.metadata.category])}
              >
                {(() => {
                  const Icon = CategoryIcon[task.metadata.category];
                  return <Icon className="h-3 w-3 mr-1" />;
                })()}
                {getTaskCategoryLabel(t, task.metadata.category)}
              </Badge>
            )}
            {task.metadata?.priority && (
              <Badge
                variant="outline"
                className={cn('text-xs', TASK_PRIORITY_COLORS[task.metadata.priority])}
              >
                {getTaskPriorityLabel(t, task.metadata.priority)}
              </Badge>
            )}
            {task.metadata?.complexity && (
              <Badge
                variant="outline"
                className={cn('text-xs', TASK_COMPLEXITY_COLORS[task.metadata.complexity])}
              >
                {getTaskComplexityLabel(t, task.metadata.complexity)}
              </Badge>
            )}
            {task.metadata?.impact && (
              <Badge
                variant="outline"
                className={cn('text-xs', TASK_IMPACT_COLORS[task.metadata.impact])}
              >
                {getTaskImpactLabel(t, task.metadata.impact)}
              </Badge>
            )}
            {task.metadata?.securitySeverity && (
              <Badge
                variant="outline"
                className={cn('text-xs', TASK_IMPACT_COLORS[task.metadata.securitySeverity])}
              >
                <Shield className="h-3 w-3 mr-1" />
                {getTaskSeverityLabel(t, task.metadata.securitySeverity)}
              </Badge>
            )}
            {task.metadata?.sourceType && (
              <Badge variant="secondary" className="text-xs">
                {task.metadata.sourceType === 'ideation' && task.metadata.ideationType
                  ? getIdeationTypeLabel(tCommon, task.metadata.ideationType as IdeationType)
                  : getTaskSourceTypeLabel(
                      t,
                      task.metadata.sourceType as Exclude<typeof task.metadata.sourceType, 'ideation' | undefined>
                    )}
              </Badge>
            )}
          </div>
        )}

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          {task.tokenUsage?.totalTokens ? (
            <span className="flex items-center gap-1.5">
              <Gauge className="h-3 w-3" />
              {t('tasks:detail.tokensLabel', { defaultValue: 'Tokens' })} {formatTokenCount(task.tokenUsage.totalTokens)}
            </span>
          ) : null}
          <span className="flex items-center gap-1.5">
            <Clock className="h-3 w-3" />
            {t('tasks:metadata.created')} {formatRelativeTime(task.createdAt)}
          </span>
          <span className="text-border">|</span>
          <span>{t('tasks:metadata.updated')} {formatRelativeTime(task.updatedAt)}</span>
        </div>
      </div>

      {tokenStatItems.length > 0 ? (
        <div className="grid gap-2 md:grid-cols-3">
          {tokenStatItems.map((stat) => (
            <div key={stat.key} className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {stat.label}
              </div>
              <div className="mt-1 text-sm font-semibold text-foreground tabular-nums">
                {formatTokenCount(stat.value)}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {displayDescription && (
        <div className="bg-muted/30 rounded-lg px-4 py-3 border border-border/50 overflow-hidden max-w-full">
          <div className="relative">
            <div
              ref={contentRef}
              id={contentId}
              className={cn(
                'prose prose-sm dark:prose-invert max-w-none overflow-hidden prose-p:text-foreground/90 prose-p:leading-relaxed prose-headings:text-foreground prose-strong:text-foreground prose-li:text-foreground/90 prose-ul:my-2 prose-li:my-0.5 prose-a:break-all prose-pre:overflow-x-auto prose-img:max-w-full [&_img]:!max-w-full [&_img]:h-auto [&_code]:break-all [&_code]:whitespace-pre-wrap [&_*]:max-w-full',
                !isExpanded && hasOverflow && 'max-h-[200px]'
              )}
              style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {displayDescription}
              </ReactMarkdown>
            </div>

            {!isExpanded && hasOverflow && (
              <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-muted/80 to-transparent pointer-events-none" />
            )}
          </div>

          {hasOverflow && (
            <div className="flex justify-center mt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsExpanded(!isExpanded)}
                className="text-muted-foreground hover:text-foreground"
                aria-expanded={isExpanded}
                aria-controls={contentId}
              >
                {isExpanded ? (
                  <>
                    <ChevronUp className="h-4 w-4 mr-1" aria-hidden="true" />
                    {t('tasks:metadata.showLess')}
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4 mr-1" aria-hidden="true" />
                    {t('tasks:metadata.showMore')}
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      {task.metadata && (
        <div className="space-y-4 pt-2">
          {task.metadata.rationale && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                <Lightbulb className="h-3 w-3 text-warning" />
                {t('tasks:metadata.rationale')}
              </h3>
              <p className="text-sm text-foreground/80">{task.metadata.rationale}</p>
            </div>
          )}

          {task.metadata.problemSolved && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                <Target className="h-3 w-3 text-success" />
                {t('tasks:metadata.problemSolved')}
              </h3>
              <p className="text-sm text-foreground/80">{task.metadata.problemSolved}</p>
            </div>
          )}

          {task.metadata.targetAudience && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                <Users className="h-3 w-3 text-info" />
                {t('tasks:metadata.targetAudience')}
              </h3>
              <p className="text-sm text-foreground/80">{task.metadata.targetAudience}</p>
            </div>
          )}

          {task.metadata.dependencies && task.metadata.dependencies.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                <GitBranch className="h-3 w-3 text-purple-400" />
                {t('tasks:metadata.dependencies')}
              </h3>
              <ul className="text-sm text-foreground/80 list-disc list-inside space-y-0.5">
                {task.metadata.dependencies.map((dep, idx) => (
                  <li key={idx}>{dep}</li>
                ))}
              </ul>
            </div>
          )}

          {task.metadata.prUrl && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                <GitPullRequest className="h-3 w-3 text-info" />
                {t('tasks:metadata.pullRequest')}
              </h3>
              <button
                type="button"
                onClick={() => {
                  if (task.metadata?.prUrl) {
                    window.electronAPI.openExternal(task.metadata.prUrl);
                  }
                }}
                className="text-sm text-info hover:underline flex items-center gap-1.5 bg-transparent border-none cursor-pointer p-0 text-left"
              >
                {task.metadata.prUrl}
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          )}

          {task.metadata.acceptanceCriteria && task.metadata.acceptanceCriteria.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                <ListChecks className="h-3 w-3 text-success" />
                {t('tasks:metadata.acceptanceCriteria')}
              </h3>
              <ul className="text-sm text-foreground/80 list-disc list-inside space-y-0.5">
                {task.metadata.acceptanceCriteria.map((criteria, idx) => (
                  <li key={idx}>{criteria}</li>
                ))}
              </ul>
            </div>
          )}

          {task.metadata.affectedFiles && task.metadata.affectedFiles.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                <FileCode className="h-3 w-3" />
                {t('tasks:metadata.affectedFiles')}
              </h3>
              <div className="flex flex-wrap gap-1">
                {task.metadata.affectedFiles.map((file, idx) => (
                  <Tooltip key={idx}>
                    <TooltipTrigger asChild>
                      <Badge variant="secondary" className="text-xs font-mono cursor-help">
                        {file.split('/').pop()}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="font-mono text-xs">
                      {file}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
