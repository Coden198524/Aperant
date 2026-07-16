import { motion, AnimatePresence } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, UIEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, FileText, FolderTree, Image as ImageIcon, Loader2, RefreshCw, Save, X } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { FileTree } from './FileTree';
import {
  getMermaidChartSource,
  isMermaidCodeBlock,
  isMermaidPreChild,
  MermaidDiagram,
} from './markdown/MermaidDiagram';
import { useFileExplorerStore } from '../stores/file-explorer-store';
import { cn } from '../lib/utils';
import type { FileExplorerChangeEvent, FileNode } from '../../shared/types';

interface FileExplorerPanelProps {
  projectPath: string;
}

const PANEL_WIDTH_STORAGE_KEY = 'terminal-files-panel-width-v2';
const TREE_WIDTH_STORAGE_KEY = 'terminal-files-tree-width';
const DEFAULT_TREE_WIDTH = 280;
const MIN_PANEL_WIDTH = 520;
const MIN_TREE_WIDTH = 180;
const DEFAULT_PANEL_WIDTH_RATIO = 0.5;
const MAX_PANEL_WIDTH_RATIO = 0.72;
const MIN_TERMINAL_SPACE = 420;
const MIN_TERMINAL_WIDTH_RATIO = 0.28;
const MIN_EDITOR_WIDTH = 320;
const EDITOR_LINE_HEIGHT = 20;
const EDITOR_VERTICAL_PADDING = 8;

type ChangedLineKind = 'added' | 'modified';
type CodeTokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'type' | 'function' | 'macro' | 'property' | 'punctuation' | 'plain';

interface CodeToken {
  text: string;
  kind: CodeTokenKind;
}

interface ImagePreview {
  dataUrl: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}

interface ChangedLineMarker {
  startLine: number;
  endLine: number;
  kind: ChangedLineKind;
}

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);

const CODE_KEYWORDS = new Set([
  'abstract', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'final', 'finally', 'for',
  'from', 'function', 'if', 'implements', 'import', 'in', 'interface', 'let', 'new',
  'null', 'override', 'private', 'protected', 'public', 'return', 'static', 'struct', 'switch',
  'this', 'throw', 'true', 'try', 'type', 'using', 'var', 'void', 'while', 'yield'
]);

const TYPE_INTRODUCERS = new Set([
  'as', 'class', 'enum', 'extends', 'implements', 'interface', 'instanceof', 'new', 'struct', 'type'
]);

const PREPROCESSOR_DIRECTIVES = new Set([
  'define', 'elif', 'else', 'endif', 'error', 'if', 'ifdef', 'ifndef', 'import', 'include',
  'line', 'pragma', 'undef', 'using', 'warning'
]);

