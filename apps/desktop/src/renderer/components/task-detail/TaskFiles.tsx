import { useState, useEffect, useCallback, useRef, useMemo, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  FileText,
  FileJson,
  Loader2,
  AlertCircle,
  FolderOpen,
  RefreshCw,
  ChevronRight,
  ExternalLink,
  BookOpen,
  Code2
} from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '../../lib/utils';
import { useSettingsStore } from '../../stores/settings-store';
import type { Task } from '../../../shared/types';
import type { FileNode } from '../../../shared/types/project';

interface TaskFilesProps {
  task: Task;
}

// File extensions to display
const ALLOWED_EXTENSIONS = ['.md', '.json', '.jsonl'];
const INTERNAL_TASK_FILES = new Set([
  'autocode-run-prompt.md',
  'autocode-run-result.json',
]);
const FILE_PRIORITY: Record<string, number> = {
  'HUMAN_INPUT.md': 0,
  'change_requests.jsonl': 1,
  'spec.md': 2,
  'tasks.md': 3,
  'implementation_plan.md': 4,
  'task_logs.jsonl': 5,
};

type FileViewMode = 'reader' | 'source';
type FileKind = 'markdown' | 'json' | 'text';
type FileContextMenuState = {
  x: number;
  y: number;
  file: FileNode;
};
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type ParsedJson = { value: JsonValue; error?: never } | { value?: never; error: string };
type TaskFileNode = FileNode;

// Get icon for file type
function getFileIcon(filename: string) {
  if (filename.endsWith('.json') || filename.endsWith('.jsonl')) {
    return <FileJson className="h-4 w-4 text-amber-500" />;
  }
  return <FileText className="h-4 w-4 text-blue-500" />;
}

function getFileKind(filename: string | null): FileKind {
  if (!filename) return 'text';
  if (filename.endsWith('.json')) return 'json';
  if (filename.endsWith('.md')) return 'markdown';
  return 'text';
}

function isVisibleTaskFile(file: FileNode): boolean {
  if (file.isDirectory) return false;
  if (INTERNAL_TASK_FILES.has(file.name.toLowerCase())) return false;
  return ALLOWED_EXTENSIONS.some(ext => file.name.endsWith(ext));
}

