import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  GitBranch,
  GitCommit as GitCommitIcon,
  FileText,
  FilePlus,
  FileX,
  FileDiff,
  Loader2,
  AlertCircle,
  RefreshCw,
  ChevronRight
} from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import type { Task } from '../../../shared/types';

interface TaskGitChangesProps {
  task: Task;
}

interface GitFile {
  path: string;
  status: 'M' | 'A' | 'D';
  additions: number;
  deletions: number;
}

interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  timestamp: number;
  parents?: string[];
  refs?: string[];
  isMerge?: boolean;
}

interface CommitGraphRow {
  commit: GitCommit;
  lanesBefore: string[];
  lanesAfter: string[];
  laneIndex: number;
  parentLaneIndexes: number[];
  isNewLane: boolean;
  laneCount: number;
}

const GRAPH_ROW_HEIGHT = 72;
const GRAPH_DOT_Y = 20;
const GRAPH_LANE_WIDTH = 12;
const GRAPH_X_PADDING = 10;
const GRAPH_COLORS = [
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#06b6d4',
  '#ec4899',
  '#84cc16'
];

function getGraphColor(hash: string | undefined, laneIndex: number): string {
  if (!hash) return GRAPH_COLORS[laneIndex % GRAPH_COLORS.length];

  let value = 0;
  for (let i = 0; i < hash.length; i++) {
    value = (value + hash.charCodeAt(i) * (i + 1)) % GRAPH_COLORS.length;
  }
  return GRAPH_COLORS[value];
}

function buildCommitGraphRows(commits: GitCommit[]): CommitGraphRow[] {
  const visibleHashes = new Set(commits.map((commit) => commit.hash));
  let lanes: string[] = [];

  return commits.map((commit) => {
    let lanesBefore = lanes.slice();
    let laneIndex = lanesBefore.indexOf(commit.hash);
    let isNewLane = false;

    if (laneIndex === -1) {
      laneIndex = lanesBefore.length;
      lanesBefore = [...lanesBefore, commit.hash];
      lanes = lanesBefore.slice();
      isNewLane = true;
    }

    const visibleParents = (commit.parents ?? []).filter((parent) => visibleHashes.has(parent));
    const lanesAfter = lanesBefore.filter((_, index) => index !== laneIndex);
    let insertAt = laneIndex;

    for (const parent of visibleParents) {
      const existingLane = lanesAfter.indexOf(parent);
      if (existingLane !== -1) {
        continue;
      }

      const safeInsertAt = Math.min(insertAt, lanesAfter.length);
      lanesAfter.splice(safeInsertAt, 0, parent);
      insertAt = safeInsertAt + 1;
    }

    lanes = lanesAfter.filter((hash, index, list) => hash && list.indexOf(hash) === index);

    const parentLaneIndexes = visibleParents
      .map((parent) => lanes.indexOf(parent))
      .filter((index) => index >= 0);

    return {
      commit,
      lanesBefore,
      lanesAfter: lanes.slice(),
      laneIndex,
      parentLaneIndexes,
      isNewLane,
      laneCount: Math.max(lanesBefore.length, lanes.length, laneIndex + 1, 1)
    };
  });
}

function formatGitRef(ref: string): string {
  return ref.replace(/^HEAD -> /, '').replace(/^tag: /, '');
}

