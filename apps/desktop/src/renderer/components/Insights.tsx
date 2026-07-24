import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  Send,
  Loader2,
  Plus,
  Sparkles,
  User,
  Bot,
  CheckCircle2,
  AlertCircle,
  Search,
  FileText,
  FolderSearch,
  PanelLeftClose,
  PanelLeft,
  Camera,
  X,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { ScrollArea } from './ui/scroll-area';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { ScreenshotCapture } from './ScreenshotCapture';
import { cn } from '../lib/utils';
import {
  useInsightsStore,
  loadInsightsSession,
  sendMessage,
  newSession,
  switchSession,
  deleteSession,
  deleteSessions,
  renameSession,
  archiveSession,
  archiveSessions,
  unarchiveSession,
  updateModelConfig,
  createTaskFromSuggestion,
  setupInsightsListeners,
  loadInsightsSessions
} from '../stores/insights-store';
import { useImageUpload } from './task-form/useImageUpload';
import { createThumbnail, formatFileSize, generateImageId } from './ImageUpload';
import { useInsightsDocumentReferences } from './insights/useInsightsDocumentReferences';
import { partitionInsightsDroppedFiles } from './insights/attachment-classification';
import { loadTasks } from '../stores/task-store';
import { ChatHistorySidebar } from './ChatHistorySidebar';
import { InsightsModelSelector } from './InsightsModelSelector';
import type {
  InsightsChatMessage,
  InsightsModelConfig,
  InsightsSuggestedTask,
  ImageAttachment,
} from '../../shared/types';
import {
  TASK_CATEGORY_COLORS,
  TASK_COMPLEXITY_COLORS,
  MAX_IMAGE_SIZE,
  MAX_IMAGES_PER_TASK
} from '../../shared/constants';
import { getTaskCategoryLabel, getTaskComplexityLabel } from '../lib/i18n-labels';
import { parseFileReferenceDrop } from '../../shared/utils/shell-escape';

const INSIGHTS_MARKDOWN_CLASS = [
  'prose prose-sm dark:prose-invert max-w-none',
  'prose-p:text-foreground/90 prose-headings:text-foreground prose-strong:text-foreground',
  'prose-li:text-foreground/90 prose-code:text-foreground prose-pre:bg-muted prose-pre:text-foreground',
  'prose-blockquote:text-foreground/80 prose-blockquote:border-border prose-th:text-foreground prose-td:text-foreground/90',
  'prose-a:text-primary'
].join(' ');

