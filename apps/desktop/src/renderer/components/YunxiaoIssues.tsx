import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertCircle,
  Bug,
  ExternalLink,
  Eye,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  PlusCircle,
  Sparkles,
  X
} from 'lucide-react';
import { useProjectStore } from '../stores/project-store';
import { useTaskStore, loadTasks } from '../stores/task-store';
import {
  useYunxiaoIssuesStore,
  checkYunxiaoIssueConnection,
  loadYunxiaoIssues,
  saveYunxiaoIssueLocalFields,
  syncYunxiaoIssues
} from '../stores/yunxiao-issues-store';
import { useToast } from '../hooks/use-toast';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Textarea } from './ui/textarea';
import { Switch } from './ui/switch';
import { Label } from './ui/label';
import { cn } from '../lib/utils';
import type { YunxiaoIssue } from '../../shared/types';
import { isClosedYunxiaoStatus } from '../../shared/utils/yunxiao-status';
import { useAutoFix } from './yunxiao-issues/hooks/useAutoFix';
import { useAnalyzePreview } from './yunxiao-issues/hooks/useAnalyzePreview';
import { YunxiaoBatchReviewWizard } from './yunxiao-issues/components/YunxiaoBatchReviewWizard';

interface YunxiaoIssuesProps {
  onOpenSettings: () => void;
  onNavigateToTask: (taskId: string) => void;
}

const LOCAL_CATEGORY_OPTIONS = [
  'unclassified',
  'gameplay',
  'balance',
  'economy',
  'ui',
  'performance',
  'network',
  'backend',
  'pipeline'
] as const;
const LOCAL_CATEGORY_OPTION_SET = new Set<string>(LOCAL_CATEGORY_OPTIONS);

const LOCAL_SEVERITY_OPTIONS = ['all', 'critical', 'high', 'medium', 'low'] as const;

const yunxiaoImageCache = new Map<string, string>();

function isClosedIssueStatus(status?: string): boolean {
  const normalized = (status || '').trim().toLowerCase();
  if (!normalized) return false;
  const closedTokens = [
    'closed',
    'resolved',
    'done',
    'completed',
    'complete',
    'fixed',
    'canceled',
    'cancelled',
    '已关闭',
    '关闭',
    '已解决',
    '解决',
    '已完成',
    '完成',
    '已修复',
    '修复',
    '已取消',
    '取消'
  ];
  return closedTokens.some((token) => normalized.includes(token));
}

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

interface YunxiaoIssueImageProps {
  projectId: string;
  issue: YunxiaoIssue;
  src: string;
  alt: string;
  fallbackErrorText: string;
}