const TOKEN_PATTERN = /(\/\/.*|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b|[{}()[\].,;:#@+\-*/%=<>!&|?]+)/g;

const markdownComponents: Components = {
  h1: ({ className, ...props }) => <h1 className={cn('mb-4 border-b border-[#3C3C3C] pb-2 text-2xl font-semibold text-[#D4D4D4]', className)} {...props} />,
  h2: ({ className, ...props }) => <h2 className={cn('mb-3 mt-6 border-b border-[#3C3C3C] pb-1.5 text-xl font-semibold text-[#D4D4D4]', className)} {...props} />,
  h3: ({ className, ...props }) => <h3 className={cn('mb-2 mt-5 text-lg font-semibold text-[#D4D4D4]', className)} {...props} />,
  h4: ({ className, ...props }) => <h4 className={cn('mb-2 mt-4 text-base font-semibold text-[#D4D4D4]', className)} {...props} />,
  p: ({ className, ...props }) => <p className={cn('mb-3 leading-7 text-[#D4D4D4]', className)} {...props} />,
  a: ({ className, ...props }) => <a className={cn('text-[#4FC1FF] underline underline-offset-2 hover:text-[#9CDCFE]', className)} {...props} />,
  ul: ({ className, ...props }) => <ul className={cn('mb-3 list-disc space-y-1 pl-6 text-[#D4D4D4]', className)} {...props} />,
  ol: ({ className, ...props }) => <ol className={cn('mb-3 list-decimal space-y-1 pl-6 text-[#D4D4D4]', className)} {...props} />,
  li: ({ className, ...props }) => <li className={cn('leading-7', className)} {...props} />,
  blockquote: ({ className, ...props }) => (
    <blockquote className={cn('mb-3 border-l-4 border-[#3C3C3C] bg-[#252526] px-3 py-2 text-[#C8C8C8]', className)} {...props} />
  ),
  code: ({ className, children, ...props }) => {
    if (isMermaidCodeBlock(className)) {
      return <MermaidDiagram chart={getMermaidChartSource(children)} theme="dark" />;
    }

    return (
      <code className={cn('rounded bg-[#2D2D2D] px-1.5 py-0.5 font-mono text-[0.9em] text-[#CE9178]', className)} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ className, children, ...props }) => {
    if (isMermaidPreChild(children)) return <>{children}</>;
    return (
      <pre className={cn('mb-4 overflow-auto rounded border border-[#3C3C3C] bg-[#1E1E1E] p-3 text-xs leading-relaxed text-[#D4D4D4]', className)} {...props}>
        {children}
      </pre>
    );
  },
  table: ({ className, ...props }) => (
    <div className="mb-4 overflow-auto rounded border border-[#3C3C3C]">
      <table className={cn('w-full border-collapse text-sm text-[#D4D4D4]', className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }) => <th className={cn('border border-[#3C3C3C] bg-[#252526] px-3 py-2 text-left font-semibold', className)} {...props} />,
  td: ({ className, ...props }) => <td className={cn('border border-[#3C3C3C] px-3 py-2 align-top', className)} {...props} />,
  hr: ({ className, ...props }) => <hr className={cn('my-5 border-[#3C3C3C]', className)} {...props} />
};

function getTokenClassName(kind: CodeTokenKind): string {
  switch (kind) {
    case 'comment':
      return 'text-[#6A9955] italic';
    case 'string':
      return 'text-[#CE9178]';
    case 'number':
      return 'text-[#B5CEA8]';
    case 'keyword':
      return 'text-[#569CD6]';
    case 'type':
      return 'text-[#4EC9B0]';
    case 'function':
      return 'text-[#DCDCAA]';
    case 'macro':
      return 'text-[#C586C0]';
    case 'property':
      return 'text-[#9CDCFE]';
    case 'punctuation':
      return 'text-[#D4D4D4]';
    default:
      return 'text-[#D4D4D4]';
  }
}

function tokenizeCodeLine(line: string): CodeToken[] {
  if (!line) return [{ text: ' ', kind: 'plain' }];

  const trimmedLine = line.trimStart();
  const preprocessorMatch = trimmedLine.match(/^#\s*([A-Za-z_]\w*)/);
  if (trimmedLine.startsWith('#') && !PREPROCESSOR_DIRECTIVES.has(preprocessorMatch?.[1] ?? '')) {
    return [{ text: line, kind: 'comment' }];
  }

  const tokens: CodeToken[] = [];
  let cursor = 0;
  let previousWord = '';
  const isPreprocessorLine = Boolean(preprocessorMatch);

  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const text = match[0];
    const index = match.index ?? 0;
    const afterText = line.slice(index + text.length);
    if (index > cursor) {
      tokens.push({ text: line.slice(cursor, index), kind: 'plain' });
    }

    let kind: CodeTokenKind = 'plain';
    if (text.startsWith('//') || text.startsWith('/*')) {
      kind = 'comment';
    } else if (text.startsWith('"') || text.startsWith("'") || text.startsWith('`')) {
      kind = 'string';
    } else if (/^\d/.test(text)) {
      kind = 'number';
    } else if (
      text === '#' ||
      (isPreprocessorLine && PREPROCESSOR_DIRECTIVES.has(text)) ||
      (isPreprocessorLine && /^[A-Z_][A-Z0-9_]*$/.test(text)) ||
      /^[A-Z_][A-Z0-9_]{2,}$/.test(text)
    ) {
      kind = 'macro';
    } else if (CODE_KEYWORDS.has(text)) {
      kind = 'keyword';
    } else if (
      /^[A-Za-z_$][\w$]*$/.test(text) &&
      (
        TYPE_INTRODUCERS.has(previousWord) ||
        /^[A-Z][A-Za-z0-9_$]*$/.test(text) ||
        line.slice(Math.max(0, index - 2), index).trim().endsWith(':') ||
        line.slice(Math.max(0, index - 2), index).trim().endsWith('<')
      )
    ) {
      kind = 'type';
    } else if (
      /^[A-Za-z_$][\w$]*$/.test(text) &&
      (
        previousWord === 'function' ||
        afterText.trimStart().startsWith('(')
      )
    ) {
      kind = 'function';
    } else if (/^[{}()[\].,;:+\-*/%=<>!&|?]+$/.test(text)) {
      kind = 'punctuation';
    } else if (line[index - 1] === '.') {
      kind = 'property';
    }

    tokens.push({ text, kind });
    if (/^[A-Za-z_$][\w$]*$/.test(text)) {
      previousWord = text;
    }
    cursor = index + text.length;
  }

  if (cursor < line.length) {
    tokens.push({ text: line.slice(cursor), kind: 'plain' });
  }

  return tokens;
}

function getMaxPanelWidth(): number {
  if (typeof window === 'undefined') return MIN_PANEL_WIDTH;
  const reservedTerminalWidth = Math.max(
    MIN_TERMINAL_SPACE,
    Math.floor(window.innerWidth * MIN_TERMINAL_WIDTH_RATIO)
  );
  const ratioLimitedWidth = Math.floor(window.innerWidth * MAX_PANEL_WIDTH_RATIO);
  const terminalLimitedWidth = window.innerWidth - reservedTerminalWidth;
  return Math.max(MIN_PANEL_WIDTH, Math.min(ratioLimitedWidth, terminalLimitedWidth));
}

function clampPanelWidth(width: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(getMaxPanelWidth(), width));
}

function getDefaultPanelWidth(): number {
  if (typeof window === 'undefined') return MIN_PANEL_WIDTH;
  return clampPanelWidth(Math.floor(window.innerWidth * DEFAULT_PANEL_WIDTH_RATIO));
}

function loadPanelWidth(): number {
  if (typeof window === 'undefined') return MIN_PANEL_WIDTH;

  try {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY));
    if (Number.isFinite(saved)) {
      return clampPanelWidth(saved);
    }
  } catch {
    // Ignore localStorage failures and fall back to the default width.
  }

  return getDefaultPanelWidth();
}

