import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Layers,
  CheckCircle2,
  Loader2,
  ChevronDown,
  ChevronRight,
  Users,
  Play,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '../../ui/button';
import { Badge } from '../../ui/badge';
import { Progress } from '../../ui/progress';
import { ScrollArea } from '../../ui/scroll-area';
import { Checkbox } from '../../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../ui/collapsible';
import type {
  AnalyzePreviewResult,
  AnalyzePreviewProgress,
  ProposedBatch
} from '../../../../preload/api/modules/github-api';

interface BatchReviewWizardProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  onStartAnalysis: () => void;
  onApproveBatches: (batches: ProposedBatch[]) => Promise<void>;
  analysisProgress: AnalyzePreviewProgress | null;
  analysisResult: AnalyzePreviewResult | null;
  analysisError: string | null;
  isAnalyzing: boolean;
  isApproving: boolean;
}

export function BatchReviewWizard({
  isOpen,
  onClose,
  onStartAnalysis,
  onApproveBatches,
  analysisProgress,
  analysisResult,
  analysisError,
  isAnalyzing,
  isApproving,
}: BatchReviewWizardProps) {
  const { t } = useTranslation('common');
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<number>>(new Set());
  const [selectedSingleIssueNumbers, setSelectedSingleIssueNumbers] = useState<Set<number>>(new Set());
  const [expandedBatchIds, setExpandedBatchIds] = useState<Set<number>>(new Set());
  const [step, setStep] = useState<'intro' | 'analyzing' | 'review' | 'approving' | 'done'>('intro');

  useEffect(() => {
    if (isOpen) {
      setSelectedBatchIds(new Set());
      setSelectedSingleIssueNumbers(new Set());
      setExpandedBatchIds(new Set());
      setStep('intro');
    }
  }, [isOpen]);

  useEffect(() => {
    if (isAnalyzing) {
      setStep('analyzing');
    } else if (analysisResult) {
      setStep('review');
      const validatedIds = new Set(
        analysisResult.proposedBatches
          .filter(b => b.validated)
          .map((_, idx) => idx)
      );
      setSelectedBatchIds(validatedIds);

      if (analysisResult.proposedBatches.length === 0 && analysisResult.singleIssues.length > 0) {
        const singleIssueNumbers = new Set(
          analysisResult.singleIssues.map(issue => issue.issueNumber)
        );
        setSelectedSingleIssueNumbers(singleIssueNumbers);
      }
    } else if (analysisError) {
      setStep('intro');
    }
  }, [isAnalyzing, analysisResult, analysisError]);

  useEffect(() => {
    if (isApproving) {
      setStep('approving');
    }
  }, [isApproving]);

  const toggleBatchSelection = useCallback((batchIndex: number) => {
    setSelectedBatchIds(prev => {
      const next = new Set(prev);
      if (next.has(batchIndex)) {
        next.delete(batchIndex);
      } else {
        next.add(batchIndex);
      }
      return next;
    });
  }, []);

  const toggleSingleIssueSelection = useCallback((issueNumber: number) => {
    setSelectedSingleIssueNumbers(prev => {
      const next = new Set(prev);
      if (next.has(issueNumber)) {
        next.delete(issueNumber);
      } else {
        next.add(issueNumber);
      }
      return next;
    });
  }, []);

  const toggleBatchExpanded = useCallback((batchIndex: number) => {
    setExpandedBatchIds(prev => {
      const next = new Set(prev);
      if (next.has(batchIndex)) {
        next.delete(batchIndex);
      } else {
        next.add(batchIndex);
      }
      return next;
    });
  }, []);

  const selectAllBatches = useCallback(() => {
    if (!analysisResult) return;
    const allIds = new Set(analysisResult.proposedBatches.map((_, idx) => idx));
    setSelectedBatchIds(allIds);
    const allSingleIssues = new Set(analysisResult.singleIssues.map(issue => issue.issueNumber));
    setSelectedSingleIssueNumbers(allSingleIssues);
  }, [analysisResult]);

  const deselectAllBatches = useCallback(() => {
    setSelectedBatchIds(new Set());
    setSelectedSingleIssueNumbers(new Set());
  }, []);

  const handleApprove = useCallback(async () => {
    if (!analysisResult) return;

    const selectedBatches = analysisResult.proposedBatches.filter(
      (_, idx) => selectedBatchIds.has(idx)
    );

    const selectedSingleIssueBatches: ProposedBatch[] = analysisResult.singleIssues
      .filter(issue => selectedSingleIssueNumbers.has(issue.issueNumber))
      .map(issue => ({
        primaryIssue: issue.issueNumber,
        issues: [{
          issueNumber: issue.issueNumber,
          title: issue.title,
          labels: issue.labels,
          similarityToPrimary: 1.0
        }],
        issueCount: 1,
        commonThemes: [],
        validated: true,
        confidence: 1.0,
        reasoning: t('issues.taskGeneration.singleIssueReasoning', {
          defaultValue: 'Single issue - not grouped with others'
        }),
        theme: issue.title
      }));

    const allBatches = [...selectedBatches, ...selectedSingleIssueBatches];

    await onApproveBatches(allBatches);
    setStep('done');
  }, [analysisResult, onApproveBatches, selectedBatchIds, selectedSingleIssueNumbers, t]);

  const renderIntro = () => (
    <div className="flex flex-col items-center justify-center py-8 space-y-6">
      <div className="p-4 rounded-full bg-primary/10">
        <Layers className="h-12 w-12 text-primary" />
      </div>
      <div className="text-center space-y-2">
        <h3 className="text-lg font-semibold">
          {t('issues.batchReview.introTitle', {
            defaultValue: 'Analyze & Group Issues'
          })}
        </h3>
        <p className="text-sm text-muted-foreground max-w-md">
          {t('issues.batchReview.introDescription', {
            defaultValue: 'This will analyze up to 200 open issues, group similar ones together, and let you review the proposed batches before creating any tasks.'
          })}
        </p>
      </div>
      {analysisError && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-sm">{analysisError}</span>
        </div>
      )}
      <Button onClick={onStartAnalysis} size="lg">
        <Layers className="h-4 w-4 mr-2" />
        {t('issues.batchReview.startAnalysis', {
          defaultValue: 'Start Analysis'
        })}
      </Button>
    </div>
  );

  const renderAnalyzing = () => (
    <div className="flex flex-col items-center justify-center py-8 space-y-6">
      <Loader2 className="h-12 w-12 text-primary animate-spin" />
      <div className="text-center space-y-2">
        <h3 className="text-lg font-semibold">
          {t('issues.batchReview.analyzingTitle', {
            defaultValue: 'Analyzing Issues...'
          })}
        </h3>
        <p className="text-sm text-muted-foreground">
          {analysisProgress?.message || t('issues.batchReview.analyzingFallback', {
            defaultValue: 'Computing similarity and validating batches...'
          })}
        </p>
      </div>
      <div className="w-full max-w-md">
        <Progress value={analysisProgress?.progress ?? 0} />
        <p className="text-xs text-center text-muted-foreground mt-2">
          {t('issues.batchReview.progressComplete', {
            progress: analysisProgress?.progress ?? 0,
            defaultValue: '{{progress}}% complete'
          })}
        </p>
      </div>
    </div>
  );

  const renderReview = () => {
    if (!analysisResult) return null;

    const { proposedBatches, singleIssues, totalIssues } = analysisResult;
    const selectedCount = selectedBatchIds.size;
    const totalIssuesInSelected = proposedBatches
      .filter((_, idx) => selectedBatchIds.has(idx))
      .reduce((sum, batch) => sum + batch.issueCount, 0);

    return (
      <div className="flex flex-col h-[60vh]">
        <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg mb-4">
          <div className="flex items-center gap-4 text-sm">
            <span>
              <strong>{totalIssues}</strong>{' '}
              {t('issues.batchReview.stats.issuesAnalyzed', {
                defaultValue: 'issues analyzed'
              })}
            </span>
            <span className="text-muted-foreground">|</span>
            <span>
              <strong>{proposedBatches.length}</strong>{' '}
              {t('issues.batchReview.stats.batchesProposed', {
                defaultValue: 'batches proposed'
              })}
            </span>
            <span className="text-muted-foreground">|</span>
            <span>
              <strong>{singleIssues.length}</strong>{' '}
              {t('issues.batchReview.stats.singleIssues', {
                defaultValue: 'single issues'
              })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={selectAllBatches}>
              {t('issues.batchReview.selectAll', {
                defaultValue: 'Select All'
              })}
            </Button>
            <Button variant="ghost" size="sm" onClick={deselectAllBatches}>
              {t('issues.batchReview.deselectAll', {
                defaultValue: 'Deselect All'
              })}
            </Button>
          </div>
        </div>

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-3">
            {proposedBatches.map((batch, idx) => (
              <BatchCard
                key={idx}
                batch={batch}
                index={idx}
                isSelected={selectedBatchIds.has(idx)}
                isExpanded={expandedBatchIds.has(idx)}
                onToggleSelect={() => toggleBatchSelection(idx)}
                onToggleExpand={() => toggleBatchExpanded(idx)}
              />
            ))}
          </div>

          {singleIssues.length > 0 && (
            <div className="mt-6">
              <h4 className="text-sm font-medium text-muted-foreground mb-2">
                {t('issues.batchReview.singleIssuesTitle', {
                  defaultValue: 'Single Issues (not grouped)'
                })}
              </h4>
              <div className="grid grid-cols-2 gap-2">
                {singleIssues.slice(0, 10).map((issue) => (
                  <div
                    key={issue.issueNumber}
                    onClick={() => toggleSingleIssueSelection(issue.issueNumber)}
                    className={`p-2 rounded border text-sm truncate cursor-pointer transition-colors ${
                      selectedSingleIssueNumbers.has(issue.issueNumber)
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent'
                    }`}
                  >
                    <Checkbox
                      checked={selectedSingleIssueNumbers.has(issue.issueNumber)}
                      className="inline-block mr-2"
                      onClick={(e) => e.stopPropagation()}
                      onCheckedChange={() => toggleSingleIssueSelection(issue.issueNumber)}
                    />
                    <span className="text-muted-foreground">#{issue.issueNumber}</span>{' '}
                    {issue.title}
                  </div>
                ))}
                {singleIssues.length > 10 && (
                  <div className="p-2 text-sm text-muted-foreground">
                    {t('issues.batchReview.andMore', {
                      count: singleIssues.length - 10,
                      defaultValue: '...and {{count}} more'
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </ScrollArea>

        <div className="flex items-center justify-between pt-4 mt-4 border-t border-border">
          <div className="text-sm text-muted-foreground">
            {t(
              selectedCount === 1
                ? 'issues.batchReview.selectionSummary'
                : 'issues.batchReview.selectionSummary_plural',
              {
                count: selectedCount,
                issueCount: totalIssuesInSelected,
                defaultValue:
                  selectedCount === 1
                    ? '{{count}} batch selected ({{issueCount}} issues)'
                    : '{{count}} batches selected ({{issueCount}} issues)'
              }
            )}
            {selectedSingleIssueNumbers.size > 0 && (
              <> {t(
                selectedSingleIssueNumbers.size === 1
                  ? 'issues.batchReview.selectedSingleIssues'
                  : 'issues.batchReview.selectedSingleIssues_plural',
                {
                  count: selectedSingleIssueNumbers.size,
                  defaultValue:
                    selectedSingleIssueNumbers.size === 1
                      ? '+ {{count}} single issue'
                      : '+ {{count}} single issues'
                }
              )}</>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderApproving = () => (
    <div className="flex flex-col items-center justify-center py-8 space-y-6">
      <Loader2 className="h-12 w-12 text-primary animate-spin" />
      <div className="text-center space-y-2">
        <h3 className="text-lg font-semibold">
          {t('issues.batchReview.approvingTitle', {
            defaultValue: 'Creating Batches...'
          })}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t('issues.batchReview.approvingDescription', {
            defaultValue: 'Setting up the approved issue batches for processing.'
          })}
        </p>
      </div>
    </div>
  );

  const renderDone = () => (
    <div className="flex flex-col items-center justify-center py-8 space-y-6">
      <div className="p-4 rounded-full bg-green-500/10">
        <CheckCircle2 className="h-12 w-12 text-green-500" />
      </div>
      <div className="text-center space-y-2">
        <h3 className="text-lg font-semibold">
          {t('issues.batchReview.doneTitle', {
            defaultValue: 'Batches Created'
          })}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t('issues.batchReview.doneDescription', {
            defaultValue: 'Your selected issue batches are ready for processing.'
          })}
        </p>
      </div>
      <Button onClick={onClose}>
        {t('issues.batchReview.close', {
          defaultValue: 'Close'
        })}
      </Button>
    </div>
  );

  const renderDescription = () => {
    if (step === 'intro') {
      return t('issues.batchReview.descriptions.intro', {
        defaultValue: 'Analyze open issues and group similar ones for batch processing.'
      });
    }

    if (step === 'analyzing') {
      return t('issues.batchReview.descriptions.analyzing', {
        defaultValue: 'Analyzing issues for semantic similarity...'
      });
    }

    if (step === 'review') {
      return t('issues.batchReview.descriptions.review', {
        defaultValue: 'Review and approve the proposed issue batches.'
      });
    }

    if (step === 'approving') {
      return t('issues.batchReview.descriptions.approving', {
        defaultValue: 'Creating the approved batches...'
      });
    }

    return t('issues.batchReview.descriptions.done', {
      defaultValue: 'Batches have been created successfully.'
    });
  };

  const totalSelectedBatchCount = selectedBatchIds.size + selectedSingleIssueNumbers.size;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5" />
            {t('issues.batchReview.title', {
              defaultValue: 'Analyze & Group Issues'
            })}
          </DialogTitle>
          <DialogDescription>
            {renderDescription()}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {step === 'intro' && renderIntro()}
          {step === 'analyzing' && renderAnalyzing()}
          {step === 'review' && renderReview()}
          {step === 'approving' && renderApproving()}
          {step === 'done' && renderDone()}
        </div>

        {step === 'review' && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('issues.batchReview.cancel', {
                defaultValue: 'Cancel'
              })}
            </Button>
            <Button
              onClick={handleApprove}
              disabled={(selectedBatchIds.size === 0 && selectedSingleIssueNumbers.size === 0) || isApproving}
            >
              {isApproving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t('issues.batchReview.creating', {
                    defaultValue: 'Creating...'
                  })}
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-2" />
                  {t(
                    totalSelectedBatchCount === 1
                      ? 'issues.batchReview.approveCreate'
                      : 'issues.batchReview.approveCreate_plural',
                    {
                      count: totalSelectedBatchCount,
                      defaultValue:
                        totalSelectedBatchCount === 1
                          ? 'Approve & Create ({{count}} batch)'
                          : 'Approve & Create ({{count}} batches)'
                    }
                  )}
                </>
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface BatchCardProps {
  batch: ProposedBatch;
  index: number;
  isSelected: boolean;
  isExpanded: boolean;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
}

function BatchCard({
  batch,
  index,
  isSelected,
  isExpanded,
  onToggleSelect,
  onToggleExpand,
}: BatchCardProps) {
  const { t } = useTranslation('common');
  const confidenceColor = batch.confidence >= 0.8
    ? 'text-green-500'
    : batch.confidence >= 0.6
      ? 'text-yellow-500'
      : 'text-red-500';

  return (
    <div
      className={`rounded-lg border transition-colors ${
        isSelected
          ? 'border-primary bg-primary/5'
          : 'border-border bg-card'
      }`}
    >
      <div className="flex items-center gap-3 p-3">
        <Checkbox
          checked={isSelected}
          onCheckedChange={onToggleSelect}
        />

        <Collapsible className="flex-1" open={isExpanded} onOpenChange={onToggleExpand}>
          <div className="flex items-center justify-between">
            <CollapsibleTrigger className="flex items-center gap-2 hover:underline">
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <span className="font-medium text-sm">
                {batch.theme || t('issues.batchReview.batchTitle', {
                  number: index + 1,
                  defaultValue: 'Batch {{number}}'
                })}
              </span>
            </CollapsibleTrigger>

            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                <Users className="h-3 w-3 mr-1" />
                {t(
                  batch.issueCount === 1
                    ? 'issues.batchReview.issueCount'
                    : 'issues.batchReview.issueCount_plural',
                  {
                    count: batch.issueCount,
                    defaultValue:
                      batch.issueCount === 1 ? '{{count}} issue' : '{{count}} issues'
                  }
                )}
              </Badge>
              <Badge
                variant={batch.validated ? 'default' : 'secondary'}
                className="text-xs"
              >
                {batch.validated ? (
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                ) : (
                  <AlertTriangle className="h-3 w-3 mr-1" />
                )}
                <span className={confidenceColor}>
                  {Math.round(batch.confidence * 100)}%
                </span>
              </Badge>
            </div>
          </div>

          <CollapsibleContent className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground px-6">
              {batch.reasoning}
            </p>

            <div className="space-y-1 px-6">
              {batch.issues.map((issue) => (
                <div
                  key={issue.issueNumber}
                  className="flex items-center justify-between text-sm py-1"
                >
                  <div className="flex items-center gap-2 truncate">
                    <span className="text-muted-foreground">
                      #{issue.issueNumber}
                    </span>
                    <span className="truncate">{issue.title}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t('issues.batchReview.similarity', {
                      percent: Math.round(issue.similarityToPrimary * 100),
                      defaultValue: '{{percent}}% similar'
                    })}
                  </span>
                </div>
              ))}
            </div>

            {batch.commonThemes.length > 0 && (
              <div className="flex flex-wrap gap-1 px-6 pt-2">
                {batch.commonThemes.map((theme, i) => (
                  <Badge key={i} variant="secondary" className="text-xs">
                    {theme}
                  </Badge>
                ))}
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
