import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Layers, Loader2, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Progress } from '../../ui/progress';
import { ScrollArea } from '../../ui/scroll-area';
import { Badge } from '../../ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import type {
  YunxiaoAnalyzePreviewProgress,
  YunxiaoAnalyzePreviewResult,
  YunxiaoProposedBatch,
} from '../../../../shared/types';

interface YunxiaoBatchReviewWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onStartAnalysis: () => void;
  onApproveBatches: (batches: YunxiaoProposedBatch[]) => Promise<void>;
  analysisProgress: YunxiaoAnalyzePreviewProgress | null;
  analysisResult: YunxiaoAnalyzePreviewResult | null;
  analysisError: string | null;
  isAnalyzing: boolean;
  isApproving: boolean;
}

export function YunxiaoBatchReviewWizard({
  isOpen,
  onClose,
  onStartAnalysis,
  onApproveBatches,
  analysisProgress,
  analysisResult,
  analysisError,
  isAnalyzing,
  isApproving,
}: YunxiaoBatchReviewWizardProps) {
  const { t } = useTranslation('common');
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<number>>(new Set());
  const [selectedSingleIds, setSelectedSingleIds] = useState<Set<string>>(new Set());
  const [expandedBatchIds, setExpandedBatchIds] = useState<Set<number>>(new Set());
  const [step, setStep] = useState<'intro' | 'analyzing' | 'review' | 'approving' | 'done'>('intro');

  useEffect(() => {
    if (!isOpen) return;
    setSelectedBatchIds(new Set());
    setSelectedSingleIds(new Set());
    setExpandedBatchIds(new Set());
    setStep('intro');
  }, [isOpen]);

  useEffect(() => {
    if (isAnalyzing) {
      setStep('analyzing');
      return;
    }
    if (analysisResult) {
      setStep('review');
      setSelectedBatchIds(new Set(analysisResult.proposedBatches.map((_, index) => index)));
      setSelectedSingleIds(new Set(analysisResult.singleIssues.map((issue) => issue.workItemId)));
      return;
    }
    if (analysisError) {
      setStep('intro');
    }
  }, [analysisError, analysisResult, isAnalyzing]);

  useEffect(() => {
    if (isApproving) {
      setStep('approving');
    }
  }, [isApproving]);

  const selectedIssueCount = useMemo(() => {
    if (!analysisResult) return 0;
    const batchIssueCount = analysisResult.proposedBatches
      .filter((_, index) => selectedBatchIds.has(index))
      .reduce((sum, batch) => sum + batch.issueCount, 0);
    return batchIssueCount + selectedSingleIds.size;
  }, [analysisResult, selectedBatchIds, selectedSingleIds]);

  const toggleBatchSelection = useCallback((batchIndex: number) => {
    setSelectedBatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(batchIndex)) next.delete(batchIndex);
      else next.add(batchIndex);
      return next;
    });
  }, []);

  const toggleSingleSelection = useCallback((workItemId: string) => {
    setSelectedSingleIds((prev) => {
      const next = new Set(prev);
      if (next.has(workItemId)) next.delete(workItemId);
      else next.add(workItemId);
      return next;
    });
  }, []);

  const toggleExpanded = useCallback((batchIndex: number) => {
    setExpandedBatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(batchIndex)) next.delete(batchIndex);
      else next.add(batchIndex);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (!analysisResult) return;
    setSelectedBatchIds(new Set(analysisResult.proposedBatches.map((_, index) => index)));
    setSelectedSingleIds(new Set(analysisResult.singleIssues.map((issue) => issue.workItemId)));
  }, [analysisResult]);

  const clearSelection = useCallback(() => {
    setSelectedBatchIds(new Set());
    setSelectedSingleIds(new Set());
  }, []);

  const handleApprove = useCallback(async () => {
    if (!analysisResult) return;

    const approvedBatches = analysisResult.proposedBatches
      .filter((_, index) => selectedBatchIds.has(index))
      .map((batch, index) => ({
        ...batch,
        batchId: batch.batchId || `yunxiao-batch-${index + 1}`,
        validated: true,
      }));

    const approvedSingles = analysisResult.singleIssues
      .filter((issue) => selectedSingleIds.has(issue.workItemId))
      .map((issue) => ({
        batchId: `yunxiao-single-${issue.workItemId}`,
        primaryWorkItemId: issue.workItemId,
        theme: issue.title,
        reasoning: t('yunxiaoIssues.batchReview.singleIssueReasoning', {
          defaultValue: '单个问题，不与其它问题合并',
        }),
        confidence: 1,
        validated: true,
        issueCount: 1,
        commonThemes: [],
        issues: [{
          workItemId: issue.workItemId,
          identifier: issue.identifier,
          title: issue.title,
          labels: issue.labels,
          similarityToPrimary: 1,
        }],
      }));

    await onApproveBatches([...approvedBatches, ...approvedSingles]);
    setStep('done');
  }, [analysisResult, onApproveBatches, selectedBatchIds, selectedSingleIds, t]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {t('yunxiaoIssues.batchReview.title', {
              defaultValue: '分析并分组云效问题',
            })}
          </DialogTitle>
          <DialogDescription>
            {t('yunxiaoIssues.batchReview.description', {
              defaultValue: '分析开放缺陷，合并相似问题，再决定哪些需要进入看板。',
            })}
          </DialogDescription>
        </DialogHeader>

        {step === 'intro' ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-5">
            <div className="rounded-full bg-primary/10 p-4">
              <Layers className="h-10 w-10 text-primary" />
            </div>
            <p className="text-sm text-muted-foreground text-center max-w-xl">
              {t('yunxiaoIssues.batchReview.intro', {
                defaultValue: '最多分析 200 个开放缺陷，找出可以一起处理的问题分组，确认后再生成看板任务。',
              })}
            </p>
            {analysisError ? (
              <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                <span>{analysisError}</span>
              </div>
            ) : null}
            <Button onClick={onStartAnalysis}>
              <Layers className="mr-2 h-4 w-4" />
              {t('yunxiaoIssues.batchReview.start', { defaultValue: '开始分析' })}
            </Button>
          </div>
        ) : null}

        {step === 'analyzing' ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-5">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <div className="w-full max-w-md space-y-2">
              <p className="text-center text-sm text-muted-foreground">
                {analysisProgress?.message || t('yunxiaoIssues.batchReview.analyzing', {
                  defaultValue: '正在分析云效问题...',
                })}
              </p>
              <Progress value={analysisProgress?.progress ?? 0} />
            </div>
          </div>
        ) : null}

        {step === 'review' && analysisResult ? (
          <div className="flex flex-col h-[60vh]">
            <div className="mb-4 flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
              <div className="flex items-center gap-3 text-muted-foreground">
                <span>{t('yunxiaoIssues.batchReview.stats.total', { count: analysisResult.totalIssues, defaultValue: '总计 {{count}} 个问题' })}</span>
                <span>{t('yunxiaoIssues.batchReview.stats.analyzed', { count: analysisResult.analyzedIssues, defaultValue: '新分析 {{count}} 个' })}</span>
                <span>{t('yunxiaoIssues.batchReview.stats.tracked', { count: analysisResult.alreadyTracked, defaultValue: '已跟踪 {{count}} 个' })}</span>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={selectAll}>
                  {t('yunxiaoIssues.batchReview.selectAll', { defaultValue: '全选' })}
                </Button>
                <Button variant="ghost" size="sm" onClick={clearSelection}>
                  {t('yunxiaoIssues.batchReview.clearSelection', { defaultValue: '清空' })}
                </Button>
              </div>
            </div>

            <ScrollArea className="flex-1 pr-1">
              <div className="space-y-3">
                {analysisResult.proposedBatches.map((batch, index) => {
                  const expanded = expandedBatchIds.has(index);
                  return (
                    <div key={`${batch.primaryWorkItemId}-${index}`} className="rounded-lg border border-border bg-card p-3">
                      <div className="flex items-start gap-3">
                        <Checkbox
                          checked={selectedBatchIds.has(index)}
                          onCheckedChange={() => toggleBatchSelection(index)}
                        />
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(index)}
                            className="flex w-full items-start justify-between gap-3 text-left"
                          >
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                                <span className="font-medium text-foreground">{batch.theme}</span>
                                <Badge variant="secondary">{t('yunxiaoIssues.batchReview.issueCount', { count: batch.issueCount, defaultValue: '{{count}} 个问题' })}</Badge>
                              </div>
                              <p className="text-sm text-muted-foreground">{batch.reasoning}</p>
                            </div>
                          </button>

                          {expanded ? (
                            <div className="mt-3 space-y-2 pl-6">
                              {batch.issues.map((issue) => (
                                <div key={issue.workItemId} className="rounded-md bg-muted/30 px-3 py-2 text-sm">
                                  <div className="font-medium text-foreground">{issue.identifier || issue.workItemId}</div>
                                  <div className="text-muted-foreground">{issue.title}</div>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {analysisResult.singleIssues.length > 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-3">
                    <p className="mb-3 text-sm font-medium text-foreground">
                      {t('yunxiaoIssues.batchReview.singleIssues', { defaultValue: '未合并的单个问题' })}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {analysisResult.singleIssues.map((issue) => (
                        <button
                          key={issue.workItemId}
                          type="button"
                          onClick={() => toggleSingleSelection(issue.workItemId)}
                          className={`rounded-md border px-3 py-2 text-left text-sm ${
                            selectedSingleIds.has(issue.workItemId)
                              ? 'border-primary bg-primary/5'
                              : 'border-border bg-card'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <Checkbox
                              checked={selectedSingleIds.has(issue.workItemId)}
                              onCheckedChange={() => toggleSingleSelection(issue.workItemId)}
                            />
                            <div className="min-w-0">
                              <div className="font-medium text-foreground">{issue.identifier || issue.workItemId}</div>
                              <div className="text-muted-foreground">{issue.title}</div>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          </div>
        ) : null}

        {step === 'approving' ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-4">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              {t('yunxiaoIssues.batchReview.approving', { defaultValue: '正在生成任务...' })}
            </p>
          </div>
        ) : null}

        {step === 'done' ? (
          <div className="flex flex-col items-center justify-center py-8 space-y-4">
            <CheckCircle2 className="h-10 w-10 text-success" />
            <p className="text-sm text-muted-foreground">
              {t('yunxiaoIssues.batchReview.done', {
                defaultValue: '已根据所选分组创建看板任务',
              })}
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <div className="flex w-full items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {step === 'review'
                ? t('yunxiaoIssues.batchReview.selectedCount', {
                    count: selectedIssueCount,
                    defaultValue: '已选择 {{count}} 个问题',
                  })
                : ' '}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={onClose}>
                {t('buttons.close', { defaultValue: '关闭' })}
              </Button>
              {step === 'review' ? (
                <Button onClick={() => void handleApprove()} disabled={selectedIssueCount === 0 || isApproving}>
                  {t('yunxiaoIssues.batchReview.createTasks', { defaultValue: '创建任务' })}
                </Button>
              ) : null}
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
