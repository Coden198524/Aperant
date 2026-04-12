import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Eye, FileCode, Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog';
import { Badge } from '../../ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible';
import { cn } from '../../../lib/utils';
import type { WorktreeDiff } from '../../../../shared/types';

interface DiffViewDialogProps {
  open: boolean;
  worktreeDiff: WorktreeDiff | null;
  isLoadingDiff: boolean;
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

function getFileKey(path: string, previousPath?: string): string {
  return previousPath ? `${previousPath}->${path}` : path;
}

/**
 * Dialog displaying changed files and their unified diff content
 */
export function DiffViewDialog({
  open,
  worktreeDiff,
  isLoadingDiff,
  onOpenChange
}: DiffViewDialogProps) {
  const { t } = useTranslation(['taskReview', 'common']);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Eye className="h-5 w-5 text-purple-400" />
            {t('taskReview:diff.title', { defaultValue: 'Changed Files' })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {worktreeDiff?.summary || t('taskReview:diff.emptySummary', { defaultValue: 'No changes found' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex-1 overflow-auto min-h-0 -mx-6 px-6">
          {isLoadingDiff ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('taskReview:diff.loading', { defaultValue: 'Loading changed files...' })}
            </div>
          ) : worktreeDiff?.files && worktreeDiff.files.length > 0 ? (
            <div className="space-y-3">
              {worktreeDiff.files.map((file, idx) => {
                const fileKey = getFileKey(file.path, file.previousPath);
                const isOpen = expandedFiles[fileKey] ?? idx === 0;

                return (
                  <Collapsible
                    key={fileKey}
                    open={isOpen}
                    onOpenChange={(nextOpen) => {
                      setExpandedFiles((current) => ({
                        ...current,
                        [fileKey]: nextOpen,
                      }));
                    }}
                  >
                    <div className="rounded-lg border border-border/60 bg-secondary/20 overflow-hidden">
                      <CollapsibleTrigger asChild>
                        <button
                          type="button"
                          className="w-full flex items-start justify-between gap-3 p-3 text-left hover:bg-secondary/40 transition-colors"
                        >
                          <div className="flex items-start gap-2 min-w-0 flex-1">
                            {isOpen ? (
                              <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                            )}
                            <FileCode className={cn(
                              'h-4 w-4 mt-0.5 shrink-0',
                              file.status === 'added' && 'text-success',
                              file.status === 'deleted' && 'text-destructive',
                              file.status === 'modified' && 'text-info',
                              file.status === 'renamed' && 'text-warning'
                            )} />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-mono break-all">{file.path}</div>
                              {file.previousPath && (
                                <div className="mt-1 text-xs text-muted-foreground font-mono break-all">
                                  {t('taskReview:diff.renamedFrom', {
                                    defaultValue: 'Renamed from {{path}}',
                                    path: file.previousPath,
                                  })}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-2">
                            <Badge
                              variant="secondary"
                              className={cn(
                                'text-xs',
                                file.status === 'added' && 'bg-success/10 text-success',
                                file.status === 'deleted' && 'bg-destructive/10 text-destructive',
                                file.status === 'modified' && 'bg-info/10 text-info',
                                file.status === 'renamed' && 'bg-warning/10 text-warning'
                              )}
                            >
                              {t(`taskReview:diff.status.${file.status}`, {
                                defaultValue: file.status,
                              })}
                            </Badge>
                            <span className="text-xs text-success">+{file.additions}</span>
                            <span className="text-xs text-destructive">-{file.deletions}</span>
                          </div>
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="border-t border-border/60 bg-background/60">
                          {file.patch ? (
                            <div className="overflow-x-auto">
                              <div className="p-3 text-xs font-mono min-w-full">
                                {file.patch.split(/\r?\n/).map((line, lineIndex) => (
                                  <div
                                    key={`${fileKey}-${lineIndex}`}
                                    className={cn('whitespace-pre px-2 py-0.5 rounded-sm', getPatchLineClassName(line))}
                                  >
                                    {line || ' '}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="p-3 text-sm text-muted-foreground">
                              {t('taskReview:diff.noPatch', {
                                defaultValue: 'No inline diff available for this file.',
                              })}
                            </div>
                          )}
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              {t('taskReview:diff.empty', { defaultValue: 'No changed files found' })}
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
