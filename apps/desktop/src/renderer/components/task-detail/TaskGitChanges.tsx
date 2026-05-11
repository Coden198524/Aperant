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
  Copy
} from 'lucide-react';
import { ScrollArea } from '../ui/scroll-area';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import { useToast } from '../../hooks/use-toast';
import type { Task, WorktreeDiffFile } from '../../../shared/types';

interface TaskGitChangesProps {
  task: Task;
}

type GitFileStatus = 'M' | 'A' | 'D' | 'R';
type ChangeSetMode = 'workspace' | 'commit';

interface GitFile {
  path: string;
  status: GitFileStatus;
  additions: number;
  deletions: number;
  previousPath?: string;
  patch?: string;
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

interface CommitFileStats {
  filesChanged: number;
  additions: number;
  deletions: number;
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

function getFileStatusIcon(status: string) {
  switch (status) {
    case 'A':
      return <FilePlus className="h-4 w-4 text-green-500" />;
    case 'D':
      return <FileX className="h-4 w-4 text-red-500" />;
    case 'R':
      return <FileDiff className="h-4 w-4 text-blue-500" />;
    default:
      return <FileDiff className="h-4 w-4 text-amber-500" />;
  }
}

function getFileStatusLabel(status: string, t: (key: string, options?: Record<string, unknown>) => string) {
  switch (status) {
    case 'A':
      return t('tasks:gitChanges.added');
    case 'D':
      return t('tasks:gitChanges.deleted');
    case 'R':
      return t('tasks:gitChanges.renamed', { defaultValue: 'Renamed' });
    default:
      return t('tasks:gitChanges.modified');
  }
}

function getBadgeVariant(status: GitFileStatus): 'default' | 'destructive' | 'secondary' | 'outline' {
  switch (status) {
    case 'A':
      return 'default';
    case 'D':
      return 'destructive';
    case 'R':
      return 'outline';
    default:
      return 'secondary';
  }
}

function mapWorktreeStatus(status: WorktreeDiffFile['status']): GitFileStatus {
  switch (status) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    default:
      return 'M';
  }
}

function mapWorktreeFile(file: WorktreeDiffFile): GitFile {
  return {
    path: file.path,
    previousPath: file.previousPath,
    status: mapWorktreeStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  };
}

export function TaskGitChanges({ task }: TaskGitChangesProps) {
  const { t } = useTranslation(['tasks']);
  const { toast } = useToast();

  // State for current worktree changes
  const [workspaceFiles, setWorkspaceFiles] = useState<GitFile[]>([]);
  const [workspaceSummary, setWorkspaceSummary] = useState<string>('');
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [hasLoadedWorkspace, setHasLoadedWorkspace] = useState(false);
  const [activeChangeSet, setActiveChangeSet] = useState<ChangeSetMode>('workspace');

  // State for commits
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [isLoadingCommits, setIsLoadingCommits] = useState(false);
  const [commitsError, setCommitsError] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);

  // State for commit files
  const [commitFiles, setCommitFiles] = useState<GitFile[]>([]);
  const [isLoadingCommitFiles, setIsLoadingCommitFiles] = useState(false);
  const [commitFilesError, setCommitFilesError] = useState<string | null>(null);
  const [commitFileStats, setCommitFileStats] = useState<Map<string, CommitFileStats>>(new Map());

  // State for diff
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const commitGraphRows = useMemo(() => buildCommitGraphRows(commits), [commits]);