// createSafeLink - factory function that creates a SafeLink component with i18n support
const createSafeLink = (opensInNewWindowText: string) => {
  return function SafeLink({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    // Validate URL - only allow http, https, and relative links
    const isValidUrl = href && (
      href.startsWith('http://') ||
      href.startsWith('https://') ||
      href.startsWith('/') ||
      href.startsWith('#')
    );

    if (!isValidUrl) {
      // For invalid or potentially malicious URLs, render as plain text
      return <span className="text-muted-foreground">{children}</span>;
    }

    // External links get security attributes and accessibility indicator
    const isExternal = href?.startsWith('http://') || href?.startsWith('https://');

    return (
      <a
        href={href}
        {...props}
        {...(isExternal && {
          target: '_blank',
          rel: 'noopener noreferrer',
        })}
        className="text-primary hover:underline"
      >
        {children}
        {isExternal && <span className="sr-only"> {opensInNewWindowText}</span>}
      </a>
    );
  };
};

interface InsightsProps {
  projectId: string;
}

export function Insights({ projectId }: InsightsProps) {
  const { t } = useTranslation('common');
  const session = useInsightsStore((state) => state.session);
  const sessions = useInsightsStore((state) => state.sessions);
  const status = useInsightsStore((state) => state.status);
  const streamingContent = useInsightsStore((state) => state.streamingContent);
  const currentTool = useInsightsStore((state) => state.currentTool);
  const isLoadingSessions = useInsightsStore((state) => state.isLoadingSessions);

  // Create markdown components with translated accessibility text
  const markdownComponents = useMemo(() => ({
    a: createSafeLink(t('accessibility.opensInNewWindow')),
  }), [t]);

  const [inputValue, setInputValue] = useState('');
  const [creatingTask, setCreatingTask] = useState<Set<string>>(new Set());
  const [taskCreated, setTaskCreated] = useState<Set<string>>(new Set());
  const [showSidebar, setShowSidebar] = useState(true);
  const showArchived = useInsightsStore((state) => state.showArchived);
  const [isUserAtBottom, setIsUserAtBottom] = useState(true);
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);
  const [screenshotOpen, setScreenshotOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isAttachmentDragOver, setIsAttachmentDragOver] = useState(false);

  const pendingImages = useInsightsStore((state) => state.pendingImages);
  const setPendingImages = useInsightsStore((state) => state.setPendingImages);
  const pendingDocuments = useInsightsStore((state) => state.pendingDocuments);
  const setPendingDocuments = useInsightsStore((state) => state.setPendingDocuments);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement | null>(null);
  const chatAreaRef = useRef<HTMLDivElement | null>(null);
  const attachmentScope = `${projectId}\0${session?.id ?? 'no-session'}`;
  const attachmentScopeRef = useRef(attachmentScope);
  attachmentScopeRef.current = attachmentScope;
  const previousAttachmentScopeRef = useRef(attachmentScope);

  const isLoading = status.phase === 'thinking' || status.phase === 'streaming';

  // Image upload hook
  const {
    handlePaste,
    processFiles: processImageFiles,
    removeImage,
    canAddMore: canAddMoreImages,
  } = useImageUpload({
    images: pendingImages,
    onImagesChange: setPendingImages,
    scopeKey: attachmentScope,
    disabled: isLoading,
    onError: setAttachmentError,
    errorMessages: {
      maxImagesReached: t('insights.images.maxImagesReached'),
      invalidImageType: t('insights.images.invalidType'),
      processPasteFailed: t('insights.images.processFailed'),
      processDropFailed: t('insights.images.processFailed')
    }
  });

  const {
    processFiles: processDocumentFiles,
    addReferences: addDocumentReferences,
    removeReference: removeDocument,
    canAddMore: canAddMoreDocuments,
    isProcessing: isAuthorizingDocuments,
  } = useInsightsDocumentReferences({
    projectId,
    scopeKey: session?.id ?? 'no-session',
    references: pendingDocuments,
    onReferencesChange: setPendingDocuments,
    disabled: isLoading,
    onError: setAttachmentError,
    errorMessages: {
      maxReferencesReached: t('insights.documents.maxReferencesReached'),
      pathUnavailable: t('insights.documents.pathUnavailable'),
      directoryUnsupported: t('insights.documents.directoryUnsupported'),
    },
  });

  const isInputDisabled = isLoading || isAuthorizingDocuments;

  const handleAttachmentDragOver = useCallback((event: DragEvent) => {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return;
    const types = Array.from(dataTransfer.types);
    if (!types.includes('Files') && !types.includes('application/json')) return;
    event.preventDefault();
    event.stopPropagation();
    if (isInputDisabled) return;
    dataTransfer.dropEffect = 'copy';
    setIsAttachmentDragOver(true);
  }, [isInputDisabled]);

  const handleAttachmentDragLeave = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    setIsAttachmentDragOver(false);
  }, []);

  const handleAttachmentDrop = useCallback(async (event: DragEvent) => {
    setIsAttachmentDragOver(false);
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) return;
    const types = Array.from(dataTransfer.types);
    if (!types.includes('Files') && !types.includes('application/json')) return;
    event.preventDefault();
    event.stopPropagation();
    if (isInputDisabled) return;

    const internalReference = parseFileReferenceDrop(dataTransfer);
    if (internalReference) {
      addDocumentReferences([{
        path: internalReference.path,
        filename: internalReference.name,
        isDirectory: internalReference.isDirectory,
      }]);
      return;
    }

    const files = Array.from(dataTransfer.files);
    if (files.length === 0) return;

    const { documentFiles, imageFiles } = partitionInsightsDroppedFiles(files);
    await Promise.all([
      processDocumentFiles(documentFiles),
      processImageFiles(imageFiles),
    ]);
  }, [addDocumentReferences, isInputDisabled, processDocumentFiles, processImageFiles]);

  useEffect(() => {
    const chatArea = chatAreaRef.current;
    if (!chatArea) return;

    chatArea.addEventListener('dragover', handleAttachmentDragOver);
    chatArea.addEventListener('dragleave', handleAttachmentDragLeave);
    chatArea.addEventListener('drop', handleAttachmentDrop);
    return () => {
      chatArea.removeEventListener('dragover', handleAttachmentDragOver);
      chatArea.removeEventListener('dragleave', handleAttachmentDragLeave);
      chatArea.removeEventListener('drop', handleAttachmentDrop);
    };
  }, [handleAttachmentDragLeave, handleAttachmentDragOver, handleAttachmentDrop]);

  const handleDocumentInputChange = useCallback((
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = event.target.files;
    if (files?.length) {
      void processDocumentFiles(files);
    }
    event.target.value = '';
  }, [processDocumentFiles]);

  // Scroll threshold in pixels - user is considered "at bottom" if within this distance
  const SCROLL_BOTTOM_THRESHOLD = 100;

  // Check if user is near the bottom of scroll area
  const checkIfAtBottom = useCallback((viewport: HTMLElement) => {
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    return scrollHeight - scrollTop - clientHeight <= SCROLL_BOTTOM_THRESHOLD;
  }, []);

  // Handle scroll events to track user position
  const handleScroll = useCallback(() => {
    if (viewportEl) {
      setIsUserAtBottom(checkIfAtBottom(viewportEl));
    }
  }, [viewportEl, checkIfAtBottom]);

  // Set up scroll listener and check initial position when viewport becomes available
  useEffect(() => {
    if (viewportEl) {
      // Check initial scroll position
      setIsUserAtBottom(checkIfAtBottom(viewportEl));
      viewportEl.addEventListener('scroll', handleScroll, { passive: true });
      return () => viewportEl.removeEventListener('scroll', handleScroll);
    }
  }, [viewportEl, handleScroll, checkIfAtBottom]);

  // Load session and set up listeners on mount
  useEffect(() => {
    loadInsightsSession(projectId, showArchived);
    const cleanup = setupInsightsListeners();
    return cleanup;
  // biome-ignore lint/correctness/useExhaustiveDependencies: showArchived is handled by the dedicated effect below; including it here would cause duplicate loads
  }, [projectId]);

  // Reload sessions when showArchived changes (skip first run to avoid duplicate load with mount effect)
  const isFirstRun = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId changes are handled by the mount effect above; this effect only reacts to showArchived toggles
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    loadInsightsSessions(projectId, showArchived);
  }, [showArchived]);

  // Smart auto-scroll: only scroll if user is already at bottom
  // This allows users to scroll up to read previous messages without being
  // yanked back down during streaming responses
  useEffect(() => {
    if (isUserAtBottom && viewportEl) {
      viewportEl.scrollTop = viewportEl.scrollHeight;
    }
  }, [isUserAtBottom, viewportEl]);

  // Focus textarea on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Reset session-scoped UI state when the active session actually changes.
  useEffect(() => {
    const attachmentScopeChanged = previousAttachmentScopeRef.current !== attachmentScope;
    previousAttachmentScopeRef.current = attachmentScope;
    if (attachmentScopeChanged) {
      // Pending documents are cleared by useInsightsDocumentReferences via scopeKey.
      setPendingImages([]);
    }
    setTaskCreated(new Set());
    setCreatingTask(new Set());
    setAttachmentError(null);
    setIsAttachmentDragOver(false);
  }, [attachmentScope, setPendingImages]);

  const handleSend = async () => {
    const draftAtSend = inputValue;
    const message = inputValue.trim();
    const hasImages = pendingImages.length > 0;
    const hasDocuments = pendingDocuments.length > 0;
    if ((!message && !hasImages && !hasDocuments) || isInputDisabled) return;

    const accepted = await sendMessage(
      projectId,
      message,
      session?.modelConfig,
      hasImages ? pendingImages : undefined,
      hasDocuments ? pendingDocuments : undefined,
    );
    if (!accepted) return;

    setInputValue((currentDraft) => currentDraft === draftAtSend ? '' : currentDraft);
    setAttachmentError(null);
    setIsUserAtBottom(true); // Resume auto-scroll when user sends a message
  };

  const handleScreenshotCapture = useCallback(async (imageData: string) => {
    const scopeAtCapture = attachmentScopeRef.current;
    // Check image count limit before processing
    if (pendingImages.length >= MAX_IMAGES_PER_TASK) {
      setAttachmentError(t('insights.images.maxImagesReached'));
      return;
    }

    // imageData is base64 PNG from ScreenshotCapture
    const approximateSize = Math.ceil(imageData.length * 0.75); // approximate base64 size

    // Validate size - match the validation used for regular image uploads
    if (approximateSize > MAX_IMAGE_SIZE) {
      setAttachmentError(t('insights.images.screenshotTooLarge', { size: Math.round(approximateSize / 1024 / 1024), max: Math.round(MAX_IMAGE_SIZE / 1024 / 1024) }));
      return;
    }

    const dataUrl = `data:image/png;base64,${imageData}`;
    const thumbnail = await createThumbnail(dataUrl);
    if (attachmentScopeRef.current !== scopeAtCapture) return;
    const newImage: ImageAttachment = {
      id: generateImageId(),
      filename: `screenshot-${Date.now()}.png`,
      mimeType: 'image/png',
      size: approximateSize,
      data: imageData,
      thumbnail
    };
    setPendingImages([...useInsightsStore.getState().pendingImages, newImage]);
    setAttachmentError(null);
  }, [pendingImages, setPendingImages, t]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleNewSession = async () => {
    await newSession(projectId);
    setTaskCreated(new Set());
    textareaRef.current?.focus();
  };

  const handleSelectSession = async (sessionId: string) => {
    if (sessionId !== session?.id) {
      await switchSession(projectId, sessionId);
    }
  };

  const handleDeleteSession = async (sessionId: string): Promise<boolean> => {
    return await deleteSession(projectId, sessionId, showArchived);
  };

  const handleRenameSession = async (sessionId: string, newTitle: string): Promise<boolean> => {
    return await renameSession(projectId, sessionId, newTitle);
  };

  const handleArchiveSession = async (sessionId: string) => {
    try {
      await archiveSession(projectId, sessionId);
      await loadInsightsSessions(projectId, showArchived);
      // Reload current session in case backend switched to a different one
      await loadInsightsSession(projectId, showArchived);
    } catch (error) {
      console.error(`Failed to archive session ${sessionId}:`, error);
    }
  };

  const handleUnarchiveSession = async (sessionId: string) => {
    try {
      await unarchiveSession(projectId, sessionId);
      await loadInsightsSessions(projectId, showArchived);
      // Reload current session in case backend switched to a different one
      await loadInsightsSession(projectId, showArchived);
    } catch (error) {
      console.error(`Failed to unarchive session ${sessionId}:`, error);
    }
  };

  const handleDeleteSessions = async (sessionIds: string[]) => {
    try {
      const result = await deleteSessions(projectId, sessionIds);
      await loadInsightsSessions(projectId, showArchived);
      // Reload current session in case backend switched to a different one
      await loadInsightsSession(projectId, showArchived);

      // Log partial failures for debugging
      if (result.failedIds && result.failedIds.length > 0) {
        console.warn(`Failed to delete ${result.failedIds.length} session(s):`, result.failedIds);
      }
    } catch (error) {
      console.error(`Failed to delete sessions ${sessionIds.join(', ')}:`, error);
    }
  };

  const handleArchiveSessions = async (sessionIds: string[]) => {
    try {
      const result = await archiveSessions(projectId, sessionIds);
      await loadInsightsSessions(projectId, showArchived);
      // Reload current session in case backend switched to a different one
      await loadInsightsSession(projectId, showArchived);

      // Log partial failures for debugging
      if (result.failedIds && result.failedIds.length > 0) {
        console.warn(`Failed to archive ${result.failedIds.length} session(s):`, result.failedIds);
      }
    } catch (error) {
      console.error(`Failed to archive sessions ${sessionIds.join(', ')}:`, error);
    }
  };

  const handleToggleShowArchived = () => {
    useInsightsStore.getState().setShowArchived(!showArchived);
  };

  const handleCreateTask = async (
    messageId: string,
    taskIndex: number,
    taskData: InsightsSuggestedTask
  ) => {
    if (!session?.id) return;

    const taskKey = `${messageId}-${taskIndex}`;
    setCreatingTask(prev => new Set(prev).add(taskKey));
    try {
      const task = await createTaskFromSuggestion(
        projectId,
        {
          sessionId: session.id,
          messageId,
          taskIndex,
          suggestionId: taskData.id,
          title: taskData.title,
          description: taskData.description,
          metadata: taskData.metadata,
        }
      );

      if (task) {
        setTaskCreated(prev => new Set(prev).add(taskKey));
        // Reload tasks to show the new task in the kanban
        loadTasks(projectId);
      }
    } finally {
      setCreatingTask(prev => {
        const next = new Set(prev);
        next.delete(taskKey);
        return next;
      });
    }
  };

  const handleModelConfigChange = async (config: InsightsModelConfig) => {
    // If we have a session, persist the config
    if (session?.id) {
      await updateModelConfig(projectId, session.id, config);
    }
  };

  const messages = session?.messages || [];

  return (
    <div ref={chatAreaRef} className="relative flex h-full">
      {/* Chat History Sidebar */}
      {showSidebar && (
        <ChatHistorySidebar
          sessions={sessions}
          currentSessionId={session?.id || null}
          isLoading={isLoadingSessions}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onArchiveSession={handleArchiveSession}
          onUnarchiveSession={handleUnarchiveSession}
          onDeleteSessions={handleDeleteSessions}
          onArchiveSessions={handleArchiveSessions}
          showArchived={showArchived}
          onToggleShowArchived={handleToggleShowArchived}
        />
      )}

      {/* Main Chat Area */}
      <div className="relative flex flex-1 flex-col">
        {isAttachmentDragOver && (
          <div className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/90">
            <div className="flex flex-col items-center gap-2 text-primary">
              <FileText className="h-8 w-8" />
              <span className="text-sm font-medium">
                {t('insights.attachments.dragOver')}
              </span>
            </div>
          </div>
        )}
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setShowSidebar(!showSidebar)}
              title={showSidebar ? t('insights.header.hideSidebar') : t('insights.header.showSidebar')}
            >
              {showSidebar ? (
                <PanelLeftClose className="h-4 w-4" />
              ) : (
                <PanelLeft className="h-4 w-4" />
              )}
            </Button>
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Sparkles className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">{t('insights.header.title')}</h2>
              <p className="text-sm text-muted-foreground">
                {t('insights.header.description')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <InsightsModelSelector
              currentConfig={session?.modelConfig}
              onConfigChange={handleModelConfigChange}
              disabled={isLoading}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleNewSession}
            >
              <Plus className="mr-2 h-4 w-4" />
              {t('insights.header.newChat')}
            </Button>
          </div>
        </div>

      {/* Messages */}
      <ScrollArea
        className="flex-1 px-6 py-4"
        onViewportRef={setViewportEl}
      >
        {messages.length === 0 && !streamingContent ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <MessageSquare className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="mb-2 text-lg font-medium text-foreground">
              {t('insights.empty.title')}
            </h3>
            <p className="max-w-md text-sm text-muted-foreground">
              {t('insights.empty.description')}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {[
                t('insights.empty.suggestionArchitecture'),
                t('insights.empty.suggestionCodeQuality'),
                t('insights.empty.suggestionNextFeatures'),
                t('insights.empty.suggestionSecurity')
              ].map((suggestion) => (
                <Button
                  key={suggestion}
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    setInputValue(suggestion);
                    textareaRef.current?.focus();
                  }}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                markdownComponents={markdownComponents}
                onCreateTask={handleCreateTask}
                creatingTask={creatingTask}
                taskCreated={taskCreated}
              />
            ))}

            {/* Streaming message */}
            {(streamingContent || currentTool) && (
              <div className="flex gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <Bot className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1">
                  <div className="mb-1 text-sm font-medium text-foreground">
                    {t('insights.messages.assistant')}
                  </div>
                  {streamingContent && (
                    <div className={INSIGHTS_MARKDOWN_CLASS}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {streamingContent}
                      </ReactMarkdown>
                    </div>
                  )}
                  {/* Tool usage indicator */}
                  {currentTool && (
                    <LocalizedToolIndicator name={currentTool.name} input={currentTool.input} />
                  )}
                </div>
              </div>
            )}

            {/* Thinking indicator */}
            {status.phase === 'thinking' && !streamingContent && !currentTool && (
              <div className="flex gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <Bot className="h-4 w-4 text-primary" />
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('insights.status.thinking')}
                </div>
              </div>
            )}

            {/* Error message */}
            {status.phase === 'error' && status.error && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {status.error}
              </div>
            )}

          </div>
        )}
      </ScrollArea>

      {/* Input */}
      <div className="flex-shrink-0 border-t border-border p-4">
        <div className="relative flex gap-2">
          <div className="relative flex-1">
            <Textarea
              ref={textareaRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={t('insights.input.placeholder')}
              className={cn(
                'min-h-[80px] resize-none',
                isAttachmentDragOver && 'border-primary ring-2 ring-primary/20'
              )}
              disabled={isInputDisabled}
            />
          </div>
          <div className="flex flex-col gap-1 self-end">
            <input
              ref={documentInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleDocumentInputChange}
              tabIndex={-1}
            />
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => documentInputRef.current?.click()}
              disabled={isInputDisabled || !canAddMoreDocuments}
              title={t('insights.documents.attachButton')}
            >
              <FileText className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setScreenshotOpen(true)}
              disabled={isInputDisabled || !canAddMoreImages}
              title={t('insights.images.screenshotButton')}
            >
              <Camera className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleSend}
              disabled={
                (!inputValue.trim() && pendingImages.length === 0 && pendingDocuments.length === 0) ||
                isInputDisabled
              }
              className="h-9 w-9"
              size="icon"
            >
              {isInputDisabled ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {/* Image analysis warning */}
        {pendingImages.length > 0 && (
          <div className="mt-1 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-300">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span>{t('insights.images.analysisUnsupported')}</span>
          </div>
        )}

        {/* Attachment error */}
        {attachmentError && (
          <p className="mt-1 text-xs text-destructive">{attachmentError}</p>
        )}

        {/* Image preview strip */}
        {pendingImages.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {pendingImages.map((image) => (
              <div
                key={image.id}
                className="group relative h-16 w-16 rounded-md border border-border overflow-hidden"
              >
                <img
                  src={image.thumbnail || `data:${image.mimeType};base64,${image.data}`}
                  alt={image.filename}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeImage(image.id)}
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  title={t('insights.images.removeImage')}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            <span className="text-xs text-muted-foreground">
              {t('insights.images.imageCount', { count: pendingImages.length })}
            </span>
          </div>
        )}

        {/* Local file path references */}
        {pendingDocuments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {pendingDocuments.map((document) => (
              <div
                key={document.id}
                className="group flex max-w-[260px] items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2"
                title={document.path}
              >
                <FileText className="h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">
                    {document.filename}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {document.path}
                    {typeof document.size === 'number' ? ` | ${formatFileSize(document.size)}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeDocument(document.id)}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
                  title={t('insights.documents.removeDocument')}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <p className="mt-2 text-xs text-muted-foreground">
          {t('insights.attachments.dropHint')} | {t('insights.input.sendHint')}
        </p>
      </div>

      {/* Screenshot capture dialog */}
      <ScreenshotCapture
        open={screenshotOpen}
        onOpenChange={setScreenshotOpen}
        onCapture={handleScreenshotCapture}
      />
      </div>
    </div>
  );
}

interface MessageBubbleProps {
  message: InsightsChatMessage;
  markdownComponents: Components;
  onCreateTask: (messageId: string, taskIndex: number, taskData: InsightsSuggestedTask) => void;
  creatingTask: Set<string>;
  taskCreated: Set<string>;
}

function MessageBubble({
  message,
  markdownComponents,
  onCreateTask,
  creatingTask,
  taskCreated
}: MessageBubbleProps) {
  const { t } = useTranslation('common');
  const isUser = message.role === 'user';
  const documentReferences = message.documents?.filter((document) => (
    typeof document.path === 'string' && document.path.length > 0
  ));

  return (
    <div className="flex gap-3">
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-muted' : 'bg-primary/10'
        )}
      >
        {isUser ? (
          <User className="h-4 w-4 text-muted-foreground" />
        ) : (
          <Bot className="h-4 w-4 text-primary" />
        )}
      </div>
      <div className="flex-1 space-y-2">
        <div className="text-sm font-medium text-foreground">
          {isUser ? t('insights.messages.user') : t('insights.messages.assistant')}
        </div>
        {message.content && (
          <div className={INSIGHTS_MARKDOWN_CLASS}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {message.content}
            </ReactMarkdown>
          </div>
        )}

        {/* Image attachments for user messages */}
        {isUser && message.images && message.images.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-2">
              {message.images
                .filter(img => img.thumbnail || img.data)
                .map((image) => (
                  <img
                    key={image.id}
                    src={image.thumbnail || `data:${image.mimeType};base64,${image.data}`}
                    alt={image.filename}
                    className="max-w-[200px] max-h-[200px] rounded-md border border-border object-contain"
                  />
                ))}
            </div>
            <p className="text-xs text-muted-foreground italic">{t('insights.images.notAnalyzed')}</p>
          </div>
        )}

        {/* Local file path references for user messages */}
        {isUser && documentReferences && documentReferences.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-2">
              {documentReferences.map((document) => (
                <div
                  key={document.id}
                  className="flex max-w-[280px] items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2"
                  title={document.path}
                >
                  <FileText className="h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">
                      {document.filename}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {document.path}
                      {typeof document.size === 'number' ? ` | ${formatFileSize(document.size)}` : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs italic text-muted-foreground">
              {t('insights.documents.sharedWithModel')}
            </p>
          </div>
        )}

        {/* Tool usage history for assistant messages */}
        {!isUser && message.toolsUsed && message.toolsUsed.length > 0 && (
          <LocalizedToolUsageHistory tools={message.toolsUsed} />
        )}

        {/* Task suggestion cards */}
        {message.suggestedTasks && message.suggestedTasks.length > 0 && (
          <div className="mt-3 space-y-3">
            {message.suggestedTasks.map((task, index) => {
              const taskKey = `${message.id}-${index}`;
              const isCreating = creatingTask.has(taskKey);
              const isCreated = Boolean(task.taskId) || taskCreated.has(taskKey);

              return (
                <Card key={taskKey} className="border-primary/20 bg-primary/5">
                  <CardContent className="p-4">
                    <div className="mb-2 flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-primary" />
                      <span className="text-sm font-medium text-primary">
                        {t('insights.suggestedTask')}
                      </span>
                    </div>
                    <h4 className="mb-2 font-medium text-foreground">
                      {task.title}
                    </h4>
                    <p className="mb-3 text-sm text-muted-foreground">
                      {task.description}
                    </p>
                    {task.metadata && (
                      <div className="mb-3 flex flex-wrap gap-2">
                        {task.metadata.category && (
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-xs',
                              TASK_CATEGORY_COLORS[task.metadata.category]
                            )}
                          >
                            {getTaskCategoryLabel(t, task.metadata.category)}
                          </Badge>
                        )}
                        {task.metadata.complexity && (
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-xs',
                              TASK_COMPLEXITY_COLORS[task.metadata.complexity]
                            )}
                          >
                            {getTaskComplexityLabel(t, task.metadata.complexity)}
                          </Badge>
                        )}
                      </div>
                    )}
                    <Button
                      size="sm"
                      onClick={() => onCreateTask(message.id, index, task)}
                      disabled={isCreating || isCreated}
                    >
                      {isCreating ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {t('insights.creating')}
                        </>
                      ) : isCreated ? (
                        <>
                          <CheckCircle2 className="mr-2 h-4 w-4" />
                          {t('insights.taskCreated')}
                        </>
                      ) : (
                        <>
                          <Plus className="mr-2 h-4 w-4" />
                          {t('insights.createTask')}
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface ToolUsageHistoryProps {
  tools: Array<{
    name: string;
    input?: string;
    timestamp: Date;
  }>;
}

interface ToolIndicatorProps {
  name: string;
  input?: string;
}

function getLocalizedToolLabel(
  t: ReturnType<typeof useTranslation>['t'],
  toolName: string
): string {
  switch (toolName) {
    case 'Read':
      return t('insights.tools.readingFile');
    case 'Glob':
      return t('insights.tools.searchingFiles');
    case 'Grep':
      return t('insights.tools.searchingCode');
    default:
      return toolName;
  }
}

function LocalizedToolUsageHistory({ tools }: ToolUsageHistoryProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);

  if (tools.length === 0) return null;

  const toolCounts = tools.reduce((acc, tool) => {
    acc[tool.name] = (acc[tool.name] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const getToolIcon = (toolName: string) => {
    switch (toolName) {
      case 'Read':
        return FileText;
      case 'Glob':
        return FolderSearch;
      case 'Grep':
        return Search;
      default:
        return FileText;
    }
  };

  const getToolColor = (toolName: string) => {
    switch (toolName) {
      case 'Read':
        return 'text-blue-700 dark:text-blue-300';
      case 'Glob':
        return 'text-amber-700 dark:text-amber-300';
      case 'Grep':
        return 'text-green-700 dark:text-green-300';
      default:
        return 'text-muted-foreground';
    }
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="flex items-center gap-1">
          {Object.entries(toolCounts).map(([name, count]) => {
            const Icon = getToolIcon(name);
            return (
              <span key={name} className={cn('flex items-center gap-0.5', getToolColor(name))}>
                <Icon className="h-3 w-3" />
                <span>{count}</span>
              </span>
            );
          })}
        </span>
        <span>{t('insights.tools.used', { count: tools.length })}</span>
        <span className="text-[10px]">
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-1 rounded-md border border-border bg-muted/30 p-2">
          {tools.map((tool, index) => {
            const Icon = getToolIcon(tool.name);
            return (
              <div key={`${tool.name}-${index}`} className="flex items-center gap-2 text-xs">
                <Icon className={cn('h-3 w-3 shrink-0', getToolColor(tool.name))} />
                <span className="font-medium">{getLocalizedToolLabel(t, tool.name)}</span>
                {tool.input && (
                  <span className="text-muted-foreground truncate max-w-[250px]">
                    {tool.input}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LocalizedToolIndicator({ name, input }: ToolIndicatorProps) {
  const { t } = useTranslation('common');

  const getToolInfo = (toolName: string) => {
    switch (toolName) {
      case 'Read':
        return {
          icon: FileText,
          label: t('insights.tools.readingFile'),
          color: 'text-blue-700 dark:text-blue-300 bg-blue-500/10'
        };
      case 'Glob':
        return {
          icon: FolderSearch,
          label: t('insights.tools.searchingFiles'),
          color: 'text-amber-700 dark:text-amber-300 bg-amber-500/10'
        };
      case 'Grep':
        return {
          icon: Search,
          label: t('insights.tools.searchingCode'),
          color: 'text-green-700 dark:text-green-300 bg-green-500/10'
        };
      default:
        return {
          icon: Loader2,
          label: toolName,
          color: 'text-primary bg-primary/10'
        };
    }
  };

  const { icon: Icon, label, color } = getToolInfo(name);

  return (
    <div className={cn('mt-2 inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm', color)}>
      <Icon className="h-4 w-4 animate-pulse" />
      <span className="font-medium">{label}</span>
      {input && (
        <span className="text-muted-foreground truncate max-w-[300px]">
          {input}
        </span>
      )}
    </div>
  );
}

