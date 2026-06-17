import { useCallback, useState, useRef, useId, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AUTOCODE_PROJECT_DEFAULT_BRANCH_MARKER } from '@autocode/core/tasks/branch-protocol';
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
  ChevronUp,
  Loader2,
  Pencil,
  Save,
  X
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Combobox } from '../ui/combobox';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { buildBranchOptions } from '../../lib/branch-utils';
import { buildTokenHoverTitle, cn, formatRelativeTime, formatTokenCount } from '../../lib/utils';
import {
  TASK_CATEGORY_COLORS,
  TASK_COMPLEXITY_COLORS,
  TASK_IMPACT_COLORS,
  TASK_PRIORITY_COLORS,
  JSON_ERROR_PREFIX
} from '../../../shared/constants';
import type { Task, TaskCategory, GitBranchDetail } from '../../../shared/types';
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
import { useProjectStore } from '../../stores/project-store';
import { persistUpdateTask } from '../../stores/task-store';

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
const PROJECT_DEFAULT_BRANCH = AUTOCODE_PROJECT_DEFAULT_BRANCH_MARKER;
const yunxiaoImageCache = new Map<string, string>();

function isYunxiaoProtectedImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname === 'devops.aliyun.com'
      && parsed.pathname.includes('/projex/api/workitem/file/url');
  } catch {
    return false;
  }
}

interface TaskDescriptionImageProps {
  src: string;
  alt: string;
  task: Task;
}

function TaskDescriptionImage({ src, alt, task }: TaskDescriptionImageProps) {
  const [resolvedSrc, setResolvedSrc] = useState(src);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setResolvedSrc(src);

    if (!src) return () => { cancelled = true; };
    if (task.metadata?.sourceType !== 'yunxiao') return () => { cancelled = true; };
    if (!isYunxiaoProtectedImageUrl(src)) return () => { cancelled = true; };

    const cacheKey = `${task.projectId}:${src}`;
    const cached = yunxiaoImageCache.get(cacheKey);
    if (cached) {
      setResolvedSrc(cached);
      return () => { cancelled = true; };
    }

    const load = async () => {
      try {
        const result = await window.electronAPI.loadYunxiaoImage(
          task.projectId,
          src,
          task.metadata?.yunxiaoWorkItemId
        );
        if (cancelled) return;
        if (result.success && result.data) {
          yunxiaoImageCache.set(cacheKey, result.data);
          setResolvedSrc(result.data);
          setLoadError(null);
        } else {
          setLoadError(result.error || 'Failed to load image');
        }
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'Failed to load image');
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [src, task.projectId, task.metadata?.sourceType]);

  return (
    <div className="my-2">
      <img
        src={resolvedSrc}
        alt={alt}
        className="max-w-full h-auto rounded border border-border/50"
        onError={() => {
          if (!loadError) {
            setLoadError('Failed to load image');
          }
        }}
      />
      {loadError ? (
        <button
          type="button"
          onClick={() => window.electronAPI.openExternal(src)}
          className="mt-1 text-xs text-info hover:underline"
        >
          {loadError}
        </button>
      ) : null}
    </div>
  );
}

