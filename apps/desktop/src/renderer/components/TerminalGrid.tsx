import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { Plus, Sparkles, Grid2X2, FolderTree, File, Folder, History, ChevronDown, Loader2, TerminalSquare, Settings } from 'lucide-react';
import { SortableTerminalWrapper } from './SortableTerminalWrapper';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from './ui/dropdown-menu';
import { FileExplorerPanel } from './FileExplorerPanel';
import { SmartCLIStatusBadge } from './SmartCLIStatusBadge';
import { cn } from '../lib/utils';
import { useTerminalStore, type Terminal } from '../stores/terminal-store';
import { useTaskStore } from '../stores/task-store';
import { useFileExplorerStore } from '../stores/file-explorer-store';
import { useSettingsStore } from '../stores/settings-store';
import { updateProjectSettings, useProjectStore } from '../stores/project-store';
import { DEFAULT_CLI, getCliLabel, getQuickCliOptionLabels } from '../lib/cli-display';
import { terminalBufferManager } from '../lib/terminal-buffer-manager';
import { TERMINAL_DOM_UPDATE_DELAY_MS, PANEL_CLEANUP_GRACE_PERIOD_MS } from '../../shared/constants';
import type { SupportedCLI } from '../../shared/types/settings';
import type { NativeCliSession } from '../../shared/types';

interface TerminalGridProps {
  projectId?: string;
  projectPath?: string;
  onNewTaskClick?: () => void;
  isActive?: boolean;
}