  // Load current worktree changes. This captures committed and uncommitted file
  // changes so the tab remains useful before the task branch has commits.
  const loadWorkspaceDiff = useCallback(async () => {
    setIsLoadingWorkspace(true);
    setWorkspaceError(null);
    setHasLoadedWorkspace(false);

    try {
      const result = await window.electronAPI.getWorktreeDiff(task.id, task.projectId);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to load workspace changes');
      }

      setWorkspaceFiles(result.data.files.map(mapWorktreeFile));
      setWorkspaceSummary(result.data.summary);
    } catch (err) {
      setWorkspaceFiles([]);
      setWorkspaceSummary('');
      setWorkspaceError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingWorkspace(false);
      setHasLoadedWorkspace(true);
    }
  }, [task.id, task.projectId]);

  // Load commit history
  const loadCommits = useCallback(async () => {
    setIsLoadingCommits(true);
    setCommitsError(null);

    try {
      const result = await window.electronAPI.getWorktreeCommits(task.id, task.projectId);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to load commits');
      }
      setCommits(result.data);
    } catch (err) {
      setCommitsError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingCommits(false);
    }
  }, [task.id, task.projectId]);

  // Load files for selected commit
  const loadCommitFiles = useCallback(async (commitHash: string) => {
    setIsLoadingCommitFiles(true);
    setCommitFilesError(null);
    setCommitFiles([]);
    setSelectedFile(null);

    try {
      const result = await window.electronAPI.getWorktreeCommitFiles(task.id, commitHash, task.projectId);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to load commit files');
      }

      setCommitFiles(result.data);

      // Calculate stats for this commit
      const stats: CommitFileStats = {
        filesChanged: result.data.length,
        additions: result.data.reduce((sum: number, file: GitFile) => sum + file.additions, 0),
        deletions: result.data.reduce((sum: number, file: GitFile) => sum + file.deletions, 0)
      };

      setCommitFileStats(prev => new Map(prev).set(commitHash, stats));

      // Auto-select first file
      if (result.data.length > 0) {
        setSelectedFile(result.data[0].path);
      }
    } catch (err) {
      setCommitFilesError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingCommitFiles(false);
    }
  }, [task.id, task.projectId]);

  // Load diff for selected file in selected commit
  const loadDiff = useCallback(async (commitHash: string, filePath: string) => {
    setSelectedFile(filePath);
    setIsLoadingDiff(true);
    setDiffError(null);
    setDiff(null);

    try {
      const result = await window.electronAPI.getWorktreeCommitFileDiff(task.id, commitHash, filePath, task.projectId);
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

  // Reset derived state when switching tasks
  useEffect(() => {
    setWorkspaceFiles([]);
    setWorkspaceSummary('');
    setWorkspaceError(null);
    setHasLoadedWorkspace(false);
    setCommits([]);
    setCommitsError(null);
    setSelectedCommit(null);
    setCommitFiles([]);
    setCommitFilesError(null);
    setCommitFileStats(new Map());
    setSelectedFile(null);
    setDiff(null);
    setDiffError(null);
    setActiveChangeSet('workspace');
  }, [task.id, task.projectId]);

  // Load current worktree changes and commit history on mount/task change
  useEffect(() => {
    loadWorkspaceDiff();
  }, [loadWorkspaceDiff]);

  useEffect(() => {
    loadCommits();
  }, [loadCommits]);

  // Prefer current worktree changes. If there are no file changes, fall back to
  // commit history so completed task branches still show reviewable content.
  useEffect(() => {
    if (!hasLoadedWorkspace || activeChangeSet !== 'workspace') {
      return;
    }

    if (workspaceFiles.length > 0) {
      const nextFile = workspaceFiles.find((file) => file.path === selectedFile) ?? workspaceFiles[0];
      if (selectedFile !== nextFile.path) {
        setSelectedFile(nextFile.path);
      }
      setDiff(nextFile.patch ?? '');
      setDiffError(null);
      return;
    }

    if (commits.length > 0 && !selectedCommit) {
      setActiveChangeSet('commit');
      setSelectedCommit(commits[0].hash);
      return;
    }

    setSelectedFile(null);
    setDiff(null);
    setDiffError(null);
  }, [activeChangeSet, commits, hasLoadedWorkspace, selectedCommit, selectedFile, workspaceFiles]);

  // Load files when commit is selected
  useEffect(() => {
    if (activeChangeSet === 'commit' && selectedCommit) {
      loadCommitFiles(selectedCommit);
    }
  }, [activeChangeSet, selectedCommit, loadCommitFiles]);

  // Load diff when file is selected
  useEffect(() => {
    if (activeChangeSet === 'commit' && selectedCommit && selectedFile) {
      loadDiff(selectedCommit, selectedFile);
    }
  }, [activeChangeSet, selectedCommit, selectedFile, loadDiff]);

  // Copy commit hash to clipboard
  const copyCommitHash = useCallback(async (hash: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(hash);
      toast({
        title: t('tasks:gitChanges.hashCopied'),
        duration: 2000
      });
    } catch (err) {
      console.error('Failed to copy hash:', err);
    }
  }, [toast, t]);

  const displayedFiles = activeChangeSet === 'workspace' ? workspaceFiles : commitFiles;
  const isLoadingFiles = activeChangeSet === 'workspace' ? isLoadingWorkspace : isLoadingCommitFiles;
  const filesError = activeChangeSet === 'workspace' ? workspaceError : commitFilesError;
  const workspaceStats = useMemo(
    () => ({
      filesChanged: workspaceFiles.length,
      additions: workspaceFiles.reduce((sum, file) => sum + file.additions, 0),
      deletions: workspaceFiles.reduce((sum, file) => sum + file.deletions, 0),
    }),
    [workspaceFiles]
  );
  const selectedFileData = useMemo(
    () => displayedFiles.find((file) => file.path === selectedFile),
    [displayedFiles, selectedFile]
  );

  const selectWorkspaceChanges = useCallback(() => {
    setActiveChangeSet('workspace');
    setDiffError(null);

    if (workspaceFiles.length === 0) {
      setSelectedFile(null);
      setDiff(null);
      return;
    }

    const nextFile = workspaceFiles.find((file) => file.path === selectedFile) ?? workspaceFiles[0];
    setSelectedFile(nextFile.path);
    setDiff(nextFile.patch ?? '');
  }, [selectedFile, workspaceFiles]);

  const selectFile = useCallback((file: GitFile) => {
    setSelectedFile(file.path);
    if (activeChangeSet === 'workspace') {
      setDiffError(null);
      setDiff(file.patch ?? '');
    }
  }, [activeChangeSet]);

  const refreshGitChanges = useCallback(() => {
    void loadWorkspaceDiff();
    void loadCommits();
  }, [loadCommits, loadWorkspaceDiff]);

  // Render diff content
  const renderDiff = () => {
    if (activeChangeSet === 'workspace' && isLoadingWorkspace) {
      return (
        <div className="h-full flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }

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
              onClick={() => {
                if (activeChangeSet === 'workspace') {
                  void loadWorkspaceDiff();
                } else if (selectedCommit && selectedFile) {
                  void loadDiff(selectedCommit, selectedFile);
                }
              }}
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
      {/* Left column - Change sets and commit history */}
      <div className="w-[320px] border-r border-border flex flex-col shrink-0">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between bg-muted/30">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('tasks:gitChanges.title')}
            </span>
            {(workspaceFiles.length + commits.length) > 0 && (
              <Badge variant="secondary" className="text-xs">
                {workspaceFiles.length + commits.length}
              </Badge>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={refreshGitChanges}
            disabled={isLoadingWorkspace || isLoadingCommits}
          >
            <RefreshCw className={cn("h-3 w-3", (isLoadingWorkspace || isLoadingCommits) && "animate-spin")} />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-2">
            <button
              type="button"
              onClick={selectWorkspaceChanges}
              className={cn(
                'relative w-full px-3 py-2 rounded-md border text-left transition-colors',
                'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                activeChangeSet === 'workspace'
                  ? 'bg-secondary border-primary'
                  : 'bg-card border-border hover:bg-secondary/50'
              )}
            >
              <div className="flex items-start gap-2">
                <FileDiff className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-foreground">
                      {t('tasks:gitChanges.files')}
                    </span>
                    {workspaceFiles.length > 0 && (
                      <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                        {workspaceFiles.length}
                      </Badge>
                    )}
                    {isLoadingWorkspace && (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground line-clamp-2">
                    {workspaceError ? (
                      <span className="text-destructive">{workspaceError}</span>
                    ) : workspaceSummary ? (
                      workspaceSummary
                    ) : (
                      t('tasks:gitChanges.noChanges')
                    )}
                  </div>
                  {workspaceFiles.length > 0 && (
                    <div className="flex items-center gap-2 text-[10px] mt-1 pt-1 border-t border-border/50">
                      <span className="text-muted-foreground">
                        {t('tasks:gitChanges.filesChanged', { count: workspaceStats.filesChanged })}
                      </span>
                      <span className="text-green-600 dark:text-green-400">
                        +{workspaceStats.additions}
                      </span>
                      <span className="text-red-600 dark:text-red-400">
                        -{workspaceStats.deletions}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </button>

            <div className="px-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('tasks:gitChanges.commits')}
            </div>
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
              commits.map((commit, idx) => {
                const stats = commitFileStats.get(commit.hash);
                return (
                  <button
                    key={commit.hash}
                    type="button"
                    onClick={() => {
                      setActiveChangeSet('commit');
                      setSelectedCommit(commit.hash);
                    }}
                    className={cn(
                      'relative w-full px-3 py-2 rounded-md border text-left transition-colors',
                      'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                      activeChangeSet === 'commit' && selectedCommit === commit.hash
                        ? 'bg-secondary border-primary'
                        : 'bg-card border-border hover:bg-secondary/50'
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <CommitGraph row={commitGraphRows[idx]} selected={activeChangeSet === 'commit' && selectedCommit === commit.hash} />
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
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-0.5">
                          <button
                            type="button"
                            onClick={(e) => copyCommitHash(commit.hash, e)}
                            className="font-mono hover:text-foreground transition-colors flex items-center gap-1 group"
                            title={t('tasks:gitChanges.copyHash')}
                          >
                            <code>{commit.shortHash}</code>
                            <Copy className="h-2.5 w-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </button>
                          <span aria-hidden="true">|</span>
                          <span className="truncate">{commit.author}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {commit.date}
                        </div>
                        {stats && (
                          <div className="flex items-center gap-2 text-[10px] mt-1 pt-1 border-t border-border/50">
                            <span className="text-muted-foreground">
                              {t('tasks:gitChanges.filesChanged', { count: stats.filesChanged })}
                            </span>
                            <span className="text-green-600 dark:text-green-400">
                              +{stats.additions}
                            </span>
                            <span className="text-red-600 dark:text-red-400">
                              -{stats.deletions}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Middle column - Files list */}
      <div className="w-[280px] border-r border-border flex flex-col shrink-0">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between bg-muted/30">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {activeChangeSet === 'workspace'
                ? t('tasks:gitChanges.files')
                : t('tasks:gitChanges.commitFiles')}
            </span>
            {displayedFiles.length > 0 && (
              <Badge variant="secondary" className="text-xs">
                {displayedFiles.length}
              </Badge>
            )}
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1">
            {activeChangeSet === 'commit' && !selectedCommit ? (
              <div className="text-center py-8">
                <GitCommitIcon className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">{t('tasks:gitChanges.selectCommit')}</p>
              </div>
            ) : isLoadingFiles ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : filesError ? (
              <div className="text-center py-4 px-2">
                <AlertCircle className="h-5 w-5 mx-auto mb-2 text-destructive" />
                <p className="text-xs text-destructive break-words">{filesError}</p>
              </div>
            ) : displayedFiles.length === 0 ? (
              <div className="text-center py-8">
                <FileText className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">{t('tasks:gitChanges.noChanges')}</p>
              </div>
            ) : (
              displayedFiles.map((file) => (
                <button
                  key={`${file.status}-${file.previousPath ?? ''}-${file.path}`}
                  type="button"
                  onClick={() => selectFile(file)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors',
                    'hover:bg-secondary/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1',
                    selectedFile === file.path && 'bg-secondary'
                  )}
                >
                  {getFileStatusIcon(file.status)}
                  <Badge
                    variant={getBadgeVariant(file.status)}
                    className="text-[10px] px-1 py-0 h-4 min-w-[16px] justify-center"
                    title={getFileStatusLabel(file.status, t)}
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
                    {file.previousPath && (
                      <div className="text-[10px] text-muted-foreground/70 truncate">
                        {file.previousPath}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-[10px] shrink-0">
                    <span className="text-green-600 dark:text-green-400">+{file.additions}</span>
                    <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right column - Diff viewer */}
      <div className="flex-1 min-w-0 flex flex-col">
        {selectedFile && selectedFileData && (
          <div className="px-4 py-2 border-b border-border flex items-center gap-2 shrink-0 bg-muted/30">
            {getFileStatusIcon(selectedFileData.status)}
            <span className="text-sm font-medium flex-1 truncate">{selectedFile}</span>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="text-green-600 dark:text-green-400">
                +{selectedFileData.additions}
              </span>
              <span className="text-red-600 dark:text-red-400">
                -{selectedFileData.deletions}
              </span>
            </div>
          </div>
        )}
        <ScrollArea className="flex-1">
          {renderDiff()}
        </ScrollArea>
      </div>
    </div>
  );
}
