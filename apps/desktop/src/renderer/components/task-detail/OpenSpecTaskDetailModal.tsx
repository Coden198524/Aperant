import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Task } from '../../../shared/types';
import { WorktreeCleanupDialog } from '../WorktreeCleanupDialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { TooltipProvider } from '../ui/tooltip';
import { OpenSpecWorkspace } from './OpenSpecWorkspace';

export function OpenSpecTaskDetailModal({
  open,
  task,
  onOpenChange,
}: {
  open: boolean;
  task: Task;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(['tasks', 'common', 'dialogs']);
  const inspectedArchiveKeyRef = useRef<string | null>(null);
  const [cleanupDialog, setCleanupDialog] = useState<{
    open: boolean;
    worktreePath?: string;
    processing: boolean;
    error?: string;
  }>({
    open: false,
    processing: false,
  });

  useEffect(() => {
    if (!open) {
      inspectedArchiveKeyRef.current = null;
      setCleanupDialog({ open: false, processing: false });
      return;
    }
    if (task.status !== 'done' || task.metadata?.useWorktree !== true) {
      return;
    }

    const archiveKey = `${task.projectId ?? ''}::${task.id}`;
    if (inspectedArchiveKeyRef.current === archiveKey) return;
    inspectedArchiveKeyRef.current = archiveKey;
    let cancelled = false;

    void window.electronAPI
      .getWorktreeStatus(task.id, task.projectId)
      .then((result) => {
        if (
          cancelled ||
          !result.success ||
          !result.data?.exists
        ) {
          return;
        }
        setCleanupDialog({
          open: true,
          worktreePath: result.data.worktreePath,
          processing: false,
        });
      })
      .catch((error) => {
        if (!cancelled) {
          console.error(
            '[OpenSpecTaskDetailModal] Failed to inspect archived worktree:',
            error,
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    open,
    task.id,
    task.metadata?.useWorktree,
    task.projectId,
    task.status,
  ]);

  const confirmWorktreeCleanup = async () => {
    setCleanupDialog((current) => ({
      ...current,
      processing: true,
      error: undefined,
    }));
    try {
      const result = await window.electronAPI.discardWorktree(
        task.id,
        true,
        task.projectId,
      );
      if (!result.success) {
        setCleanupDialog((current) => ({
          ...current,
          processing: false,
          error: result.error ?? t('dialogs:worktreeCleanup.errorDescription'),
        }));
        return;
      }
      setCleanupDialog({ open: false, processing: false });
      // Closing the details view tears down OpenSpec refresh effects before
      // the deleted worktree can be observed by another request.
      onOpenChange(false);
    } catch (error) {
      setCleanupDialog((current) => ({
        ...current,
        processing: false,
        error: error instanceof Error
          ? error.message
          : t('dialogs:worktreeCleanup.errorDescription'),
      }));
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content
            className="fixed inset-3 z-50 flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
            data-testid="openspec-task-detail"
          >
            <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
              <DialogPrimitive.Title className="min-w-0 truncate font-semibold">
                {task.title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                {t('tasks:openSpec.detail.description', { title: task.title })}
              </DialogPrimitive.Description>
              <Badge variant="outline" className="font-mono text-[10px]">
                {task.specId}
              </Badge>
              <Badge variant="info">
                {t('tasks:metadata.developmentMode.spec')}
              </Badge>
              <div className="ml-auto" />
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <X className="h-4 w-4" />
                  <span className="sr-only">{t('common:buttons.close')}</span>
                </Button>
              </DialogPrimitive.Close>
            </div>
            <div className="min-h-0 flex-1">
              <OpenSpecWorkspace task={task} />
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <WorktreeCleanupDialog
        open={cleanupDialog.open}
        taskTitle={task.title}
        worktreePath={cleanupDialog.worktreePath}
        variant="archived"
        isProcessing={cleanupDialog.processing}
        error={cleanupDialog.error}
        onOpenChange={(nextOpen) => {
          if (cleanupDialog.processing) return;
          setCleanupDialog((current) => ({
            ...current,
            open: nextOpen,
            ...(nextOpen ? {} : { error: undefined }),
          }));
        }}
        onConfirm={() => void confirmWorktreeCleanup()}
      />
    </TooltipProvider>
  );
}
