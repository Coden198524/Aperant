/**
 * Custom hook for handling native HTML5 file drop events in Terminal.
 *
 * This hook encapsulates the file drop handling logic from FileTreeItem drag events,
 * making it testable in isolation using renderHook() from React Testing Library.
 *
 * The hook handles:
 * - Native drag over detection for application/json data
 * - External file/folder drops from the operating system
 * - File reference parsing and validation
 * - Shell argument escaping for safe command execution
 * - Terminal input insertion via electronAPI
 */
import { useState, useCallback, type DragEvent } from 'react';
import { parseFileReferenceDrop, escapeShellArg } from '../../../shared/utils/shell-escape';

export interface UseTerminalFileDropOptions {
  /** Terminal ID for sending input */
  terminalId: string;
  /** Callback to send input to terminal - defaults to window.electronAPI.sendTerminalInput */
  sendTerminalInput?: (terminalId: string, input: string) => void;
  /** Resolve a browser File to an absolute native path. Electron provides this via webUtils. */
  getPathForFile?: (file: File) => string;
}

export interface UseTerminalFileDropResult {
  /** Whether a native file drag is currently over the drop zone */
  isNativeDragOver: boolean;
  /** Handler for native dragover events */
  handleNativeDragOver: (e: DragEvent<HTMLDivElement>) => void;
  /** Handler for native dragleave events */
  handleNativeDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  /** Handler for native drop events */
  handleNativeDrop: (e: DragEvent<HTMLDivElement>) => void;
}

/**
 * Hook for handling native file drag-and-drop in Terminal components.
 *
 * This hook is extracted from Terminal.tsx to enable proper unit testing
 * using renderHook() rather than duplicating implementation logic in tests.
 *
 * @example
 * ```tsx
 * const { isNativeDragOver, handleNativeDragOver, handleNativeDragLeave, handleNativeDrop } =
 *   useTerminalFileDrop({ terminalId: 'term-1' });
 *
 * return (
 *   <div
 *     onDragOver={handleNativeDragOver}
 *     onDragLeave={handleNativeDragLeave}
 *     onDrop={handleNativeDrop}
 *   >
 *     {isNativeDragOver && <DropOverlay />}
 *   </div>
 * );
 * ```
 */
export function useTerminalFileDrop({
  terminalId,
  sendTerminalInput = (id, input) => window.electronAPI.sendTerminalInput(id, input),
  getPathForFile = (file) => window.electronAPI.getPathForFile(file)
}: UseTerminalFileDropOptions): UseTerminalFileDropResult {
  // Native HTML5 drag state for files dragged from FileTreeItem
  // This is needed because FileTreeItem uses native HTML5 drag events,
  // not @dnd-kit, so we must handle native drop events separately
  const [isNativeDragOver, setIsNativeDragOver] = useState(false);

  const hasSupportedDropData = useCallback((dataTransfer: DataTransfer) => {
    return dataTransfer.types.includes('application/json') || dataTransfer.types.includes('Files');
  }, []);

  const insertPaths = useCallback((paths: string[]) => {
    const validPaths = paths.filter((path) => path.trim().length > 0);
    if (validPaths.length === 0) return;

    const input = validPaths.map((path) => escapeShellArg(path)).join(' ') + ' ';
    sendTerminalInput(terminalId, input);
  }, [terminalId, sendTerminalInput]);

  const getExternalDropPaths = useCallback((dataTransfer: DataTransfer): string[] => {
    const files = Array.from(dataTransfer.files ?? []);
    return files
      .map((file) => {
        try {
          return getPathForFile(file);
        } catch {
          return '';
        }
      })
      .filter((path) => path.length > 0);
  }, [getPathForFile]);

  // Handle native drag over (for files from FileTreeItem or external OS drops)
  const handleNativeDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (hasSupportedDropData(e.dataTransfer)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setIsNativeDragOver(true);
    }
  }, [hasSupportedDropData]);

  // Handle native drag leave
  const handleNativeDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    // Only reset if actually leaving the container, not just moving to a child element
    // HTML5 drag events fire dragleave when moving from parent to child
    if (e.currentTarget.contains(e.relatedTarget as Node)) {
      return;
    }
    // Note: dragleave is not cancelable, so preventDefault() has no effect
    // We only call stopPropagation to prevent event bubbling
    e.stopPropagation();
    setIsNativeDragOver(false);
  }, []);

  // Handle native drop (for files from FileTreeItem or external OS drops)
  const handleNativeDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    setIsNativeDragOver(false);

    const fileRef = parseFileReferenceDrop(e.dataTransfer);
    if (fileRef) {
      e.preventDefault();
      e.stopPropagation();
      insertPaths([fileRef.path]);
      return;
    }

    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      insertPaths(getExternalDropPaths(e.dataTransfer));
    }
  }, [getExternalDropPaths, insertPaths]);

  return {
    isNativeDragOver,
    handleNativeDragOver,
    handleNativeDragLeave,
    handleNativeDrop
  };
}
