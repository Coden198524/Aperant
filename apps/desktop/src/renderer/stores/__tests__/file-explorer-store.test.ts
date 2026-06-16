/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileExplorerStore } from '../file-explorer-store';
import type { FileNode } from '../../../shared/types';

const ROOT_PATH = '/project';
const SRC_PATH = `${ROOT_PATH}/src`;
const NESTED_PATH = `${SRC_PATH}/nested`;

function fileNode(path: string, isDirectory = false): FileNode {
  return {
    path,
    name: path.split('/').pop() ?? path,
    isDirectory
  };
}

const listDirectory = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      listDirectory
    }
  });
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: {
      isWindows: false,
      isMacOS: false,
      isLinux: true,
      isUnix: true
    }
  });

  useFileExplorerStore.setState({
    isOpen: false,
    expandedFolders: new Set(),
    files: new Map(),
    isLoading: new Map(),
    error: null
  });
});

describe('useFileExplorerStore directory refresh', () => {
  it('returns cached directories for normal loads', async () => {
    const cachedFiles = [fileNode(`${ROOT_PATH}/old.ts`)];
    useFileExplorerStore.setState({
      files: new Map([[ROOT_PATH, cachedFiles]])
    });

    const result = await useFileExplorerStore.getState().loadDirectory(ROOT_PATH);

    expect(result).toBe(cachedFiles);
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it('forces a directory reload when refreshing', async () => {
    const cachedFiles = [fileNode(`${ROOT_PATH}/old.ts`)];
    const freshFiles = [fileNode(`${ROOT_PATH}/new.ts`)];
    listDirectory.mockResolvedValueOnce({ success: true, data: freshFiles });
    useFileExplorerStore.setState({
      files: new Map([[ROOT_PATH, cachedFiles]])
    });

    const result = await useFileExplorerStore.getState().refreshDirectory(ROOT_PATH);

    expect(listDirectory).toHaveBeenCalledWith(ROOT_PATH);
    expect(result).toBe(freshFiles);
    expect(useFileExplorerStore.getState().files.get(ROOT_PATH)).toBe(freshFiles);
  });

  it('invalidates removed directories and their descendants', () => {
    const rootFiles = [fileNode(SRC_PATH, true)];
    const srcFiles = [fileNode(NESTED_PATH, true)];
    const nestedFiles = [fileNode(`${NESTED_PATH}/file.ts`)];
    useFileExplorerStore.setState({
      files: new Map([
        [ROOT_PATH, rootFiles],
        [SRC_PATH, srcFiles],
        [NESTED_PATH, nestedFiles],
        [`${ROOT_PATH}/sibling`, []]
      ]),
      isLoading: new Map([
        [SRC_PATH, true],
        [NESTED_PATH, true]
      ]),
      expandedFolders: new Set([SRC_PATH, NESTED_PATH, `${ROOT_PATH}/sibling`])
    });

    useFileExplorerStore.getState().invalidateDirectories([SRC_PATH]);

    const state = useFileExplorerStore.getState();
    expect(state.files.has(ROOT_PATH)).toBe(true);
    expect(state.files.has(SRC_PATH)).toBe(false);
    expect(state.files.has(NESTED_PATH)).toBe(false);
    expect(state.files.has(`${ROOT_PATH}/sibling`)).toBe(true);
    expect(state.isLoading.has(SRC_PATH)).toBe(false);
    expect(state.isLoading.has(NESTED_PATH)).toBe(false);
    expect(state.expandedFolders.has(SRC_PATH)).toBe(false);
    expect(state.expandedFolders.has(NESTED_PATH)).toBe(false);
    expect(state.expandedFolders.has(`${ROOT_PATH}/sibling`)).toBe(true);
  });
});