export function TaskMetadata({ task }: TaskMetadataProps) {
  const { t } = useTranslation(['tasks', 'errors']);
  const { t: tCommon } = useTranslation('common');
  const project = useProjectStore((state) => state.projects.find((entry) => entry.id === task.projectId));
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [isEditingBaseBranch, setIsEditingBaseBranch] = useState(false);
  const [isSavingBaseBranch, setIsSavingBaseBranch] = useState(false);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [branches, setBranches] = useState<GitBranchDetail[]>([]);
  const [projectDefaultBranch, setProjectDefaultBranch] = useState('');
  const [baseBranchDraft, setBaseBranchDraft] = useState(task.metadata?.baseBranch || PROJECT_DEFAULT_BRANCH);
  const [baseBranchError, setBaseBranchError] = useState<string | null>(null);
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
  useEffect(() => {
    setIsExpanded(false);
    const element = contentRef.current;
    if (element) {
      setHasOverflow(element.scrollHeight > COLLAPSED_HEIGHT);
    }
  }, [task.id, task.description]);

  useEffect(() => {
    setBaseBranchDraft(task.metadata?.baseBranch || PROJECT_DEFAULT_BRANCH);
    setBaseBranchError(null);
    setIsEditingBaseBranch(false);
  }, [task.id, task.metadata?.baseBranch]);

  const loadBranchData = useCallback(async () => {
    if (!project?.path) return;

    setIsLoadingBranches(true);
    try {
      const [branchesResult, envResult] = await Promise.all([
        window.electronAPI.getGitBranchesWithInfo(project.path),
        window.electronAPI.getProjectEnv(task.projectId),
      ]);

      if (branchesResult.success && branchesResult.data) {
        setBranches(branchesResult.data);
      } else {
        setBranches([]);
      }

      const envDefaultBranch = envResult.success ? envResult.data?.defaultBranch : undefined;
      if (envDefaultBranch) {
        setProjectDefaultBranch(envDefaultBranch);
        return;
      }

      const detectedBranch = await window.electronAPI.detectMainBranch(project.path);
      if (detectedBranch.success && detectedBranch.data) {
        setProjectDefaultBranch(detectedBranch.data);
      }
    } catch (error) {
      console.error('Failed to load task base branch options:', error);
      setBranches([]);
    } finally {
      setIsLoadingBranches(false);
    }
  }, [project?.path, task.projectId]);

  useEffect(() => {
    if (!isEditingBaseBranch || branches.length > 0 || isLoadingBranches) {
      return;
    }

    let cancelled = false;
    setIsLoadingBranches(true);
    loadBranchData().finally(() => {
      if (cancelled) {
        return;
      }
      setIsLoadingBranches(false);
    });

    return () => {
      cancelled = true;
    };
  }, [branches.length, isEditingBaseBranch, isLoadingBranches, loadBranchData]);

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
  const tokenUsageSourceLabel = task.tokenUsage?.estimated
    ? t('tasks:detail.tokenUsageEstimated', { defaultValue: 'Estimated usage' })
    : t('tasks:detail.tokenUsageProviderReported', { defaultValue: 'Provider-reported usage' });
  const tokenUsageBadgeLabel = task.tokenUsage?.estimated
    ? t('tasks:detail.tokenUsageEstimatedShort', { defaultValue: 'Estimated' })
    : t('tasks:detail.tokenUsageProviderShort', { defaultValue: 'Provider' });
  const tokenUsageCostPolicy = t('tasks:detail.tokenUsageCostPolicy', {
    defaultValue:
      'Cost estimates are not shown until a versioned provider pricing policy is configured. Reconcile token counts against provider billing.',
  });
  const tokenUsageTitle = task.tokenUsage?.totalTokens
    ? [
        buildTokenHoverTitle(
          t('tasks:detail.totalTokens', { defaultValue: 'Total Tokens' }),
          task.tokenUsage.totalTokens
        ),
        tokenUsageSourceLabel,
        tokenUsageCostPolicy,
      ].join('\n')
    : undefined;

  const markdownComponents = useMemo<Components>(() => ({
    img: ({ src, alt }) => {
      if (!src) return null;
      return <TaskDescriptionImage src={src} alt={alt || ''} task={task} />;
    }
  }), [task]);

  const branchOptions = useMemo(() => buildBranchOptions(branches, {
    t,
    includeProjectDefault: {
      value: PROJECT_DEFAULT_BRANCH,
      branchName: projectDefaultBranch,
      labelKey: projectDefaultBranch
        ? 'tasks:metadata.baseBranchProjectDefaultWithBranch'
        : 'tasks:metadata.baseBranchProjectDefault',
    },
  }), [branches, projectDefaultBranch, t]);

  const displayedBaseBranch = task.metadata?.baseBranch
    || projectDefaultBranch
    || t('tasks:metadata.baseBranchProjectDefault', { defaultValue: 'Use project default' });

  const handleSaveBaseBranch = async () => {
    const nextBaseBranch = baseBranchDraft === PROJECT_DEFAULT_BRANCH ? undefined : baseBranchDraft.trim();

    setIsSavingBaseBranch(true);
    setBaseBranchError(null);
    const success = await persistUpdateTask(task.id, {
      metadata: {
        baseBranch: nextBaseBranch || undefined,
      },
    }, task.projectId);
    setIsSavingBaseBranch(false);

    if (!success) {
      setBaseBranchError(t('tasks:metadata.baseBranchUpdateFailed', {
        defaultValue: 'Unable to save the base branch right now.',
      }));
      return;
    }

    setIsEditingBaseBranch(false);
  };

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
            <span
              className="flex items-center gap-1.5"
              title={tokenUsageTitle}
            >
              <Gauge className="h-3 w-3" />
              {t('tasks:detail.tokensLabel', { defaultValue: 'Tokens' })} {formatTokenCount(task.tokenUsage.totalTokens)}
              <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                {tokenUsageBadgeLabel}
              </Badge>
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
        <div className="space-y-2">
          <div className="grid gap-2 md:grid-cols-3">
            {tokenStatItems.map((stat) => (
              <div
                key={stat.key}
                className="rounded-lg border border-border bg-muted/20 px-3 py-2"
                title={buildTokenHoverTitle(stat.label, stat.value)}
              >
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {stat.label}
                </div>
                <div className="mt-1 text-sm font-semibold text-foreground tabular-nums">
                  {formatTokenCount(stat.value)}
                </div>
              </div>
            ))}
          </div>
          <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {t('tasks:detail.tokenUsageCostLabel', { defaultValue: 'Cost estimate' })}:
            </span>{' '}
            {t('tasks:detail.tokenUsageCostUnavailable', { defaultValue: 'Not configured' })}
            <span className="mx-2 text-border">|</span>
            {tokenUsageSourceLabel}. {tokenUsageCostPolicy}
          </div>
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
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
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

      <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
              <GitBranch className="h-3 w-3 text-info" />
              {t('tasks:metadata.baseBranch', { defaultValue: 'Base Branch' })}
            </h3>
            {!isEditingBaseBranch ? (
              <>
                <p className="text-sm font-medium text-foreground break-all">{displayedBaseBranch}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {task.metadata?.baseBranch
                    ? t('tasks:metadata.baseBranchOverrideHelp', {
                        defaultValue: 'This task is overriding the project default branch.',
                      })
                    : t('tasks:metadata.baseBranchDefaultHelp', {
                        defaultValue: 'This task is following the project default branch.',
                      })}
                </p>
              </>
            ) : (
              <div className="space-y-3">
                <Combobox
                  value={baseBranchDraft}
                  onValueChange={setBaseBranchDraft}
                  options={branchOptions}
                  placeholder={projectDefaultBranch
                    ? t('tasks:metadata.baseBranchProjectDefaultWithBranch', {
                        branch: projectDefaultBranch,
                        defaultValue: `Use project default (${projectDefaultBranch})`,
                      })
                    : t('tasks:metadata.baseBranchProjectDefault', {
                        defaultValue: 'Use project default',
                      })}
                  searchPlaceholder={t('tasks:metadata.baseBranchSearch', {
                    defaultValue: 'Search branches...',
                  })}
                  emptyMessage={t('tasks:metadata.baseBranchNoBranches', {
                    defaultValue: 'No branches found',
                  })}
                  disabled={isLoadingBranches || isSavingBaseBranch}
                  className="h-9 min-w-[260px]"
                />
                <p className="text-xs text-muted-foreground">
                  {t('tasks:metadata.baseBranchHelp', {
                    defaultValue: 'Used for future restarts, review diffs, and PR creation for this task.',
                  })}
                </p>
                {baseBranchError ? (
                  <p className="text-xs text-destructive">{baseBranchError}</p>
                ) : null}
              </div>
            )}
          </div>

          {!isEditingBaseBranch ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setBaseBranchDraft(task.metadata?.baseBranch || PROJECT_DEFAULT_BRANCH);
                setBaseBranchError(null);
                setIsEditingBaseBranch(true);
              }}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              {t('tasks:metadata.editBaseBranch', { defaultValue: 'Edit' })}
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setBaseBranchDraft(task.metadata?.baseBranch || PROJECT_DEFAULT_BRANCH);
                  setBaseBranchError(null);
                  setIsEditingBaseBranch(false);
                }}
                disabled={isSavingBaseBranch}
              >
                <X className="mr-1.5 h-3.5 w-3.5" />
                {t('common:buttons.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button size="sm" onClick={() => void handleSaveBaseBranch()} disabled={isSavingBaseBranch || isLoadingBranches}>
                {isSavingBaseBranch ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t('tasks:metadata.saveBaseBranch', { defaultValue: 'Save' })}
              </Button>
            </div>
          )}
        </div>
      </div>

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