function CommitGraph({ row, selected }: { row: CommitGraphRow; selected: boolean }) {
  const width = Math.max(36, GRAPH_X_PADDING * 2 + row.laneCount * GRAPH_LANE_WIDTH);
  const laneX = (index: number) => GRAPH_X_PADDING + index * GRAPH_LANE_WIDTH;
  const commitColor = getGraphColor(row.commit.hash, row.laneIndex);
  const visibleParents = row.parentLaneIndexes.map((laneIndex) => ({
    laneIndex,
    hash: row.lanesAfter[laneIndex]
  }));
  const unchangedLanes = row.lanesBefore
    .map((hash, laneIndex) => ({ hash, laneIndex }))
    .filter(({ hash, laneIndex }) => laneIndex !== row.laneIndex && row.lanesAfter.includes(hash));

  return (
    <svg
      aria-hidden="true"
      width={width}
      height={GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`}
      className="shrink-0 overflow-visible"
    >
      {unchangedLanes.map(({ hash, laneIndex }) => (
        <line
          key={`lane-${hash}-${laneIndex}`}
          x1={laneX(laneIndex)}
          y1={0}
          x2={laneX(laneIndex)}
          y2={GRAPH_ROW_HEIGHT}
          stroke={getGraphColor(hash, laneIndex)}
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.7"
        />
      ))}

      {!row.isNewLane && (
        <line
          x1={laneX(row.laneIndex)}
          y1={0}
          x2={laneX(row.laneIndex)}
          y2={GRAPH_DOT_Y}
          stroke={commitColor}
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.8"
        />
      )}

      {visibleParents.map(({ laneIndex, hash }) => {
        const parentColor = getGraphColor(hash, laneIndex);
        if (laneIndex === row.laneIndex) {
          return (
            <line
              key={`parent-${hash}-${laneIndex}`}
              x1={laneX(row.laneIndex)}
              y1={GRAPH_DOT_Y}
              x2={laneX(laneIndex)}
              y2={GRAPH_ROW_HEIGHT}
              stroke={parentColor}
              strokeWidth="2"
              strokeLinecap="round"
              opacity="0.85"
            />
          );
        }

        return (
          <path
            key={`parent-${hash}-${laneIndex}`}
            d={`M ${laneX(row.laneIndex)} ${GRAPH_DOT_Y} C ${laneX(row.laneIndex)} ${GRAPH_DOT_Y + 20}, ${laneX(laneIndex)} ${GRAPH_ROW_HEIGHT - 22}, ${laneX(laneIndex)} ${GRAPH_ROW_HEIGHT}`}
            fill="none"
            stroke={parentColor}
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.85"
          />
        );
      })}

      {row.commit.isMerge && (
        <circle
          cx={laneX(row.laneIndex)}
          cy={GRAPH_DOT_Y}
          r="7"
          fill="none"
          stroke={commitColor}
          strokeWidth="1.5"
          opacity="0.7"
        />
      )}

      <circle
        cx={laneX(row.laneIndex)}
        cy={GRAPH_DOT_Y}
        r={selected ? 5.5 : 4.5}
        fill={commitColor}
        stroke="hsl(var(--card))"
        strokeWidth={selected ? 3 : 2.5}
      />
    </svg>
  );
}

// Get icon and color for file status
function getFileStatusIcon(status: string) {
  switch (status) {
    case 'A':
      return <FilePlus className="h-4 w-4 text-green-500" />;
    case 'D':
      return <FileX className="h-4 w-4 text-red-500" />;
    default:
      return <FileDiff className="h-4 w-4 text-amber-500" />;
  }
}

export function TaskGitChanges({ task }: TaskGitChangesProps) {
  console.log('[TaskGitChanges] Component mounted/rendered with task:', task.id, task.projectId);
  const { t } = useTranslation(['tasks']);

  // State for files
  const [files, setFiles] = useState<GitFile[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  // State for commits
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [isLoadingCommits, setIsLoadingCommits] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);

  // State for diff
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const commitGraphRows = useMemo(() => buildCommitGraphRows(commits), [commits]);
  const selectedGitFile = useMemo(
    () => files.find((file) => file.path === selectedFile),
    [files, selectedFile]
  );

  // Filter out files from specific directories
  const shouldFilterFile = useCallback((filePath: string): boolean => {
    const excludedPrefixes = ['.autoclaude/', '.codex/', '.claude/', '.autocode/'];
    const excludedDotDirs = filePath.split('/').some(part => part.startsWith('.') && part.endsWith('d'));
    return excludedPrefixes.some(prefix => filePath.startsWith(prefix)) || excludedDotDirs;
  }, []);

  // Load changed files
  const loadFiles = useCallback(async () => {
    console.log('[TaskGitChanges] Loading files for task:', task.id, 'project:', task.projectId);
    setIsLoadingFiles(true);
    setFilesError(null);

    try {
      const result = await window.electronAPI.getWorktreeChangedFiles(task.id, task.projectId);
      console.log('[TaskGitChanges] Files result:', result);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to load changed files');
      }
      console.log('[TaskGitChanges] Files loaded:', result.data.length);
      // Filter out excluded directories
      const filteredFiles = result.data.filter((file: GitFile) => !shouldFilterFile(file.path));
      console.log('[TaskGitChanges] Files after filtering:', filteredFiles.length);
      setFiles(filteredFiles);
    } catch (err) {
      console.error('[TaskGitChanges] Error loading files:', err);
      setFilesError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingFiles(false);
    }
  }, [task.id, task.projectId, shouldFilterFile]);

  // Load commit history
  const loadCommits = useCallback(async () => {
    console.log('[TaskGitChanges] Loading commits for task:', task.id, 'project:', task.projectId);
    setIsLoadingCommits(true);
    setCommitsError(null);

    try {
      const result = await window.electronAPI.getWorktreeCommits(task.id, task.projectId);
      console.log('[TaskGitChanges] Commits result:', result);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to load commits');
      }
      console.log('[TaskGitChanges] Commits loaded:', result.data.length);
      setCommits(result.data);
      // Auto-select first commit if available
      if (result.data.length > 0 && !selectedCommit) {
        setSelectedCommit(result.data[0].hash);
      }
    } catch (err) {
      console.error('[TaskGitChanges] Error loading commits:', err);
      setCommitsError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingCommits(false);
    }
  }, [task.id, task.projectId, selectedCommit]);

  // Load diff for selected file
  const loadDiff = useCallback(async (filePath: string) => {
    setSelectedFile(filePath);
    setIsLoadingDiff(true);
    setDiffError(null);
    setDiff(null);

    try {
      const result = await window.electronAPI.getWorktreeFileDiff(task.id, filePath, task.projectId);
      if (!result.success || result.data === undefined) {
        throw new Error(result.error || 'Failed to load diff');
      }
      setDiff(result.data);
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingDiff(false);
    }
  }, [task.id, task.projectId]);

  // Load data on mount
  useEffect(() => {
    console.log('[TaskGitChanges] useEffect triggered - loading files and commits');
    loadFiles();
    loadCommits();
  }, [loadFiles, loadCommits]);

  // Auto-select first file when files are loaded
  useEffect(() => {
    if (files.length > 0 && selectedFile === null) {
      loadDiff(files[0].path);
    }
  }, [files, selectedFile, loadDiff]);

  // Refresh all data
  const handleRefresh = () => {
    loadFiles();
    loadCommits();
    if (selectedFile) {
      loadDiff(selectedFile);
    }
  };

  // Render diff content
  const renderDiff = () => {
    if (!selectedFile) {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <FileDiff className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">{t('tasks:gitChanges.selectFile')}</p>
          </div>
        </div>
      );
    }

    if (isLoadingDiff) {
      return (
        <div className="h-full flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (diffError) {
      return (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <AlertCircle className="h-8 w-8 mx-auto mb-2 text-destructive" />
            <p className="text-sm text-destructive mb-2">{t('tasks:gitChanges.errorLoading')}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => selectedFile && loadDiff(selectedFile)}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              {t('tasks:files.retry')}
            </Button>
          </div>
        </div>
      );
    }

    if (diff === null || diff === '') {
      return (
        <div className="h-full flex items-center justify-center text-muted-foreground">
          <p className="text-sm">{t('tasks:gitChanges.noChanges')}</p>
        </div>
      );
    }

    // Parse and render diff with syntax highlighting
    const lines = diff.split('\n');
    let oldLineNum = 0;
    let newLineNum = 0;

    return (
      <div className="p-4">
        <div className="text-xs font-mono border border-border rounded-md overflow-hidden">
          {lines.map((line, idx) => {
            let className = 'text-foreground';
            let showLineNumbers = true;
            let oldNum = '';
            let newNum = '';

            if (line.startsWith('@@')) {
              // Parse hunk header to get line numbers
              const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
              if (match) {
                oldLineNum = parseInt(match[1], 10);
                newLineNum = parseInt(match[2], 10);
              }
              className = 'text-blue-600 dark:text-blue-400 font-semibold bg-blue-500/10';
              showLineNumbers = false;
            } else if (line.startsWith('+') && !line.startsWith('+++')) {
              className = 'text-green-600 dark:text-green-400 bg-green-500/10';
              newNum = String(newLineNum);
              newLineNum++;
            } else if (line.startsWith('-') && !line.startsWith('---')) {
              className = 'text-red-600 dark:text-red-400 bg-red-500/10';
              oldNum = String(oldLineNum);
              oldLineNum++;
            } else if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('---') || line.startsWith('+++')) {
              className = 'text-muted-foreground bg-muted/30';
              showLineNumbers = false;
            } else if (line.trim() !== '') {
              // Context line
              oldNum = String(oldLineNum);
              newNum = String(newLineNum);
              oldLineNum++;
              newLineNum++;
            } else {
              showLineNumbers = false;
            }

            return (
              <div key={idx} className={cn('flex', className)}>
                {showLineNumbers && (
                  <>
                    <div className="w-12 px-2 py-0.5 text-right text-muted-foreground/50 select-none border-r border-border/50 shrink-0">
                      {oldNum}
                    </div>
                    <div className="w-12 px-2 py-0.5 text-right text-muted-foreground/50 select-none border-r border-border/50 shrink-0">
                      {newNum}
                    </div>
                  </>
                )}
                <div className={cn('flex-1 px-2 py-0.5', !showLineNumbers && 'pl-4')}>
                  {line || ' '}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex">
      {/* Left sidebar - Files and Commits */}
      <div className="w-80 border-r border-border flex flex-col">
        {/* Files section - 30% height */}
        <div className="h-[30%] border-b border-border flex flex-col">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between bg-muted/30">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('tasks:gitChanges.files')}
              </span>
              {files.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {files.length}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleRefresh}
              disabled={isLoadingFiles}
            >
              <RefreshCw className={cn("h-3 w-3", isLoadingFiles && "animate-spin")} />
            </Button>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {isLoadingFiles ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : filesError ? (
                <div className="text-center py-4 px-2">
                  <AlertCircle className="h-5 w-5 mx-auto mb-2 text-destructive" />
                  <p className="text-xs text-destructive break-words">{filesError}</p>
                </div>
              ) : files.length === 0 ? (
                <div className="text-center py-8">
                  <FileText className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground">{t('tasks:gitChanges.noChanges')}</p>
                </div>
              ) : (
                files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => loadDiff(file.path)}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors',
                      'hover:bg-secondary/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                      selectedFile === file.path && 'bg-secondary'
                    )}
                  >
                    {getFileStatusIcon(file.status)}
                    <Badge
                      variant={file.status === 'A' ? 'default' : file.status === 'D' ? 'destructive' : 'secondary'}
                      className="text-[10px] px-1 py-0 h-4 min-w-[16px] justify-center"
                    >
                      {file.status}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">
                        {file.path.split('/').pop()}
                      </div>
                      <div className="text-[10px] text-muted-foreground truncate">
                        {file.path}
                      </div>
                    </div>
                    {selectedFile === file.path && (
                      <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    )}
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Commits section - 70% height */}
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between bg-muted/30">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t('tasks:gitChanges.commits')}
              </span>
              {commits.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {commits.length}
                </Badge>
              )}
            </div>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-2">
              {isLoadingCommits ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : commitsError ? (
                <div className="text-center py-4 px-2">
                  <AlertCircle className="h-5 w-5 mx-auto mb-2 text-destructive" />
                  <p className="text-xs text-destructive break-words">{commitsError}</p>
                </div>
              ) : commits.length === 0 ? (
                <div className="text-center py-8">
                  <GitCommitIcon className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                  <p className="text-xs text-muted-foreground">{t('tasks:gitChanges.noCommits')}</p>
                </div>
              ) : (
                commits.map((commit, idx) => (
                  <button
                    key={commit.hash}
                    type="button"
                    onClick={() => setSelectedCommit(commit.hash)}
                    className={cn(
                      'relative w-full px-3 py-2 rounded-md border text-left transition-colors',
                      'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                      selectedCommit === commit.hash
                        ? 'bg-secondary border-primary'
                        : 'bg-card border-border hover:bg-secondary/50'
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <CommitGraph row={commitGraphRows[idx]} selected={selectedCommit === commit.hash} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-2 mb-1">
                          <div className="text-xs font-medium text-foreground line-clamp-2 flex-1 min-w-0">
                            {commit.message}
                          </div>
                          {commit.isMerge && (
                            <Badge variant="outline" className="h-4 px-1 text-[10px] shrink-0">
                              merge
                            </Badge>
                          )}
                        </div>
                        {(commit.refs ?? []).length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-1">
                            {(commit.refs ?? []).map(formatGitRef).filter((ref) => ref && ref !== 'HEAD').slice(0, 2).map((ref) => (
                              <Badge key={ref} variant="secondary" className="max-w-[120px] truncate px-1 py-0 text-[10px]">
                                {ref}
                              </Badge>
                            ))}
                          </div>
                        )}
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                          <code className="font-mono">{commit.shortHash}</code>
                          <span aria-hidden="true">|</span>
                          <span className="truncate">{commit.author}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {commit.date}
                        </div>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      </div>

      {/* Right side - Diff viewer */}
      <div className="flex-1 min-w-0 flex flex-col">
        {selectedFile && (
          <div className="px-4 py-2 border-b border-border flex items-center gap-2 shrink-0 bg-muted/30">
            {selectedGitFile && getFileStatusIcon(selectedGitFile.status)}
            <span className="text-sm font-medium flex-1 truncate">{selectedFile}</span>
            {selectedGitFile && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="text-green-600 dark:text-green-400">
                  +{selectedGitFile.additions}
                </span>
                <span className="text-red-600 dark:text-red-400">
                  -{selectedGitFile.deletions}
                </span>
              </div>
            )}
          </div>
        )}
        <ScrollArea className="flex-1">
          {renderDiff()}
        </ScrollArea>
      </div>
    </div>
  );
}