function clampTreeWidth(width: number, panelWidth: number): number {
  const maxTreeWidth = Math.max(MIN_TREE_WIDTH, panelWidth - MIN_EDITOR_WIDTH);
  return Math.max(MIN_TREE_WIDTH, Math.min(maxTreeWidth, width));
}

function loadTreeWidth(panelWidth: number): number {
  if (typeof window === 'undefined') return clampTreeWidth(DEFAULT_TREE_WIDTH, panelWidth);

  try {
    const saved = Number(localStorage.getItem(TREE_WIDTH_STORAGE_KEY));
    if (Number.isFinite(saved)) {
      return clampTreeWidth(saved, panelWidth);
    }
  } catch {
    // Width persistence is non-critical.
  }

  return clampTreeWidth(DEFAULT_TREE_WIDTH, panelWidth);
}

function parseChangedLinesFromDiff(diff: string, lineCount: number): Map<number, ChangedLineKind> {
  const changedLines = new Map<number, ChangedLineKind>();
  if (!diff.trim()) return changedLines;

  if (diff.startsWith('__AUTOCODE_UNTRACKED__')) {
    for (let line = 1; line <= lineCount; line++) {
      changedLines.set(line, 'added');
    }
    return changedLines;
  }

  let currentNewLine: number | null = null;
  for (const line of diff.split('\n')) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = Number(hunkMatch[1]);
      continue;
    }

    if (currentNewLine === null || line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }

    if (line.startsWith('+')) {
      changedLines.set(currentNewLine, 'modified');
      currentNewLine++;
    } else if (line.startsWith('-')) {
      // Deleted lines do not exist in the current editor buffer.
    } else if (line.startsWith(' ') || line.length === 0) {
      currentNewLine++;
    }
  }

  return changedLines;
}

function buildChangedLineMarkers(changedLines: Map<number, ChangedLineKind>): ChangedLineMarker[] {
  const sortedLines = [...changedLines.entries()].sort(([lineA], [lineB]) => lineA - lineB);
  const markers: ChangedLineMarker[] = [];

  for (const [line, kind] of sortedLines) {
    const previousMarker = markers[markers.length - 1];
    if (previousMarker && previousMarker.kind === kind && previousMarker.endLine + 1 === line) {
      previousMarker.endLine = line;
      continue;
    }

    markers.push({
      startLine: line,
      endLine: line,
      kind
    });
  }

  return markers;
}

function normalizeTreePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return window.platform?.isWindows ? normalized.toLowerCase() : normalized;
}

function normalizeComparableTreePath(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return window.platform?.isWindows ? normalized.toLowerCase() : normalized;
}

function isSameTreePath(pathA: string, pathB: string): boolean {
  return normalizeComparableTreePath(pathA) === normalizeComparableTreePath(pathB);
}

function isSameOrDescendantTreePath(candidatePath: string, rootPath: string): boolean {
  const candidate = normalizeComparableTreePath(candidatePath);
  const root = normalizeComparableTreePath(rootPath);
  return candidate === root || candidate.startsWith(`${root}/`);
}