function getJsonSummary(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).length}}`;
  return '';
}

function JsonPrimitive({ value }: { value: JsonValue }) {
  if (value === null) {
    return <span className="font-mono text-xs italic text-muted-foreground">null</span>;
  }

  if (typeof value === 'string') {
    return (
      <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400 whitespace-pre-wrap break-words">
        &quot;{value}&quot;
      </span>
    );
  }

  if (typeof value === 'number') {
    return <span className="font-mono text-xs text-blue-600 dark:text-blue-400">{value}</span>;
  }

  if (typeof value === 'boolean') {
    return (
      <span className="font-mono text-xs text-purple-600 dark:text-purple-400">
        {String(value)}
      </span>
    );
  }

  return null;
}

function JsonNode({ name, value, depth = 0 }: { name?: string; value: JsonValue; depth?: number }) {
  const isObjectLike = value !== null && typeof value === 'object';

  if (!isObjectLike) {
    return (
      <div className="flex items-start gap-2 py-1">
        {name !== undefined && (
          <>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">:</span>
          </>
        )}
        <JsonPrimitive value={value} />
      </div>
    );
  }

  const entries: Array<[string, JsonValue]> = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const summary = getJsonSummary(value);
  const typeLabel = Array.isArray(value) ? 'array' : 'object';

  if (name === undefined) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
          <span className="font-mono">{typeLabel}</span>
          <span className="font-mono">{summary}</span>
        </div>
        {entries.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            {Array.isArray(value) ? '[]' : '{}'}
          </div>
        ) : (
          entries.map(([key, item]) => (
            <JsonNode key={key} name={key} value={item} depth={depth + 1} />
          ))
        )}
      </div>
    );
  }

  return (
    <details open={depth < 2} className="group py-1">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/60 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="font-mono text-xs text-muted-foreground">{name}</span>
        <span className="text-xs text-muted-foreground">:</span>
        <span className="font-mono text-xs text-foreground">{typeLabel}</span>
        <span className="font-mono text-xs text-muted-foreground">{summary}</span>
      </summary>
      <div className="ml-3 border-l border-border/70 pl-3">
        {entries.length === 0 ? (
          <div className="py-1 font-mono text-xs text-muted-foreground">
            {Array.isArray(value) ? '[]' : '{}'}
          </div>
        ) : (
          entries.map(([key, item]) => (
            <JsonNode key={key} name={key} value={item} depth={depth + 1} />
          ))
        )}
      </div>
    </details>
  );
}

function SourceContent({ content }: { content: string }) {
  return (
    <pre className="min-h-full p-4 text-xs font-mono leading-relaxed text-foreground whitespace-pre-wrap break-words">
      {content}
    </pre>
  );
}

export function TaskFiles({ task }: TaskFilesProps) {
  const { t } = useTranslation(['tasks']);
  const { settings } = useSettingsStore();

  // State for file listing
  const [files, setFiles] = useState<TaskFileNode[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  // State for file content
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<FileViewMode>('reader');
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);

  // Ref for keyboard navigation
  const rootRef = useRef<HTMLDivElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);

  // Load files from spec directory
  const loadFiles = useCallback(async () => {
    if (!task.specsPath) return;

    setIsLoadingFiles(true);
    setFilesError(null);

    try {
      const result = await window.electronAPI.listDirectory(task.specsPath);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to load directory');
      }

      const filteredFiles = result.data.filter(isVisibleTaskFile);

      // Sort high-signal task files first, then alphabetically.
      filteredFiles.sort((a, b) => {
        const priorityDelta = (FILE_PRIORITY[a.name] ?? 100) - (FILE_PRIORITY[b.name] ?? 100);
        if (priorityDelta !== 0) return priorityDelta;
        return a.name.localeCompare(b.name);
      });

      setFiles(filteredFiles);
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingFiles(false);
    }
  }, [task]);

  // Load file content
  const loadFileContent = useCallback(async (filePath: string) => {
    setSelectedFile(filePath);
    setIsLoadingContent(true);
    setContentError(null);
    setFileContent(null);

    try {
      const result = await window.electronAPI.readFile(filePath);
      if (!result.success || result.data === undefined) {
        throw new Error(result.error || 'Failed to read file');
      }
      setFileContent(result.data);
    } catch (err) {
      setContentError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingContent(false);
    }
  }, []);

  // Reset state when task.specsPath changes
  useEffect(() => {
    setFiles([]);
    setSelectedFile(null);
    setFileContent(null);
    setContentError(null);
    setFilesError(null);
  }, [task.id, task.specsPath]);

  // Load files on mount and when specsPath changes
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadFiles();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [loadFiles]);

  // Auto-select first file (spec.md) when files are loaded
  useEffect(() => {
    if (files.length > 0 && selectedFile === null) {
      const timer = window.setTimeout(() => {
        void loadFileContent(files[0].path);
      }, 80);
      return () => window.clearTimeout(timer);
    }
    // Only run when files change, not on selectedFile changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, loadFileContent, selectedFile]);

  // Open spec directory in IDE
  const handleOpenInIDE = useCallback(async () => {
    if (!settings.preferredIDE || !task.specsPath) return;

    try {
      await window.electronAPI.worktreeOpenInIDE(
        task.specsPath,
        settings.preferredIDE,
        settings.customIDEPath
      );
    } catch (err) {
      console.error('Failed to open in IDE:', err);
    }
  }, [settings.preferredIDE, settings.customIDEPath, task.specsPath]);

  const handleFileContextMenu = useCallback((event: MouseEvent, file: FileNode) => {
    event.preventDefault();
    event.stopPropagation();

    const containerRect = rootRef.current?.getBoundingClientRect();
    const menuWidth = 220;
    const menuHeight = 44;
    const rawX = containerRect ? event.clientX - containerRect.left : event.clientX;
    const rawY = containerRect ? event.clientY - containerRect.top : event.clientY;
    const maxX = (containerRect?.width ?? window.innerWidth) - menuWidth - 8;
    const maxY = (containerRect?.height ?? window.innerHeight) - menuHeight - 8;

    setContextMenu({
      x: Math.max(8, Math.min(rawX, maxX)),
      y: Math.max(8, Math.min(rawY, maxY)),
      file
    });
  }, [task.id, task.specsPath]);

  const handleShowItemInFolder = useCallback(async () => {
    if (!contextMenu) return;

    const filePath = contextMenu.file.path;
    setContextMenu(null);

    try {
      const result = await window.electronAPI.showItemInFolder(filePath);
      if (!result.success) {
        throw new Error(result.error || 'Failed to show item in folder');
      }
    } catch (err) {
      console.error('Failed to show item in folder:', err);
    }
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;

    const closeContextMenu = () => setContextMenu(null);
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeContextMenu();
      }
    };

    window.addEventListener('click', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('click', closeContextMenu);
      window.removeEventListener('resize', closeContextMenu);
      window.removeEventListener('scroll', closeContextMenu, true);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu]);

  // Keyboard navigation for file list
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (files.length === 0) return;

    const currentIndex = selectedFile
      ? files.findIndex(f => f.path === selectedFile)
      : -1;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (currentIndex < files.length - 1) {
          loadFileContent(files[currentIndex + 1].path);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (currentIndex > 0) {
          loadFileContent(files[currentIndex - 1].path);
        }
        break;
      case 'Home':
        e.preventDefault();
        loadFileContent(files[0].path);
        break;
      case 'End':
        e.preventDefault();
        loadFileContent(files[files.length - 1].path);
        break;
    }
  }, [files, selectedFile, loadFileContent]);

  // Get selected filename (cross-platform: handles both / and \ separators)
  const selectedFileName = selectedFile ? (selectedFile.split(/[/\\]/).pop() ?? null) : null;
  const selectedFileKind = getFileKind(selectedFileName);

  const parsedJson = useMemo<ParsedJson | null>(() => {
    if (selectedFileKind !== 'json' || fileContent === null) return null;

    try {
      return { value: JSON.parse(fileContent) as JsonValue };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Invalid JSON' };
    }
  }, [fileContent, selectedFileKind]);

  const markdownComponents = useMemo<Components>(() => ({
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer" className="text-primary underline-offset-2 hover:underline">
        {children}
      </a>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-3 rounded-r-md border-l-4 border-primary/50 bg-muted/60 px-4 py-2 text-foreground/90 [&_*]:text-foreground/90">
        {children}
      </blockquote>
    ),
    code: ({ children, className }) => (
      <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground', className)}>
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="my-4 overflow-x-auto rounded-md border border-border bg-muted/50 p-3 text-foreground">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          {children}
        </table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-border bg-muted/60 px-2 py-1 text-left font-medium">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border border-border px-2 py-1 align-top">
        {children}
      </td>
    )
  }), []);

  // Handle no specsPath
  if (!task.specsPath) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center py-12">
          <FolderOpen className="h-10 w-10 mx-auto mb-3 text-muted-foreground/30" />
          <p className="text-sm font-medium text-muted-foreground mb-1">
            {t('tasks:files.noSpecPath')}
          </p>
        </div>
      </div>
    );
  }

  // Render file content based on type
  const renderContent = () => {
    if (!selectedFile) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{t('tasks:files.selectFile')}</p>
          </div>
        </div>
      );
    }

    if (isLoadingContent) {
      return (
        <div className="h-full flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (contentError) {
      return (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <AlertCircle className="h-8 w-8 mx-auto mb-2 text-destructive" />
            <p className="text-sm text-destructive mb-2">{t('tasks:files.errorLoadingContent')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadFileContent(selectedFile)}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              {t('tasks:files.retry')}
            </Button>
          </div>
        </div>
      );
    }

    if (fileContent === null) return null;

    if (viewMode === 'source') {
      return <SourceContent content={fileContent} />;
    }

    // Render JSON with a structured reader, falling back to source for invalid JSON.
    if (selectedFileKind === 'json') {
      if (parsedJson && 'error' in parsedJson) {
        return (
          <div className="space-y-3 p-4">
            <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{t('tasks:files.invalidJson')}</span>
            </div>
            <SourceContent content={fileContent} />
          </div>
        );
      }

      if (parsedJson && 'value' in parsedJson) {
        return (
          <div className="p-4">
            <JsonNode value={parsedJson.value} />
          </div>
        );
      }
    }

    // Render markdown files in reading mode.
    if (selectedFileKind === 'markdown') {
      return (
        <div className="prose prose-sm dark:prose-invert max-w-none p-4 prose-p:text-foreground/90 prose-headings:text-foreground prose-strong:text-foreground prose-li:text-foreground/90 prose-pre:overflow-x-auto prose-a:break-all prose-blockquote:not-italic prose-blockquote:text-foreground/90">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {fileContent}
          </ReactMarkdown>
        </div>
      );
    }

    return (
      <SourceContent content={fileContent} />
    );
  };

  return (
    <div ref={rootRef} className="relative h-full flex">
      {/* File list sidebar */}
      <div className="w-52 border-r border-border flex flex-col">
        {/* Sidebar header */}
        <div className="px-3 py-2 border-b border-border flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t('tasks:files.title')}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={loadFiles}
            disabled={isLoadingFiles}
          >
            <RefreshCw className={cn("h-3 w-3", isLoadingFiles && "animate-spin")} />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div
            ref={fileListRef}
            className="p-2 space-y-1"
            role="listbox"
            aria-label={t('tasks:files.title')}
            tabIndex={files.length > 0 ? 0 : -1}
            onKeyDown={handleKeyDown}
          >
            {isLoadingFiles ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : filesError ? (
              <div className="text-center py-4">
                <AlertCircle className="h-5 w-5 mx-auto mb-2 text-destructive" />
                <p className="text-xs text-destructive mb-2">{t('tasks:files.errorLoading')}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadFiles}
                  className="text-xs"
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  {t('tasks:files.retry')}
                </Button>
              </div>
            ) : files.length === 0 ? (
              <div className="text-center py-8">
                <FolderOpen className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">{t('tasks:files.noFiles')}</p>
              </div>
            ) : (
              files.map((file) => (
                <button
                  type="button"
                  key={file.path}
                  role="option"
                  aria-selected={selectedFile === file.path}
                  onClick={() => loadFileContent(file.path)}
                  onContextMenu={(event) => handleFileContextMenu(event, file)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors',
                    'hover:bg-secondary/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                    selectedFile === file.path && 'bg-secondary'
                  )}
                >
                  {getFileIcon(file.name)}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {file.name}
                  </span>
                  {selectedFile === file.path && (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* File content area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Content header */}
        {selectedFileName && (
          <div className="px-4 py-2 border-b border-border flex items-center gap-2 shrink-0 bg-muted/30">
            {getFileIcon(selectedFileName)}
            <span className="text-sm font-medium flex-1 min-w-0 truncate">{selectedFileName}</span>
            <div className="flex items-center gap-1 rounded-md border border-border bg-background p-0.5">
              <Button
                variant={viewMode === 'reader' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 gap-1 px-2"
                onClick={() => setViewMode('reader')}
                aria-pressed={viewMode === 'reader'}
              >
                <BookOpen className="h-3.5 w-3.5" />
                {t('tasks:files.readerView')}
              </Button>
              <Button
                variant={viewMode === 'source' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 gap-1 px-2"
                onClick={() => setViewMode('source')}
                aria-pressed={viewMode === 'source'}
              >
                <Code2 className="h-3.5 w-3.5" />
                {t('tasks:files.sourceView')}
              </Button>
            </div>
            {settings.preferredIDE && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={handleOpenInIDE}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('tasks:files.openInIDE')}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
        <ScrollArea className="flex-1">
          {renderContent()}
        </ScrollArea>
      </div>
      {contextMenu && (
        <div
          className="absolute z-[1000] min-w-52 overflow-hidden rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
            onClick={handleShowItemInFolder}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t('tasks:files.showItemInFolder', { defaultValue: '打开所在目录并选中文件' })}
          </button>
        </div>
      )}
    </div>
  );
}
