import { ipcRenderer, webUtils } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { FileExplorerChangeEvent, IPCResult } from '../../shared/types';

export interface FileAPI {
  // File Explorer Operations
  listDirectory: (dirPath: string) => Promise<IPCResult<import('../../shared/types').FileNode[]>>;
  readFile: (filePath: string) => Promise<IPCResult<string>>;
  readImageFile: (filePath: string) => Promise<IPCResult<{ dataUrl: string; mimeType: string; size: number }>>;
  writeFile: (filePath: string, content: string) => Promise<IPCResult<void>>;
  getFileDiff: (projectPath: string, filePath: string) => Promise<IPCResult<string>>;
  getChangedFiles: (projectPath: string) => Promise<IPCResult<string[]>>;
  getPathForFile: (file: File) => string;
  showItemInFolder: (filePath: string) => Promise<IPCResult<void>>;
  watchProjectFiles: (projectPath: string) => Promise<IPCResult<void>>;
  unwatchProjectFiles: (projectPath: string) => Promise<IPCResult<void>>;
  onProjectFilesChanged: (callback: (event: FileExplorerChangeEvent) => void) => () => void;
}

export const createFileAPI = (): FileAPI => ({
  // File Explorer Operations
  listDirectory: (dirPath: string): Promise<IPCResult<import('../../shared/types').FileNode[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_LIST, dirPath),
  readFile: (filePath: string): Promise<IPCResult<string>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_READ, filePath),
  readImageFile: (filePath: string): Promise<IPCResult<{ dataUrl: string; mimeType: string; size: number }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_READ_IMAGE, filePath),
  writeFile: (filePath: string, content: string): Promise<IPCResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_WRITE, filePath, content),
  getFileDiff: (projectPath: string, filePath: string): Promise<IPCResult<string>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_DIFF, projectPath, filePath),
  getChangedFiles: (projectPath: string): Promise<IPCResult<string[]>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_CHANGED_FILES, projectPath),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  showItemInFolder: (filePath: string): Promise<IPCResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_SHOW_ITEM_IN_FOLDER, filePath),
  watchProjectFiles: (projectPath: string): Promise<IPCResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_WATCH_PROJECT, projectPath),
  unwatchProjectFiles: (projectPath: string): Promise<IPCResult<void>> =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_EXPLORER_UNWATCH_PROJECT, projectPath),
  onProjectFilesChanged: (callback: (event: FileExplorerChangeEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: FileExplorerChangeEvent): void => {
      callback(event);
    };
    ipcRenderer.on(IPC_CHANNELS.FILE_EXPLORER_PROJECT_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FILE_EXPLORER_PROJECT_CHANGED, handler);
  }
});