function findLoadedDirectoryKey(files: Map<string, FileNode[]>, dirPath: string): string | null {
  if (files.has(dirPath)) {
    return dirPath;
  }

  const normalizedDirPath = normalizeComparableTreePath(dirPath);
  for (const loadedPath of files.keys()) {
    if (normalizeComparableTreePath(loadedPath) === normalizedDirPath) {
      return loadedPath;
    }
  }

  return null;
}

function buildChangedPathSets(projectPath: string, relativePaths: string[]) {
  const changedPaths = new Set<string>();
  const changedDirectoryPaths = new Set<string>();
  const normalizedProjectPath = projectPath.replace(/[\\/]+$/, '');

  for (const relativePath of relativePaths) {
    if (!relativePath.trim()) continue;

    const absolutePath = `${normalizedProjectPath}/${relativePath}`.replace(/\\/g, '/');
    changedPaths.add(normalizeTreePath(absolutePath));

    const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
    for (let index = 1; index < segments.length; index++) {
      const directoryPath = `${normalizedProjectPath}/${segments.slice(0, index).join('/')}`;
      changedDirectoryPaths.add(normalizeTreePath(directoryPath));
    }
  }

  return { changedPaths, changedDirectoryPaths };
}

function isImageFile(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase();
  return Boolean(extension && IMAGE_EXTENSIONS.has(extension));
}