function normalizeTerminalPath(path: string | undefined): string {
  return (path || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function isSameOrDescendantPath(candidatePath: string | undefined, parentPath: string | undefined): boolean {
  const candidate = normalizeTerminalPath(candidatePath);
  const parent = normalizeTerminalPath(parentPath);
  return Boolean(candidate && parent) && (candidate === parent || candidate.startsWith(`${parent}/`));
}

function isTerminalForProject(terminal: Terminal, projectPath: string): boolean {
  if (terminal.projectPath) {
    return normalizeTerminalPath(terminal.projectPath) === normalizeTerminalPath(projectPath);
  }

  return isSameOrDescendantPath(terminal.cwd, projectPath);
}

export function TerminalGrid({ projectId, projectPath, onNewTaskClick, isActive = false }: TerminalGridProps) {
  const { t } = useTranslation('common');
  const modifierKey = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
  const newTerminalShortcut = `${modifierKey}+T`;
  const allTerminals = useTerminalStore((state) => state.terminals);
  const appPreferredCLI = useSettingsStore((state) => (state.settings.preferredCLI || DEFAULT_CLI) as SupportedCLI);
  const appCliRuntimeRoutes = useSettingsStore((state) => state.settings.autocodeCliRuntimeRoutes);
  const projectPreferredCLI = useProjectStore((state) =>
    projectId ? state.projects.find((project) => project.id === projectId)?.settings?.preferredCLI : undefined
  );
  const preferredCLI = (projectPreferredCLI || appPreferredCLI || DEFAULT_CLI) as SupportedCLI;
  const preferredCLILabel = getCliLabel(preferredCLI);
  const smartCliOptions = useMemo(
    () => getQuickCliOptionLabels(appCliRuntimeRoutes, [preferredCLI]),
    [appCliRuntimeRoutes, preferredCLI],
  );

  // Track terminals that are in the grace period before being filtered out
  // Map of terminal ID -> timestamp when it was marked for cleanup
  const [pendingCleanup, setPendingCleanup] = useState<Map<string, number>>(new Map());

  // Ref to track active cleanup timers — avoids including pendingCleanup in effect deps
  const cleanupTimersRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const previousTerminalCountRef = useRef(0);

  // Helper to clear all active cleanup timers
  const clearAllCleanupTimers = useCallback(() => {
    for (const timer of cleanupTimersRef.current.values()) {
      clearTimeout(timer);
    }
    cleanupTimersRef.current.clear();
  }, []);

  // Filter terminals to show only those belonging to the current project.
  // Legacy terminals without projectPath are included only when their cwd is inside this project.
  // Keep exited terminals in DOM during grace period to allow react-resizable-panels to reconcile
  const terminals = useMemo(() => {
    const filtered = projectPath
      ? allTerminals.filter(t => isTerminalForProject(t, projectPath))
      : allTerminals;

    // Filter out exited terminals UNLESS they are still in the grace period
    return filtered.filter(t => {
      if (t.status !== 'exited') {
        return true; // Keep all non-exited terminals
      }
      // Check if this exited terminal is in grace period
      const cleanupTime = pendingCleanup.get(t.id);
      if (cleanupTime) {
        const now = Date.now();
        return now < cleanupTime; // Keep if still within grace period
      }
      return false; // Remove if not in grace period
    });
  }, [allTerminals, projectPath, pendingCleanup]);

  const terminalSessionKey = useMemo(
    () => terminals.map(t => `${t.id}:${t.isCLIMode ? t.activeCLI || DEFAULT_CLI : 'shell'}`).join('|'),
    [terminals]
  );

  // Manage grace period timers for exited terminals
  // When a terminal exits, add it to pendingCleanup and schedule its removal
  // Uses cleanupTimersRef to track scheduled timers, avoiding pendingCleanup in deps
  // No cleanup function here — timers must survive dependency changes
  useEffect(() => {
    const filtered = projectPath
      ? allTerminals.filter(t => isTerminalForProject(t, projectPath))
      : allTerminals;

    const exitedTerminals = filtered.filter(t => t.status === 'exited');

    for (const terminal of exitedTerminals) {
      // Check ref (not state) to see if a timer is already scheduled
      if (!cleanupTimersRef.current.has(terminal.id)) {
        const cleanupTime = Date.now() + PANEL_CLEANUP_GRACE_PERIOD_MS;
        setPendingCleanup(prev => new Map(prev).set(terminal.id, cleanupTime));

        const timer = setTimeout(() => {
          cleanupTimersRef.current.delete(terminal.id);
          setPendingCleanup(prev => {
            const next = new Map(prev);
            next.delete(terminal.id);
            return next;
          });
        }, PANEL_CLEANUP_GRACE_PERIOD_MS);

        cleanupTimersRef.current.set(terminal.id, timer);
      }
    }
  }, [allTerminals, projectPath]);

  // Clear all cleanup timers on unmount
  useEffect(() => {
    return clearAllCleanupTimers;
  }, [clearAllCleanupTimers]);

  const activeTerminalId = useTerminalStore((state) => state.activeTerminalId);
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const removeTerminal = useTerminalStore((state) => state.removeTerminal);
  const setActiveTerminal = useTerminalStore((state) => state.setActiveTerminal);
  const canAddTerminal = useTerminalStore((state) => state.canAddTerminal);
  const setCLIMode = useTerminalStore((state) => state.setCLIMode);
  const setTerminalStatus = useTerminalStore((state) => state.setTerminalStatus);
  const updateTerminal = useTerminalStore((state) => state.updateTerminal);
  const reorderTerminals = useTerminalStore((state) => state.reorderTerminals);

  // Get tasks from task store for task selection dropdown in terminals
  const tasks = useTaskStore((state) => state.tasks);

  // File explorer state
  const fileExplorerOpen = useFileExplorerStore((state) => state.isOpen);
  const toggleFileExplorer = useFileExplorerStore((state) => state.toggle);

  // Native CLI history state. This reads Codex/Claude CLI storage, not Autocode terminal snapshots.
  const [nativeCliSessions, setNativeCliSessions] = useState<NativeCliSession[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const fetchNativeCliHistory = useCallback(async () => {
    if (!projectPath) {
      setNativeCliSessions([]);
      return;
    }

    setIsLoadingHistory(true);
    try {
      const result = await window.electronAPI.getNativeCliHistory(preferredCLI, projectPath);
      if (result.success && result.data) {
        setNativeCliSessions(result.data);
      } else {
        setNativeCliSessions([]);
      }
    } catch (error) {
      console.error('Failed to fetch native CLI history:', error);
      setNativeCliSessions([]);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [projectPath, preferredCLI]);

  // Expanded terminal state - when set, this terminal takes up the full grid space
  const [expandedTerminalId, setExpandedTerminalId] = useState<string | null>(null);

  // Reset expanded terminal and clear pending cleanup when project changes
  useEffect(() => {
    setExpandedTerminalId(null);
    setPendingCleanup(new Map());
    clearAllCleanupTimers();
  }, [projectPath, clearAllCleanupTimers]);

  useEffect(() => {
    if (!projectPath) {
      return;
    }

    const activeTerminal = allTerminals.find((terminal) => terminal.id === activeTerminalId);
    if (activeTerminal && isTerminalForProject(activeTerminal, projectPath)) {
      return;
    }

    const nextActiveTerminal = allTerminals
      .filter((terminal) => isTerminalForProject(terminal, projectPath) && terminal.status !== 'exited')
      .sort((terminalA, terminalB) => (terminalA.displayOrder ?? 0) - (terminalB.displayOrder ?? 0))[0];

    setActiveTerminal(nextActiveTerminal?.id ?? null);
  }, [activeTerminalId, allTerminals, projectPath, setActiveTerminal]);

  // TerminalGrid stays mounted while hidden so xterm state is preserved.
  // When the view becomes visible again, force a refit because ResizeObserver
  // can miss display:none -> visible transitions and xterm may keep stale cols.
  useEffect(() => {
    if (!isActive || terminals.length === 0) {
      return;
    }

    const dispatchRefit = () => {
      window.dispatchEvent(new CustomEvent('terminal-refit-all'));
    };

    const raf = typeof requestAnimationFrame !== 'undefined'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
    const cancelRaf = typeof cancelAnimationFrame !== 'undefined'
      ? cancelAnimationFrame
      : (id: number) => clearTimeout(id);

    const rafId = raf(dispatchRefit);
    const timeoutId = setTimeout(dispatchRefit, TERMINAL_DOM_UPDATE_DELAY_MS);

    return () => {
      cancelRaf(rafId);
      clearTimeout(timeoutId);
    };
  }, [isActive, terminals.length]);

  // Fetch native CLI history when project or selected CLI changes.
  useEffect(() => {
    if (!projectPath) {
      setNativeCliSessions([]);
      return;
    }

    void fetchNativeCliHistory();
  }, [projectPath, preferredCLI, terminalSessionKey, fetchNativeCliHistory]);

  const handleResumeNativeCliSession = useCallback(async (session: NativeCliSession) => {
    if (!projectPath || isRestoring) return;

    setIsRestoring(true);
    try {
      const terminal = addTerminal(projectPath, projectPath, {
        title: `${getCliLabel(session.cli)}: ${session.title}`,
        isCLIMode: true,
        activeCLI: session.cli,
      });

      if (!terminal) {
        return;
      }

      const createResult = await window.electronAPI.createTerminal({
        id: terminal.id,
        cwd: projectPath,
        projectPath,
        cols: 80,
        rows: 24,
      });

      if (!createResult.success) {
        console.warn('[TerminalGrid] Failed to create terminal for native CLI resume:', createResult.error);
        removeTerminal(terminal.id);
        return;
      }

      setTerminalStatus(terminal.id, 'running');
      setActiveTerminal(terminal.id);

      const resumeResult = await window.electronAPI.resumeNativeCliSession(
        terminal.id,
        session.cli,
        session.id,
        projectPath
      );

      if (resumeResult.success) {
        if (resumeResult.data?.outputBuffer) {
          terminalBufferManager.set(terminal.id, resumeResult.data.outputBuffer);
        }
        setCLIMode(terminal.id, true, session.cli);
        updateTerminal(terminal.id, {
          title: `${getCliLabel(session.cli)}: ${session.title}`,
          claudeSessionId: session.cli === 'claude-code' ? session.id : undefined,
        });

        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('terminal-refit-all'));
        }, TERMINAL_DOM_UPDATE_DELAY_MS);
      } else {
        console.warn('[TerminalGrid] Failed to resume native CLI session:', resumeResult.error);
      }
    } catch (error) {
      console.error('Failed to resume native CLI session:', error);
    } finally {
      setIsRestoring(false);
    }
  }, [projectPath, isRestoring, addTerminal, removeTerminal, setTerminalStatus, setActiveTerminal, setCLIMode, updateTerminal]);

  // Setup drag sensors for both file and terminal drag operations
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px movement required before drag starts
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Track dragging state for file overlay
  const [activeDragData, setActiveDragData] = React.useState<{
    path: string;
    name: string;
    isDirectory: boolean;
  } | null>(null);

  // Track dragging terminal for overlay
  const [draggingTerminalId, setDraggingTerminalId] = React.useState<string | null>(null);
  const draggingTerminal = terminals.find(t => t.id === draggingTerminalId);

  const handleCloseTerminal = useCallback((id: string) => {
    window.electronAPI.destroyTerminal(id);
    removeTerminal(id);
    // Clear expanded state if the closed terminal was expanded
    if (expandedTerminalId === id) {
      setExpandedTerminalId(null);
    }
  }, [removeTerminal, expandedTerminalId]);

  const handleAddTerminal = useCallback(() => {
    if (canAddTerminal(projectPath)) {
      addTerminal(projectPath, projectPath, {
        title: getCliLabel(preferredCLI),
        autoInvokeCLI: preferredCLI,
      });

      for (const delay of [0, 100, 300]) {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('terminal-refit-all'));
        }, delay);
      }
    }
  }, [addTerminal, canAddTerminal, projectPath, preferredCLI]);

  // Handle keyboard shortcut for new terminal (only when this view is active)
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+T or Cmd+T for new terminal
      if ((e.ctrlKey || e.metaKey) && e.key === 't') {
        e.preventDefault();
        handleAddTerminal();
      }
      // Ctrl+W or Cmd+W to close active terminal
      if ((e.ctrlKey || e.metaKey) && e.key === 'w' && activeTerminalId) {
        e.preventDefault();
        handleCloseTerminal(activeTerminalId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, handleAddTerminal, activeTerminalId, handleCloseTerminal]);

  useEffect(() => {
    const previousCount = previousTerminalCountRef.current;
    previousTerminalCountRef.current = terminals.length;

    if (previousCount === 0 && terminals.length > 0) {
      for (const delay of [0, 100, 300]) {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('terminal-refit-all'));
        }, delay);
      }
    }
  }, [terminals.length]);

  // Toggle terminal expand state
  const handleToggleExpand = useCallback((terminalId: string) => {
    setExpandedTerminalId(prev => prev === terminalId ? null : terminalId);
  }, []);

  const handleInvokeCLIAll = useCallback(() => {
    terminals.forEach((terminal) => {
      if (terminal.status === 'running' && !terminal.isCLIMode) {
        setCLIMode(terminal.id, true, preferredCLI);
        window.electronAPI.invokeCLIInTerminal(terminal.id, terminal.cwd || projectPath, preferredCLI);
      }
    });
  }, [terminals, setCLIMode, projectPath, preferredCLI]);

  const handlePreferredCLIChange = useCallback((cli: SupportedCLI) => {
    if (!projectId) {
      return;
    }
    void updateProjectSettings(projectId, { preferredCLI: cli });
  }, [projectId]);

  // Handle drag start - store dragged item data
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as {
      type: string;
      path?: string;
      name?: string;
      isDirectory?: boolean;
      terminalId?: string;
    } | undefined;

    if (data?.type === 'file' && data.path && data.name !== undefined) {
      setActiveDragData({
        path: data.path,
        name: data.name,
        isDirectory: data.isDirectory ?? false
      });
    } else if (data?.type === 'terminal-panel') {
      setDraggingTerminalId(event.active.id.toString());
    }
  }, []);

  // Handle drag end - insert file path into terminal or reorder terminals
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    const activeData = active.data.current as { type?: string; path?: string } | undefined;

    // Clear drag states
    setActiveDragData(null);
    setDraggingTerminalId(null);

    if (!over) return;

    // Handle terminal reordering
    if (activeData?.type === 'terminal-panel') {
      const activeId = active.id.toString();
      let overId = over.id.toString();

      // Handle case where over is the file drop zone (terminal-xyz) instead of sortable item (xyz)
      if (overId.startsWith('terminal-')) {
        overId = overId.replace('terminal-', '');
      }

      if (activeId !== overId && terminals.some(t => t.id === overId)) {
        reorderTerminals(activeId, overId);

        // Persist the new order to disk so it survives app restarts
        // Use a microtask to ensure the store has updated before we read the new order
        if (projectPath) {
          queueMicrotask(async () => {
            const updatedTerminals = useTerminalStore.getState().terminals;
            const orders = updatedTerminals
              .filter(t => isTerminalForProject(t, projectPath))
              .map(t => ({ terminalId: t.id, displayOrder: t.displayOrder ?? 0 }));
            try {
              const result = await window.electronAPI.updateTerminalDisplayOrders(projectPath, orders);
              if (!result.success) {
                console.warn('[TerminalGrid] Failed to persist terminal order:', result.error);
              }
            } catch (error) {
              console.warn('[TerminalGrid] Failed to persist terminal order:', error);
            }
          });
        }

        // Refit terminals after dnd-kit CSS transitions settle
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('terminal-refit-all'));
        }, TERMINAL_DOM_UPDATE_DELAY_MS);
      }
      return;
    }

    // Handle file drop on terminal
    const overId = over.id.toString();
    let terminalId: string | null = null;

    if (overId.startsWith('terminal-')) {
      terminalId = overId.replace('terminal-', '');
    } else if (terminals.some(t => t.id === overId)) {
      // closestCenter might return the sortable ID instead of droppable ID
      terminalId = overId;
    }

    if (terminalId && activeData?.path) {
      // Quote the path if it contains spaces
      const quotedPath = activeData.path.includes(' ') ? `"${activeData.path}"` : activeData.path;
      // Insert the file path into the terminal with a trailing space
      window.electronAPI.sendTerminalInput(terminalId, quotedPath + ' ');
    }
  }, [reorderTerminals, terminals, projectPath]);

  // Calculate grid layout based on number of terminals
  const gridLayout = useMemo(() => {
    const count = terminals.length;
    if (count === 0) return { rows: 0, cols: 0 };
    if (count === 1) return { rows: 1, cols: 1 };
    if (count === 2) return { rows: 1, cols: 2 };
    if (count <= 4) return { rows: 2, cols: 2 };
    if (count <= 6) return { rows: 2, cols: 3 };
    if (count <= 9) return { rows: 3, cols: 3 };
    return { rows: 3, cols: 4 }; // Max 12 terminals = 3x4
  }, [terminals.length]);

  // Terminal IDs for SortableContext
  const terminalIds = useMemo(() => terminals.map(t => t.id), [terminals]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full flex-col">
        {/* Toolbar */}
        <div className="flex h-10 items-center justify-between border-b border-border bg-card/30 px-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t('terminalGrid.count', {
                count: terminals.length,
                defaultValue: '{{count}} / 12 terminals'
              })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* Current smart terminal CLI status */}
            <SmartCLIStatusBadge cli={preferredCLI} />
            {/* Session history dropdown */}
            {projectPath && (
              <DropdownMenu onOpenChange={(open) => {
                if (open) {
                  void fetchNativeCliHistory();
                }
              }}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1.5"
                    disabled={isRestoring || isLoadingHistory}
                  >
                    {isRestoring ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <History className="h-3 w-3" />
                    )}
                    {t('terminalGrid.history', { defaultValue: `${preferredCLILabel} History` })}
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80">
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    {t('terminalGrid.restoreCliSession', { defaultValue: `Resume ${preferredCLILabel} CLI session...` })}
                  </div>
                  <DropdownMenuSeparator />
                  {nativeCliSessions.length === 0 ? (
                    <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                      {isLoadingHistory
                        ? t('terminalGrid.loadingHistory', { defaultValue: 'Loading history...' })
                        : t('terminalGrid.noCliHistory', { defaultValue: `No ${preferredCLILabel} sessions yet` })}
                    </DropdownMenuItem>
                  ) : (
                    nativeCliSessions.slice(0, 25).map((session) => (
                      <DropdownMenuItem
                        key={session.id}
                        onClick={() => handleResumeNativeCliSession(session)}
                        className="flex flex-col items-start gap-0.5"
                      >
                        <span className="max-w-full truncate text-xs">{session.title}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(session.updatedAt).toLocaleString()}
                        </span>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('open-app-settings', { detail: 'terminal-fonts' }));
              }}
            >
              <Settings className="h-3 w-3" />
              {t('actions.settings')}
            </Button>
            {terminals.some((t) => t.status === 'running' && !t.isCLIMode) && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={handleInvokeCLIAll}
              >
                <Sparkles className="h-3 w-3" />
                {t('terminalGrid.invokeAll', { defaultValue: `Invoke ${preferredCLILabel} All` })}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5"
                  title="Select default smart terminal CLI"
                >
                  <Sparkles className="h-3 w-3" />
                  {preferredCLILabel}
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                  Smart terminal CLI
                </div>
                <DropdownMenuSeparator />
                {smartCliOptions.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onClick={() => handlePreferredCLIChange(option.value)}
                    className="flex items-center justify-between text-xs"
                  >
                    <span>{option.label}</span>
                    {preferredCLI === option.value && (
                      <span className="text-primary">
                        {t('terminalGrid.projectDefault', { defaultValue: 'Project' })}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={handleAddTerminal}
              disabled={!canAddTerminal(projectPath)}
            >
              <Plus className="h-3 w-3" />
              {t('terminalGrid.newTerminal', { defaultValue: 'New Terminal' })}
              <kbd className="ml-1 text-[10px] text-muted-foreground">
                {newTerminalShortcut}
              </kbd>
            </Button>
            {/* File explorer toggle button */}
            {projectPath && (
              <Button
                variant={fileExplorerOpen ? 'default' : 'outline'}
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={toggleFileExplorer}
              >
                <FolderTree className="h-3 w-3" />
                {t('terminalGrid.files', { defaultValue: 'Files' })}
              </Button>
            )}
          </div>
        </div>

        {/* Main content area with terminal grid and file explorer sidebar */}
        {terminals.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-hidden p-8">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="rounded-full bg-card p-4">
                <Grid2X2 className="h-8 w-8 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  {t('terminalGrid.title', { defaultValue: 'Agent Terminals' })}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground max-w-md">
                  {t('terminalGrid.emptyDescriptionPrefix', {
                    defaultValue: 'Spawn multiple agent terminals in parallel. Use '
                  })}
                  <kbd className="px-1.5 py-0.5 text-xs bg-card border border-border rounded">{newTerminalShortcut}</kbd>
                  {t('terminalGrid.emptyDescriptionSuffix', {
                    defaultValue: ' to create a new terminal.'
                  })}
                </p>
              </div>
            </div>
            <Button onClick={handleAddTerminal} className="gap-2">
              <Plus className="h-4 w-4" />
              {t('terminalGrid.newTerminal', { defaultValue: 'New Terminal' })}
            </Button>
          </div>
        ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* File explorer panel (left side, pushes terminal content right) */}
          {projectPath && <FileExplorerPanel projectPath={projectPath} />}

          {/* Terminal grid using resizable panels */}
          <div className={cn(
            "flex-1 overflow-hidden p-2 transition-all duration-300 ease-out",
            fileExplorerOpen && "pl-0"
          )}>
            {expandedTerminalId ? (
              // Show only the expanded terminal
              (() => {
                const expandedTerminal = terminals.find(t => t.id === expandedTerminalId);
                if (!expandedTerminal) return null;
                return (
                  <div className="h-full p-1">
                    <SortableTerminalWrapper
                      id={expandedTerminal.id}
                      cwd={expandedTerminal.cwd || projectPath}
                      projectPath={projectPath}
                      isActive={expandedTerminal.id === activeTerminalId}
                      onClose={() => handleCloseTerminal(expandedTerminal.id)}
                      onActivate={() => setActiveTerminal(expandedTerminal.id)}
                      tasks={tasks}
                      onNewTaskClick={onNewTaskClick}
                      terminalCount={1}
                      isExpanded={true}
                      onToggleExpand={() => handleToggleExpand(expandedTerminal.id)}
                      defaultCLI={preferredCLI}
                    />
                  </div>
                );
              })()
            ) : (
              // Flat CSS Grid layout — all terminals are siblings of the same parent.
              // This prevents React from unmounting/remounting terminal components during
              // drag-drop reorder. With the old nested Group/Panel structure from
              // react-resizable-panels, terminals that changed rows got new parents,
              // causing React to unmount → dispose xterm → blank screen.
              // With a flat grid, React just reorders siblings (no unmount needed).
              <SortableContext items={terminalIds} strategy={rectSortingStrategy}>
                <div
                  className="h-full grid"
                  style={{
                    gridTemplateColumns: `repeat(${gridLayout.cols}, 1fr)`,
                    gridTemplateRows: `repeat(${gridLayout.rows}, 1fr)`,
                  }}
                >
                  {terminals.map((terminal) => (
                    <div key={terminal.id} className="p-1 min-h-0 min-w-0">
                      <SortableTerminalWrapper
                        id={terminal.id}
                        cwd={terminal.cwd || projectPath}
                        projectPath={projectPath}
                        isActive={terminal.id === activeTerminalId}
                        onClose={() => handleCloseTerminal(terminal.id)}
                        onActivate={() => setActiveTerminal(terminal.id)}
                        tasks={tasks}
                        onNewTaskClick={onNewTaskClick}
                        terminalCount={terminals.length}
                        isExpanded={false}
                        onToggleExpand={() => handleToggleExpand(terminal.id)}
                        defaultCLI={preferredCLI}
                      />
                    </div>
                  ))}
                </div>
              </SortableContext>
            )}
          </div>

        </div>
        )}

        {/* Drag overlay - shows what's being dragged */}
        <DragOverlay>
          {activeDragData && (
            <div className="flex items-center gap-2 bg-card border border-border rounded-md px-3 py-2 shadow-lg">
              {activeDragData.isDirectory ? (
                <Folder className="h-4 w-4 text-warning" />
              ) : (
                <File className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="text-sm">{activeDragData.name}</span>
            </div>
          )}
          {draggingTerminal && (
            <div className="flex items-center gap-2 bg-card border border-primary rounded-md px-3 py-2 shadow-lg">
              <TerminalSquare className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">
                {draggingTerminal.title || t('terminalGrid.terminal', { defaultValue: 'Terminal' })}
              </span>
            </div>
          )}
        </DragOverlay>
      </div>
    </DndContext>
  );
}