function YunxiaoIssueImage({ projectId, issue, src, alt, fallbackErrorText }: YunxiaoIssueImageProps) {
  const [resolvedSrc, setResolvedSrc] = useState(src);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setResolvedSrc(src);

    if (!src || !isYunxiaoProtectedImageUrl(src)) {
      return () => {
        cancelled = true;
      };
    }

    const cacheKey = `${projectId}:${issue.workItemId}:${src}`;
    const cached = yunxiaoImageCache.get(cacheKey);
    if (cached) {
      setResolvedSrc(cached);
      return () => {
        cancelled = true;
      };
    }

    const load = async () => {
      try {
        const result = await window.electronAPI.loadYunxiaoImage(projectId, src, issue.workItemId);
        if (cancelled) return;
        if (result.success && result.data) {
          yunxiaoImageCache.set(cacheKey, result.data);
          setResolvedSrc(result.data);
          return;
        }
        setLoadError(result.error || fallbackErrorText);
      } catch (error) {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : fallbackErrorText);
      }
    };
    void load();

    return () => {
      cancelled = true;
    };
  }, [fallbackErrorText, issue.id, issue.workItemId, projectId, src]);

  return (
    <div className="my-2">
      <img src={resolvedSrc} alt={alt} className="max-w-full h-auto rounded border border-border/50" />
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

export function YunxiaoIssues({ onOpenSettings, onNavigateToTask }: YunxiaoIssuesProps) {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const projects = useProjectStore((state) => state.projects);
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const tasks = useTaskStore((state) => state.tasks);
  const {
    config: autoFixConfig,
    activeQueueCount,
    getQueueItem,
    toggleAutoFix,
    checkForNewIssues,
  } = useAutoFix(selectedProject?.id);
  const {
    isWizardOpen,
    isAnalyzing,
    isApproving,
    analysisProgress,
    analysisResult,
    analysisError,
    openWizard,
    closeWizard,
    startAnalysis,
    approveBatches,
  } = useAnalyzePreview({ projectId: selectedProject?.id || '' });

  const issues = useYunxiaoIssuesStore((state) => state.issues);
  const syncStatus = useYunxiaoIssuesStore((state) => state.syncStatus);
  const isLoading = useYunxiaoIssuesStore((state) => state.isLoading);
  const isSyncing = useYunxiaoIssuesStore((state) => state.isSyncing);
  const error = useYunxiaoIssuesStore((state) => state.error);
  const selectedWorkItemId = useYunxiaoIssuesStore((state) => state.selectedWorkItemId);
  const selectIssue = useYunxiaoIssuesStore((state) => state.selectIssue);

  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [analysisDraft, setAnalysisDraft] = useState('');
  const [newCategoryDraft, setNewCategoryDraft] = useState('');
  const [isGeneratingAnalysis, setIsGeneratingAnalysis] = useState(false);
  const [isDeletingCategory, setIsDeletingCategory] = useState<string | null>(null);

  const getCategoryLabel = useCallback((option: string) => {
    if (LOCAL_CATEGORY_OPTION_SET.has(option)) {
      return t(`yunxiaoIssues.categories.${option}`, { defaultValue: option });
    }
    return option;
  }, [t]);

  const getSeverityLabel = useCallback((option: string) => (
    t(`yunxiaoIssues.severity.${option}`, { defaultValue: option })
  ), [t]);

  const openIssues = useMemo(() => (
    issues.filter((issue) => !isClosedYunxiaoStatus(issue.statusName))
  ), [issues]);

  const selectedIssue = useMemo(() => {
    if (!selectedWorkItemId) return null;
    return openIssues.find((issue) => issue.workItemId === selectedWorkItemId) || null;
  }, [openIssues, selectedWorkItemId]);

  useEffect(() => {
    if (!selectedIssue) {
      setAnalysisDraft('');
      setNewCategoryDraft('');
      return;
    }
    setAnalysisDraft(selectedIssue.localAnalysis || '');
    setNewCategoryDraft('');
  }, [selectedIssue?.workItemId, selectedIssue?.localAnalysis]);

  const customCategoryOptions = useMemo(() => {
    const custom = new Set<string>();
    for (const issue of openIssues) {
      const category = (issue.localCategory || '').trim();
      if (!category || category === 'all' || LOCAL_CATEGORY_OPTION_SET.has(category)) continue;
      custom.add(category);
    }
    return Array.from(custom).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [openIssues]);

  const categoryOptions = useMemo(() => {
    return [...LOCAL_CATEGORY_OPTIONS, ...customCategoryOptions];
  }, [customCategoryOptions]);

  const issueToTaskMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      const workItemId = task.metadata?.yunxiaoWorkItemId;
      const workItemIds = task.metadata?.yunxiaoWorkItemIds || [];
      if (workItemId) {
        map.set(workItemId, task.specId || task.id);
      }
      for (const batchWorkItemId of workItemIds) {
        map.set(batchWorkItemId, task.specId || task.id);
      }
    }
    return map;
  }, [tasks]);

  const markdownComponents = useMemo<Components>(() => ({
    img: ({ src, alt }) => {
      if (!src || !selectedIssue) return null;
      if (!selectedProject?.id) return null;
      return (
        <YunxiaoIssueImage
          projectId={selectedProject.id}
          issue={selectedIssue}
          src={src}
          alt={alt || ''}
          fallbackErrorText={t('yunxiaoIssues.messages.imageLoadFailed', { defaultValue: 'Failed to load image' })}
        />
      );
    }
  }), [selectedIssue, selectedProject?.id, t]);

  const loadAndSync = useCallback(async () => {
    if (!selectedProject?.id) return;

    const status = await checkYunxiaoIssueConnection(selectedProject.id);
    if (!status?.connected) return;

    await loadYunxiaoIssues(selectedProject.id);
    await syncYunxiaoIssues(selectedProject.id);
  }, [selectedProject?.id]);

  useEffect(() => {
    if (!selectedProject?.id) return;
    void loadAndSync();
  }, [selectedProject?.id, loadAndSync]);

  useEffect(() => {
    if (!selectedProject?.id || !autoFixConfig?.enabled) return;
    void checkForNewIssues();
  }, [autoFixConfig?.enabled, checkForNewIssues, selectedProject?.id]);

  useEffect(() => {
    if (!selectedIssue && openIssues.length > 0) {
      selectIssue(openIssues[0].workItemId);
    }
  }, [openIssues, selectedIssue, selectIssue]);

  const filteredIssues = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return openIssues.filter((issue) => {
      const matchesQuery = !query
        || issue.title.toLowerCase().includes(query)
        || (issue.identifier || '').toLowerCase().includes(query);
      const issueCategory = issue.localCategory || 'unclassified';
      const matchesCategory = categoryFilter === 'all' || issueCategory === categoryFilter;
      const issueSeverity = issue.localSeverity || 'low';
      const matchesSeverity = severityFilter === 'all' || issueSeverity === severityFilter;
      return matchesQuery && matchesCategory && matchesSeverity;
    });
  }, [categoryFilter, openIssues, searchQuery, severityFilter]);

  const handleRefresh = useCallback(async () => {
    if (!selectedProject?.id) return;
    const result = await syncYunxiaoIssues(selectedProject.id);
    if (autoFixConfig?.enabled) {
      await checkForNewIssues();
    }
    if (result) {
      toast({
        title: t('labels.success', { defaultValue: 'Success' }),
        description: t('yunxiaoIssues.messages.syncSummary', {
          defaultValue: 'Yunxiao synced: +{{created}} / ~{{updated}} / -{{removed}}',
          created: result.created,
          updated: result.updated,
          removed: result.removed
        })
      });
    }
  }, [autoFixConfig?.enabled, checkForNewIssues, selectedProject?.id, t, toast]);

  const handleSaveClassification = useCallback(async (workItemId: string, updates: {
    localCategory?: string;
    localSeverity?: 'low' | 'medium' | 'high' | 'critical';
  }) => {
    if (!selectedProject?.id) return;
    await saveYunxiaoIssueLocalFields(selectedProject.id, workItemId, updates);
  }, [selectedProject?.id]);

  const handleSaveAnalysis = useCallback(async () => {
    if (!selectedProject?.id || !selectedIssue) return;
    const ok = await saveYunxiaoIssueLocalFields(selectedProject.id, selectedIssue.workItemId, {
      localAnalysis: analysisDraft
    });
    if (ok) {
      toast({
        title: t('labels.success', { defaultValue: 'Success' }),
        description: t('yunxiaoIssues.messages.analysisSaved', { defaultValue: 'Yunxiao issue analysis saved' })
      });
    }
  }, [analysisDraft, selectedIssue, selectedProject?.id, t, toast]);

  const handleAddCategory = useCallback(async () => {
    if (!selectedProject?.id || !selectedIssue) return;
    const value = newCategoryDraft.trim();
    if (!value) {
      toast({
        title: t('labels.error', { defaultValue: 'Error' }),
        description: t('yunxiaoIssues.messages.categoryEmpty', { defaultValue: 'Category cannot be empty' })
      });
      return;
    }
    if (value.length > 50) {
      toast({
        title: t('labels.error', { defaultValue: 'Error' }),
        description: t('yunxiaoIssues.messages.categoryTooLong', { defaultValue: 'Category must be 50 characters or fewer' })
      });
      return;
    }

    await handleSaveClassification(selectedIssue.workItemId, { localCategory: value });
    setNewCategoryDraft('');
    toast({
      title: t('labels.success', { defaultValue: 'Success' }),
      description: t('yunxiaoIssues.messages.categoryAdded', { defaultValue: 'Category updated' })
    });
  }, [handleSaveClassification, newCategoryDraft, selectedIssue, selectedProject?.id, t, toast]);

  const handleDeleteCategory = useCallback(async (category: string) => {
    if (!selectedProject?.id) return;
    const target = category.trim();
    if (!target || LOCAL_CATEGORY_OPTION_SET.has(target)) return;

    const affectedIssues = openIssues.filter((issue) => (issue.localCategory || '').trim() === target);
    if (affectedIssues.length === 0) return;

    setIsDeletingCategory(target);
    try {
      let successCount = 0;
      for (const issue of affectedIssues) {
        const ok = await saveYunxiaoIssueLocalFields(selectedProject.id, issue.workItemId, { localCategory: '' });
        if (ok) successCount += 1;
      }

      if (categoryFilter === target) {
        setCategoryFilter('all');
      }

      if (successCount === affectedIssues.length) {
        toast({
          title: t('labels.success', { defaultValue: 'Success' }),
          description: t('yunxiaoIssues.messages.categoryDeleted', {
            defaultValue: 'Category deleted and {{count}} issue(s) reset to unclassified',
            count: successCount
          })
        });
      } else {
        toast({
          title: t('yunxiaoIssues.messages.categoryDeleteFailedTitle', { defaultValue: 'Delete failed' }),
          description: t('yunxiaoIssues.messages.categoryDeletePartial', {
            defaultValue: 'Only {{success}}/{{total}} issues were updated',
            success: successCount,
            total: affectedIssues.length
          })
        });
      }
    } finally {
      setIsDeletingCategory(null);
    }
  }, [categoryFilter, openIssues, selectedProject?.id, t, toast]);

  const handleDeleteCategoryFromDraft = useCallback(async () => {
    const value = newCategoryDraft.trim();
    if (!value) {
      toast({
        title: t('labels.error', { defaultValue: 'Error' }),
        description: t('yunxiaoIssues.messages.categoryEmpty', { defaultValue: 'Category cannot be empty' })
      });
      return;
    }
    if (LOCAL_CATEGORY_OPTION_SET.has(value)) {
      toast({
        title: t('yunxiaoIssues.messages.categoryDeleteFailedTitle', { defaultValue: 'Delete failed' }),
        description: t('yunxiaoIssues.messages.cannotDeleteBuiltinCategory', { defaultValue: 'Built-in categories cannot be deleted' })
      });
      return;
    }
    const exists = customCategoryOptions.includes(value);
    if (!exists) {
      toast({
        title: t('yunxiaoIssues.messages.categoryDeleteFailedTitle', { defaultValue: 'Delete failed' }),
        description: t('yunxiaoIssues.messages.categoryNotFound', { defaultValue: 'Category not found' })
      });
      return;
    }
    await handleDeleteCategory(value);
    setNewCategoryDraft('');
  }, [customCategoryOptions, handleDeleteCategory, newCategoryDraft, t, toast]);

  const handleGenerateAnalysis = useCallback(async () => {
    if (!selectedProject?.id || !selectedIssue) return;
    setIsGeneratingAnalysis(true);
    try {
      const result = await window.electronAPI.analyzeYunxiaoIssue(
        selectedProject.id,
        selectedIssue.workItemId
      );
      if (!result.success || !result.data) {
        toast({
          title: t('yunxiaoIssues.messages.analysisGenerateFailedTitle', { defaultValue: 'Generation failed' }),
          description: result.error || t('yunxiaoIssues.messages.analysisGenerateFailed', { defaultValue: 'Failed to generate Yunxiao issue analysis' })
        });
        return;
      }

      setAnalysisDraft(result.data);
      toast({
        title: t('labels.success', { defaultValue: 'Success' }),
        description: t('yunxiaoIssues.messages.analysisGenerated', { defaultValue: 'AI analysis draft generated' })
      });
    } finally {
      setIsGeneratingAnalysis(false);
    }
  }, [selectedIssue, selectedProject?.id, t, toast]);

  const handleAddToKanban = useCallback(async () => {
    if (!selectedProject?.id || !selectedIssue) return;
    const importResult = await window.electronAPI.importYunxiaoWorkItems(
      selectedProject.id,
      [selectedIssue.workItemId],
      {
        spaceId: selectedIssue.spaceId,
        category: 'Bug'
      }
    );
    if (!importResult.success || !importResult.data || importResult.data.failed > 0) {
      toast({
        title: t('yunxiaoIssues.messages.importFailedTitle', { defaultValue: 'Import failed' }),
        description: importResult.error || importResult.data?.errors?.[0] || t('yunxiaoIssues.messages.importFailed', { defaultValue: 'Failed to import Yunxiao issue' })
      });
      return;
    }

    await loadTasks(selectedProject.id, { forceRefresh: true });
    toast({
      title: t('labels.success', { defaultValue: 'Success' }),
      description: t('yunxiaoIssues.messages.addedToKanban', { defaultValue: 'Yunxiao issue added to Kanban' })
    });
  }, [selectedIssue, selectedProject?.id, t, toast]);

  const autoFixQueueItem = selectedIssue ? getQueueItem(selectedIssue.workItemId) : null;

  if (!syncStatus?.connected) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-md w-full rounded-lg border border-border bg-card p-6 text-center space-y-3">
          <Bug className="h-8 w-8 mx-auto text-muted-foreground" />
          <h2 className="text-lg font-semibold text-foreground">
            {t('yunxiaoIssues.title', { defaultValue: 'Yunxiao Issues' })}
          </h2>
          <p className="text-sm text-muted-foreground">
            {syncStatus?.error || t('yunxiaoIssues.messages.notConnected', { defaultValue: 'Yunxiao is not connected for this project.' })}
          </p>
          <Button onClick={onOpenSettings}>
            {t('yunxiaoIssues.actions.openProjectSettings', { defaultValue: 'Open Project Settings' })}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="shrink-0 p-4 border-b border-border">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-muted">
              <Bug className="h-5 w-5 text-red-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                {t('yunxiaoIssues.title', { defaultValue: 'Yunxiao Issues' })}
              </h2>
              <p className="text-xs text-muted-foreground">
                {selectedProject?.name || ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">
              {t('yunxiaoIssues.openBugsCount', {
                defaultValue: '{{count}} open bugs',
                count: filteredIssues.length
              })}
            </Badge>
            <Button variant="ghost" size="icon" onClick={() => void handleRefresh()} disabled={isSyncing}>
              <RefreshCw className={cn('h-4 w-4', isSyncing && 'animate-spin')} />
            </Button>
          </div>
        </div>

        <div className="mb-4 flex items-center gap-3">
          <Button
            variant="outline"
            onClick={openWizard}
            disabled={isLoading || isAnalyzing}
            className="flex-1"
          >
            {isAnalyzing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            {t('yunxiaoIssues.actions.analyzeAndGroup', {
              defaultValue: '分析并分组问题'
            })}
          </Button>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
            <ShieldAlert className={cn('h-4 w-4', activeQueueCount > 0 ? 'text-primary' : 'text-muted-foreground')} />
            <Label htmlFor="yunxiao-auto-fix-toggle" className="cursor-pointer whitespace-nowrap text-sm">
              {t('yunxiaoIssues.actions.autoFixNew', {
                defaultValue: '自动修复新问题'
              })}
            </Label>
            <Switch
              id="yunxiao-auto-fix-toggle"
              checked={autoFixConfig?.enabled ?? false}
              onCheckedChange={(checked) => {
                void toggleAutoFix(checked);
              }}
            />
            {activeQueueCount > 0 ? (
              <Badge variant="secondary">
                {t('yunxiaoIssues.badges.autoFixRunning', {
                  count: activeQueueCount,
                  defaultValue: '{{count}} 个执行中'
                })}
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('yunxiaoIssues.searchPlaceholder', { defaultValue: 'Search bug title / identifier' })}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t('yunxiaoIssues.filters.allCategories', { defaultValue: 'All Categories' })}
              </SelectItem>
              {categoryOptions.map((option) => (
                <SelectItem key={option} value={option}>
                  {getCategoryLabel(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={severityFilter} onValueChange={setSeverityFilter}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCAL_SEVERITY_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {getSeverityLabel(option)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="w-1/2 border-r border-border flex flex-col">
          {error ? (
            <div className="p-4 bg-destructive/10 border-b border-destructive/30">
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            </div>
          ) : null}

          {isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {filteredIssues.map((issue) => {
                  const linkedTaskId = issueToTaskMap.get(issue.workItemId);
                  const isSelected = selectedWorkItemId === issue.workItemId;
                  return (
                    <button
                      key={issue.id}
                      type="button"
                      onClick={() => selectIssue(issue.workItemId)}
                      className={cn(
                        'w-full text-left p-3 rounded-lg border transition-colors',
                        isSelected
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-card hover:bg-muted/40'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-foreground line-clamp-1">{issue.title}</p>
                        {linkedTaskId ? (
                          <Badge variant="secondary" className="text-[10px]">
                            {t('yunxiaoIssues.badges.inKanban', { defaultValue: 'in Kanban' })}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {issue.identifier ? <span>{issue.identifier}</span> : null}
                        {issue.priority ? <span>{issue.priority}</span> : null}
                        {issue.statusName ? <span>{issue.statusName}</span> : null}
                        <span>{getCategoryLabel(issue.localCategory || 'unclassified')}</span>
                      </div>
                    </button>
                  );
                })}
                {!isLoading && filteredIssues.length === 0 ? (
                  <div className="py-10 text-center text-sm text-muted-foreground">
                    {t('yunxiaoIssues.messages.noBugs', { defaultValue: 'No Yunxiao bugs found' })}
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          )}
        </div>

        <div className="w-1/2 flex flex-col">
          {!selectedIssue ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              {t('yunxiaoIssues.messages.selectIssue', { defaultValue: 'Select a Yunxiao issue to view details' })}
            </div>
          ) : (
            <ScrollArea className="flex-1">
              <div className="p-4 space-y-4">
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        {selectedIssue.identifier || selectedIssue.workItemId}
                      </p>
                      <h3 className="text-lg font-semibold text-foreground">{selectedIssue.title}</h3>
                    </div>
                    {selectedIssue.url ? (
                      <Button variant="ghost" size="icon" asChild>
                        <a href={selectedIssue.url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">
                      {selectedIssue.statusName || t('yunxiaoIssues.messages.open', { defaultValue: 'open' })}
                    </Badge>
                    {selectedIssue.priority ? <Badge variant="outline">{selectedIssue.priority}</Badge> : null}
                    {selectedIssue.spaceName ? <Badge variant="outline">{selectedIssue.spaceName}</Badge> : null}
                    {autoFixQueueItem ? (
                      <Badge variant={autoFixQueueItem.status === 'failed' ? 'destructive' : 'secondary'}>
                        {autoFixQueueItem.status === 'failed'
                          ? t('yunxiaoIssues.badges.autoFixFailed', { defaultValue: '自动修复失败' })
                          : autoFixQueueItem.status === 'completed'
                            ? t('yunxiaoIssues.badges.autoFixCreated', { defaultValue: '已加入自动修复' })
                            : t('yunxiaoIssues.badges.autoFixInProgress', { defaultValue: '自动修复中' })}
                      </Badge>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs mb-1 text-muted-foreground">
                      {t('yunxiaoIssues.fields.category', { defaultValue: 'Category' })}
                    </p>
                    <Select
                      value={selectedIssue.localCategory || 'unclassified'}
                      onValueChange={(value) => {
                        void handleSaveClassification(selectedIssue.workItemId, { localCategory: value });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {categoryOptions.map((option) => (
                          <SelectItem key={option} value={option}>
                            {getCategoryLabel(option)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="mt-2 flex items-center gap-2">
                      <Input
                        value={newCategoryDraft}
                        onChange={(event) => setNewCategoryDraft(event.target.value)}
                        placeholder={t('yunxiaoIssues.fields.newCategoryPlaceholder', { defaultValue: 'Enter custom category' })}
                      />
                      <Button variant="secondary" onClick={() => void handleAddCategory()}>
                        {t('yunxiaoIssues.actions.addCategory', { defaultValue: 'Add Category' })}
                      </Button>
                      <Button variant="outline" onClick={() => void handleDeleteCategoryFromDraft()}>
                        {t('yunxiaoIssues.actions.deleteCategory', { defaultValue: 'Delete Category' })}
                      </Button>
                    </div>
                    {customCategoryOptions.length > 0 ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {customCategoryOptions.map((category) => (
                          <Badge key={category} variant="secondary" className="flex items-center gap-1 pr-1">
                            <span>{category}</span>
                            <button
                              type="button"
                              onClick={() => void handleDeleteCategory(category)}
                              className="inline-flex items-center justify-center rounded-sm p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
                              disabled={isDeletingCategory === category}
                              title={t('yunxiaoIssues.actions.deleteCategory', { defaultValue: 'Delete Category' })}
                            >
                              {isDeletingCategory === category ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <X className="h-3 w-3" />
                              )}
                            </button>
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <p className="text-xs mb-1 text-muted-foreground">
                      {t('yunxiaoIssues.fields.severity', { defaultValue: 'Severity' })}
                    </p>
                    <Select
                      value={selectedIssue.localSeverity || 'medium'}
                      onValueChange={(value: 'low' | 'medium' | 'high' | 'critical') => {
                        void handleSaveClassification(selectedIssue.workItemId, { localSeverity: value });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="critical">{getSeverityLabel('critical')}</SelectItem>
                        <SelectItem value="high">{getSeverityLabel('high')}</SelectItem>
                        <SelectItem value="medium">{getSeverityLabel('medium')}</SelectItem>
                        <SelectItem value="low">{getSeverityLabel('low')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    {t('yunxiaoIssues.fields.analysis', { defaultValue: 'Bug Analysis' })}
                  </p>
                  <Textarea
                    value={analysisDraft}
                    onChange={(event) => setAnalysisDraft(event.target.value)}
                    placeholder={t('yunxiaoIssues.fields.analysisPlaceholder', {
                      defaultValue: 'Root cause / reproduction / workaround / risk...'
                    })}
                    className="min-h-28"
                  />
                  <div className="flex items-center gap-2">
                    <Button variant="outline" onClick={() => void handleGenerateAnalysis()} disabled={isGeneratingAnalysis}>
                      {isGeneratingAnalysis ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Sparkles className="h-4 w-4 mr-2" />
                      )}
                      {isGeneratingAnalysis
                        ? t('yunxiaoIssues.actions.generatingAnalysis', { defaultValue: 'Generating...' })
                        : t('yunxiaoIssues.actions.generateAnalysis', { defaultValue: 'AI Analysis' })}
                    </Button>
                    <Button variant="outline" onClick={() => void handleSaveAnalysis()}>
                      <ShieldAlert className="h-4 w-4 mr-2" />
                      {t('yunxiaoIssues.actions.saveAnalysis', { defaultValue: 'Save Analysis' })}
                    </Button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {issueToTaskMap.get(selectedIssue.workItemId) ? (
                    <Button
                      variant="secondary"
                      onClick={() => onNavigateToTask(issueToTaskMap.get(selectedIssue.workItemId)!)}
                    >
                      <Eye className="h-4 w-4 mr-2" />
                      {t('yunxiaoIssues.actions.viewTask', { defaultValue: 'View Task' })}
                    </Button>
                  ) : (
                    <Button onClick={() => void handleAddToKanban()}>
                      <PlusCircle className="h-4 w-4 mr-2" />
                      {t('yunxiaoIssues.actions.addToKanban', { defaultValue: 'Add To Kanban' })}
                    </Button>
                  )}
                </div>

                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  {selectedIssue.description ? (
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {selectedIssue.description}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t('yunxiaoIssues.messages.noDescription', { defaultValue: 'No description' })}
                    </p>
                  )}
                </div>
              </div>
            </ScrollArea>
          )}
        </div>
      </div>

      <YunxiaoBatchReviewWizard
        isOpen={isWizardOpen}
        onClose={closeWizard}
        onStartAnalysis={startAnalysis}
        onApproveBatches={approveBatches}
        analysisProgress={analysisProgress}
        analysisResult={analysisResult}
        analysisError={analysisError}
        isAnalyzing={isAnalyzing}
        isApproving={isApproving}
      />
    </div>
  );
}