function isMarkdownFile(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase();
  return Boolean(extension && MARKDOWN_EXTENSIONS.has(extension));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

// Animation for the content inside (slides in slightly delayed)
const contentVariants = {
  hidden: {
    x: -20,
    opacity: 0
  },
  visible: {
    x: 0,
    opacity: 1
  }
};

export function FileExplorerPanel({ projectPath }: FileExplorerPanelProps) {
  const { t } = useTranslation('common');
  const { isOpen, close, clearCache, loadDirectory } = useFileExplorerStore();
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [treeWidth, setTreeWidth] = useState(() => loadTreeWidth(panelWidth));
  const [isResizing, setIsResizing] = useState(false);
  const [isTreeResizing, setIsTreeResizing] = useState(false);
  const [openFile, setOpenFile] = useState<FileNode | null>(null);
  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [isReading, setIsReading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState('');
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [markdownViewMode, setMarkdownViewMode] = useState<'source' | 'preview'>('source');
  const [changedFilePaths, setChangedFilePaths] = useState<Set<string>>(new Set());
  const [changedDirectoryPaths, setChangedDirectoryPaths] = useState<Set<string>>(new Set());
  const [editorScrollTop, setEditorScrollTop] = useState(0);
  const [editorScrollLeft, setEditorScrollLeft] = useState(0);
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const treeResizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  const isDirty = content !== savedContent;
  const isOpenMarkdownFile = Boolean(openFile && isMarkdownFile(openFile.name) && !imagePreview);
  const editorLines = useMemo(() => content.split('\n'), [content]);
  const lineCount = editorLines.length;
  const changedLines = useMemo(
    () => parseChangedLinesFromDiff(fileDiff, lineCount),
    [fileDiff, lineCount]
  );
  const changedLineMarkers = useMemo(
    () => buildChangedLineMarkers(changedLines),
    [changedLines]
  );

  const refreshChangedFiles = useCallback(async () => {
    const result = await window.electronAPI.getChangedFiles(projectPath);
    if (!result.success || !result.data) {
      setChangedFilePaths(new Set());
      setChangedDirectoryPaths(new Set());
      return;
    }

    const next = buildChangedPathSets(projectPath, result.data);
    setChangedFilePaths(next.changedPaths);
    setChangedDirectoryPaths(next.changedDirectoryPaths);
  }, [projectPath]);

  const handleRefresh = () => {
    clearCache();
    void loadDirectory(projectPath);
    void refreshChangedFiles();
  };

  const refreshLoadedProjectDirectories = useCallback(async () => {
    const state = useFileExplorerStore.getState();
    const loadedProjectDirectories = Array.from(state.files.keys())
      .filter((dirPath) => isSameOrDescendantTreePath(dirPath, projectPath));

    const directoriesToRefresh = loadedProjectDirectories.length > 0
      ? loadedProjectDirectories
      : [projectPath];

    await Promise.all(
      directoriesToRefresh.map((dirPath) => state.refreshDirectory(dirPath))
    );
  }, [projectPath]);

  const handleProjectFilesChanged = useCallback((event: FileExplorerChangeEvent) => {
    if (!isSameTreePath(event.projectPath, projectPath)) {
      return;
    }

    void (async () => {
      if (event.removedDirectoryPaths.length > 0) {
        useFileExplorerStore.getState().invalidateDirectories(event.removedDirectoryPaths);
      }

      const state = useFileExplorerStore.getState();
      const directoriesToRefresh = new Set<string>();
      for (const affectedPath of event.affectedDirectoryPaths) {
        if (!isSameOrDescendantTreePath(affectedPath, projectPath)) {
          continue;
        }

        const loadedDirectoryKey = findLoadedDirectoryKey(state.files, affectedPath);
        if (loadedDirectoryKey) {
          directoriesToRefresh.add(loadedDirectoryKey);
        } else if (isSameTreePath(affectedPath, projectPath)) {
          directoriesToRefresh.add(projectPath);
        }
      }

      await Promise.all(
        Array.from(directoriesToRefresh).map((dirPath) =>
          useFileExplorerStore.getState().refreshDirectory(dirPath)
        )
      );
      await refreshChangedFiles();
    })();
  }, [projectPath, refreshChangedFiles]);

  const confirmDiscard = useCallback(() => {
    return !isDirty || window.confirm('Discard unsaved changes?');
  }, [isDirty]);

  const handleOpenFile = useCallback(async (node: FileNode) => {
    if (node.isDirectory || !confirmDiscard()) return;

    setOpenFile(node);
    setContent('');
    setSavedContent('');
    setError(null);
    setSavedAt(null);
    setFileDiff('');
    setImagePreview(null);
    setMarkdownViewMode(isMarkdownFile(node.name) ? 'preview' : 'source');
    setEditorScrollTop(0);
    setEditorScrollLeft(0);
    setIsReading(true);

    try {
      if (isImageFile(node.name)) {
        const imageResult = await window.electronAPI.readImageFile(node.path);
        if (!imageResult.success || !imageResult.data) {
          setError(imageResult.error || 'Failed to read image file');
          return;
        }
        setImagePreview(imageResult.data);
        void refreshChangedFiles();
        return;
      }

      const result = await window.electronAPI.readFile(node.path);
      if (!result.success) {
        setError(result.error || 'Failed to read file');
        return;
      }
      const nextContent = result.data ?? '';
      setContent(nextContent);
      setSavedContent(nextContent);

      const diffResult = await window.electronAPI.getFileDiff(projectPath, node.path);
      if (diffResult.success) {
        setFileDiff(diffResult.data ?? '');
      }
      void refreshChangedFiles();
    } finally {
      setIsReading(false);
    }
  }, [confirmDiscard, projectPath, refreshChangedFiles]);

  const handleSave = useCallback(async () => {
    if (!openFile || !isDirty || isSaving) return;

    setError(null);
    setIsSaving(true);
    try {
      const result = await window.electronAPI.writeFile(openFile.path, content);
      if (!result.success) {
        setError(result.error || 'Failed to save file');
        return;
      }
      setSavedContent(content);
      setSavedAt(new Date().toLocaleTimeString());
      const diffResult = await window.electronAPI.getFileDiff(projectPath, openFile.path);
      if (diffResult.success) {
        setFileDiff(diffResult.data ?? '');
      }
      void refreshChangedFiles();
    } finally {
      setIsSaving(false);
    }
  }, [content, isDirty, isSaving, openFile, projectPath]);

  const handleCloseFile = useCallback(() => {
    if (!confirmDiscard()) return;
    setOpenFile(null);
    setContent('');
    setSavedContent('');
    setError(null);
    setSavedAt(null);
    setFileDiff('');
    setImagePreview(null);
    setMarkdownViewMode('source');
    setEditorScrollTop(0);
    setEditorScrollLeft(0);
  }, [confirmDiscard]);

  const handleClosePanel = useCallback(() => {
    if (!confirmDiscard()) return;
    close();
  }, [close, confirmDiscard]);

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void handleSave();
    }
  };

  const handleEditorScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    setEditorScrollTop(event.currentTarget.scrollTop);
    setEditorScrollLeft(event.currentTarget.scrollLeft);
  };

  const savePanelWidth = useCallback((width: number) => {
    try {
      localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(Math.round(width)));
    } catch {
      // Width persistence is non-critical.
    }
  }, []);

  const saveTreeWidth = useCallback((width: number) => {
    try {
      localStorage.setItem(TREE_WIDTH_STORAGE_KEY, String(Math.round(width)));
    } catch {
      // Width persistence is non-critical.
    }
  }, []);

  const handleResizeStart = useCallback((clientX: number) => {
    resizeStateRef.current = {
      startX: clientX,
      startWidth: panelWidth
    };
    setIsResizing(true);
  }, [panelWidth]);

  const handleMouseResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    handleResizeStart(event.clientX);
  }, [handleResizeStart]);

  const handleTouchResizeStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;

    event.preventDefault();
    event.stopPropagation();
    handleResizeStart(touch.clientX);
  }, [handleResizeStart]);

  const handleTreeResizeStart = useCallback((clientX: number) => {
    treeResizeStateRef.current = {
      startX: clientX,
      startWidth: treeWidth
    };
    setIsTreeResizing(true);
  }, [treeWidth]);

  const handleTreeMouseResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    handleTreeResizeStart(event.clientX);
  }, [handleTreeResizeStart]);

  const handleTreeTouchResizeStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) return;

    event.preventDefault();
    event.stopPropagation();
    handleTreeResizeStart(touch.clientX);
  }, [handleTreeResizeStart]);

  useEffect(() => {
    if (!isResizing) return;

    const updateWidth = (clientX: number) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;

      const nextWidth = clampPanelWidth(resizeState.startWidth + clientX - resizeState.startX);
      setPanelWidth(nextWidth);
    };

    const stopResize = () => {
      resizeStateRef.current = null;
      setIsResizing(false);
    };

    const handleMouseMove = (event: MouseEvent) => updateWidth(event.clientX);
    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      event.preventDefault();
      updateWidth(touch.clientX);
    };

    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopResize);
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', stopResize);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopResize);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', stopResize);
    };
  }, [isResizing]);

  useEffect(() => {
    if (!isTreeResizing) return;

    const updateWidth = (clientX: number) => {
      const resizeState = treeResizeStateRef.current;
      if (!resizeState) return;

      const nextWidth = clampTreeWidth(resizeState.startWidth + clientX - resizeState.startX, panelWidth);
      setTreeWidth(nextWidth);
    };

    const stopResize = () => {
      treeResizeStateRef.current = null;
      setIsTreeResizing(false);
    };

    const handleMouseMove = (event: MouseEvent) => updateWidth(event.clientX);
    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      event.preventDefault();
      updateWidth(touch.clientX);
    };

    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopResize);
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    window.addEventListener('touchend', stopResize);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopResize);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', stopResize);
    };
  }, [isTreeResizing, panelWidth]);

  useEffect(() => {
    if (!isResizing) {
      savePanelWidth(panelWidth);
    }
  }, [isResizing, panelWidth, savePanelWidth]);

  useEffect(() => {
    if (!isTreeResizing) {
      saveTreeWidth(treeWidth);
    }
  }, [isTreeResizing, treeWidth, saveTreeWidth]);

  useEffect(() => {
    setTreeWidth((current) => clampTreeWidth(current, panelWidth));
  }, [panelWidth]);

  useEffect(() => {
    const handleWindowResize = () => {
      setPanelWidth((current) => clampPanelWidth(current));
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setPanelWidth(getDefaultPanelWidth());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    void refreshLoadedProjectDirectories();
    void refreshChangedFiles();

    const unsubscribe = window.electronAPI.onProjectFilesChanged(handleProjectFilesChanged);
    void window.electronAPI.watchProjectFiles(projectPath);

    return () => {
      unsubscribe();
      void window.electronAPI.unwatchProjectFiles(projectPath);
    };
  }, [
    handleProjectFilesChanged,
    isOpen,
    projectPath,
    refreshChangedFiles,
    refreshLoadedProjectDirectories
  ]);

  return (
    <AnimatePresence mode="wait">
      {isOpen && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: panelWidth, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{
            width: { duration: isResizing ? 0 : 0.3, ease: [0.4, 0, 0.2, 1] },
            opacity: { duration: 0.2 }
          }}
          className="h-full bg-card border-r border-border flex flex-col shadow-xl overflow-hidden relative shrink-0"
          style={{ minWidth: 0 }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize Files panel"
            className={cn(
              'absolute inset-y-0 right-0 z-20 w-2 translate-x-1 cursor-ew-resize touch-none',
              'hover:bg-primary/20',
              isResizing && 'bg-primary/30'
            )}
            onMouseDown={handleMouseResizeStart}
            onTouchStart={handleTouchResizeStart}
          />
          <motion.div
            variants={contentVariants}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={{
              duration: 0.25,
              delay: 0.1,
              ease: [0.4, 0, 0.2, 1]
            }}
            className="flex flex-col h-full"
            style={{ width: panelWidth }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-card/80 shrink-0">
              <div className="flex items-center gap-2">
                <FolderTree className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium whitespace-nowrap">Project Files</span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={handleRefresh}
                  aria-label={t('buttons.refresh')}
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={handleClosePanel}
                  aria-label={t('buttons.close')}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>

            <div className="flex flex-1 min-h-0">
              <div
                className="shrink-0 border-r border-border flex flex-col min-h-0"
                style={{ width: treeWidth }}
              >
                <div className="px-3 py-2 bg-muted/30 border-b border-border shrink-0">
                  <p className="text-[10px] text-muted-foreground whitespace-nowrap">
                    Drag files into a terminal to insert the path
                  </p>
                </div>
                <div className="flex-1 min-h-0">
                  <FileTree
                    rootPath={projectPath}
                    selectedPath={openFile?.path}
                    changedPaths={changedFilePaths}
                    changedDirectoryPaths={changedDirectoryPaths}
                    onFileOpen={handleOpenFile}
                  />
                </div>
              </div>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize file tree"
                className={cn(
                  'relative z-10 w-2 shrink-0 -mx-1 cursor-ew-resize touch-none',
                  'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border',
                  'hover:bg-primary/10 hover:after:bg-primary/50',
                  isTreeResizing && 'bg-primary/15 after:bg-primary'
                )}
                onMouseDown={handleTreeMouseResizeStart}
                onTouchStart={handleTreeTouchResizeStart}
              />

              <div className="flex-1 min-w-0 flex flex-col bg-background">
                {openFile ? (
                  <>
                    <div className="h-10 border-b border-border flex items-center justify-between gap-2 px-3 bg-card/60 shrink-0">
                      <div className="min-w-0 flex items-center gap-2">
                        {imagePreview ? (
                          <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                        ) : (
                          <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                        )}
                        <span className="text-xs font-medium truncate">{openFile.name}</span>
                        {isDirty && <span className="h-2 w-2 rounded-full bg-warning shrink-0" aria-label="Unsaved changes" />}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {isOpenMarkdownFile && (
                          <div className="flex items-center rounded border border-border bg-muted/30 p-0.5">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className={cn(
                                'h-6 px-2 text-[10px]',
                                markdownViewMode === 'source' && 'bg-background text-foreground shadow-sm'
                              )}
                              onClick={() => setMarkdownViewMode('source')}
                            >
                              Source
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className={cn(
                                'h-6 px-2 text-[10px]',
                                markdownViewMode === 'preview' && 'bg-background text-foreground shadow-sm'
                              )}
                              onClick={() => setMarkdownViewMode('preview')}
                            >
                              Preview
                            </Button>
                          </div>
                        )}
                        <span className="text-[10px] text-muted-foreground">
                          {isSaving ? 'Saving...' : isDirty ? 'Unsaved' : savedAt ? `Saved ${savedAt}` : 'Saved'}
                        </span>
                        {!imagePreview && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={!isDirty || isSaving || isReading}
                            onClick={() => void handleSave()}
                            aria-label="Save file"
                          >
                            {isSaving ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            ) : (
                              <Save className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={handleCloseFile}
                          aria-label="Close file"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>

                    <div className="px-3 py-1.5 border-b border-border bg-muted/20 shrink-0">
                      <p className="text-[10px] text-muted-foreground truncate">{openFile.path}</p>
                    </div>

                    {error && (
                      <div className="mx-3 mt-3 flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive shrink-0">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        <span>{error}</span>
                      </div>
                    )}

                    <div className="flex-1 min-h-0 p-3">
                      {isReading ? (
                        <div className="h-full flex items-center justify-center">
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                      ) : imagePreview ? (
                        <div className="h-full overflow-auto rounded border border-[#3C3C3C] bg-[#1E1E1E]">
                          <div className="flex min-h-full items-center justify-center p-4">
                            <img
                              src={imagePreview.dataUrl}
                              alt={openFile.name}
                              className="max-h-full max-w-full object-contain"
                              draggable={false}
                              onLoad={(event) => {
                                const image = event.currentTarget;
                                setImagePreview((current) => current ? {
                                  ...current,
                                  width: image.naturalWidth,
                                  height: image.naturalHeight
                                } : current);
                              }}
                            />
                          </div>
                        </div>
                      ) : isOpenMarkdownFile && markdownViewMode === 'preview' ? (
                        <div className="h-full overflow-auto rounded border border-[#3C3C3C] bg-[#1E1E1E]">
                          <div className="mx-auto max-w-4xl px-6 py-5 text-sm">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                              {content || ' '}
                            </ReactMarkdown>
                          </div>
                        </div>
                      ) : (
                        <div className="relative h-full overflow-hidden rounded border border-[#3C3C3C] bg-[#1E1E1E]">
                          <div
                            className="pointer-events-none absolute left-0 right-0 top-0 z-0"
                            style={{ transform: `translateY(${-editorScrollTop}px)` }}
                            aria-hidden="true"
                          >
                            <div style={{ height: EDITOR_VERTICAL_PADDING }} />
                            {editorLines.map((_, index) => {
                              const lineNumber = index + 1;
                              const changedKind = changedLines.get(lineNumber);
                              return (
                                <div
                                  key={lineNumber}
                                  className={cn(
                                    'flex font-mono text-xs',
                                    changedKind === 'added' && 'bg-[#2EA043]/18',
                                    changedKind === 'modified' && 'bg-[#264F78]/45'
                                  )}
                                  style={{ height: EDITOR_LINE_HEIGHT, lineHeight: `${EDITOR_LINE_HEIGHT}px` }}
                                >
                                  <div
                                    className={cn(
                                      'w-14 shrink-0 select-none border-r border-[#3C3C3C] bg-[#252526] pr-2 text-right text-[#858585]',
                                      changedKind === 'added' && 'border-[#2EA043]/60 bg-[#2EA043]/16 text-[#89D185]',
                                      changedKind === 'modified' && 'border-[#3794FF]/50 bg-[#264F78]/45 text-[#9CDCFE]'
                                    )}
                                  >
                                    {lineNumber}
                                  </div>
                                  {changedKind && (
                                    <div
                                      className={cn(
                                        'w-1 shrink-0',
                                        changedKind === 'added' ? 'bg-emerald-500/70' : 'bg-sky-500/70'
                                      )}
                                    />
                                  )}
                                  <div
                                    className="min-w-max pl-2 pr-4 whitespace-pre"
                                    style={{ transform: `translateX(${-editorScrollLeft}px)` }}
                                  >
                                    {tokenizeCodeLine(editorLines[index]).map((token, tokenIndex) => (
                                      <span
                                        key={`${lineNumber}-${tokenIndex}`}
                                        className={getTokenClassName(token.kind)}
                                      >
                                        {token.text}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          {changedLineMarkers.length > 0 && (
                            <div
                              className="pointer-events-none absolute bottom-2 right-2 top-2 z-20 w-1.5 rounded-full bg-[#3C3C3C]/35"
                              aria-hidden="true"
                            >
                              {changedLineMarkers.map((marker) => {
                                const topPercent = ((marker.startLine - 1) / Math.max(lineCount, 1)) * 100;
                                const heightPercent = ((marker.endLine - marker.startLine + 1) / Math.max(lineCount, 1)) * 100;

                                return (
                                  <div
                                    key={`${marker.kind}-${marker.startLine}-${marker.endLine}`}
                                    className={cn(
                                      'absolute left-0 w-full rounded-full',
                                      marker.kind === 'added' ? 'bg-emerald-400' : 'bg-sky-400'
                                    )}
                                    style={{
                                      top: `${topPercent}%`,
                                      height: `${Math.max(2, heightPercent)}%`
                                    }}
                                  />
                                );
                              })}
                            </div>
                          )}
                          <Textarea
                            ref={editorRef}
                            value={content}
                            onChange={(event) => setContent(event.target.value)}
                            onKeyDown={handleEditorKeyDown}
                            onScroll={handleEditorScroll}
                            spellCheck={false}
                            wrap="off"
                            className={cn(
                              'relative z-10 h-full min-h-0 resize-none rounded-none border-0 bg-transparent pl-16',
                              'font-mono text-xs leading-5 whitespace-pre overflow-auto text-transparent caret-[#AEAFAD]',
                              'selection:bg-[#264F78] selection:text-[#D4D4D4]',
                              'focus-visible:ring-0 focus-visible:border-transparent'
                            )}
                            aria-label={`Edit ${openFile.name}`}
                          />
                        </div>
                      )}
                    </div>

                    <div className="h-7 border-t border-border px-3 flex items-center justify-between text-[10px] text-muted-foreground bg-card/60 shrink-0">
                      {imagePreview ? (
                        <>
                          <span>{imagePreview.mimeType}</span>
                          <span>
                            {imagePreview.width && imagePreview.height ? `${imagePreview.width} x ${imagePreview.height} · ` : ''}
                            {formatFileSize(imagePreview.size)}
                          </span>
                        </>
                      ) : (
                        <>
                          <span>{isOpenMarkdownFile ? `Markdown ${markdownViewMode}` : `${lineCount} lines`}</span>
                          <span>
                            {changedLines.size > 0 ? `${changedLines.size} AI changed lines` : 'Ctrl+S Save'}
                          </span>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                    <FileText className="h-8 w-8" />
                    <p className="text-xs">Select a file to view or edit</p>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
