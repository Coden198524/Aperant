/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { createElement, StrictMode, type PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InsightsPendingDocumentReference } from '../../../../shared/types';
import { useInsightsDocumentReferences } from '../useInsightsDocumentReferences';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function authorizedFile(filename: string, filePath: string, token: string) {
  return {
    success: true as const,
    data: {
      filename,
      path: filePath,
      size: 1,
      authorizationToken: token,
    },
  };
}

describe('useInsightsDocumentReferences', () => {
  const onReferencesChange = vi.fn<(references: InsightsPendingDocumentReference[]) => void>();
  const onError = vi.fn<(error: string | null) => void>();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores only the authorized native path for a very large file', async () => {
    const file = new File(['tiny fixture'], 'huge.log', { type: 'text/plain' });
    Object.defineProperty(file, 'size', { configurable: true, value: 8 * 1024 ** 3 });
    if (typeof file.text !== 'function') {
      Object.defineProperty(file, 'text', {
        configurable: true,
        value: vi.fn(async () => 'must not be read'),
      });
    }
    if (typeof file.arrayBuffer !== 'function') {
      Object.defineProperty(file, 'arrayBuffer', {
        configurable: true,
        value: vi.fn(async () => new ArrayBuffer(0)),
      });
    }
    const textSpy = vi.spyOn(file, 'text');
    const arrayBufferSpy = vi.spyOn(file, 'arrayBuffer');
    const authorizeFile = vi.fn(async () => ({
      success: true as const,
      data: {
        filename: 'huge.log',
        path: 'E:\\Logs\\huge.log',
        size: 8 * 1024 ** 3,
        authorizationToken: 'opaque-token',
      },
    }));
    const { result } = renderHook(() => useInsightsDocumentReferences({
      projectId: 'project-1',
      references: [],
      onReferencesChange,
      onError,
      authorizeFile,
    }));

    await act(async () => result.current.processFiles([file]));

    expect(authorizeFile).toHaveBeenCalledWith('project-1', file);
    expect(onReferencesChange).toHaveBeenCalledWith([
      expect.objectContaining({
        filename: 'huge.log',
        path: 'E:\\Logs\\huge.log',
        size: 8 * 1024 ** 3,
        authorizationToken: 'opaque-token',
      }),
    ]);
    expect(onReferencesChange.mock.calls[0][0][0]).not.toHaveProperty('content');
    expect(onReferencesChange.mock.calls[0][0][0]).not.toHaveProperty('data');
    expect(textSpy).not.toHaveBeenCalled();
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it('adds an internal project file-reference path without reading it', () => {
    const { result } = renderHook(() => useInsightsDocumentReferences({
      projectId: 'project-1',
      references: [],
      onReferencesChange,
      onError,
    }));

    act(() => result.current.addReferences([{
      path: 'E:\\Project\\src\\main.ts',
      filename: 'main.ts',
    }]));

    expect(onReferencesChange).toHaveBeenCalledWith([
      expect.objectContaining({ path: 'E:\\Project\\src\\main.ts', filename: 'main.ts' }),
    ]);
  });

  it('reports unresolved paths and unsupported directories', async () => {
    const file = new File(['x'], 'missing.txt');
    const { result } = renderHook(() => useInsightsDocumentReferences({
      projectId: 'project-1',
      references: [],
      onReferencesChange,
      onError,
      authorizeFile: async () => ({ success: false, error: 'not authorized' }),
      errorMessages: {
        pathUnavailable: 'no-path',
        directoryUnsupported: 'no-folder',
      },
    }));

    await act(async () => result.current.processFiles([file]));
    expect(onError).toHaveBeenLastCalledWith('no-path');
    expect(onReferencesChange).not.toHaveBeenCalled();

    act(() => result.current.addReferences([{
      path: 'E:\\Project\\folder',
      filename: 'folder',
      isDirectory: true,
    }]));
    expect(onError).toHaveBeenLastCalledWith('no-folder');
  });

  it('maps the main-process non-regular-file failure to the folder error', async () => {
    const file = new File([], 'folder');
    const { result } = renderHook(() => useInsightsDocumentReferences({
      projectId: 'project-1',
      references: [],
      onReferencesChange,
      onError,
      authorizeFile: async () => ({
        success: false,
        error: 'The selected local file is unavailable or is not a regular file.',
      }),
      errorMessages: {
        pathUnavailable: 'no-path',
        directoryUnsupported: 'no-folder',
      },
    }));

    await act(async () => result.current.processFiles([file]));

    expect(onError).toHaveBeenLastCalledWith('no-folder');
    expect(onReferencesChange).not.toHaveBeenCalled();
  });

  it('removes a reference by id', () => {
    const references: InsightsPendingDocumentReference[] = [{
      id: 'keep',
      filename: 'keep.md',
      path: 'E:\\Project\\keep.md',
    }, {
      id: 'remove',
      filename: 'remove.md',
      path: 'E:\\Project\\remove.md',
    }];
    const { result } = renderHook(() => useInsightsDocumentReferences({
      projectId: 'project-1',
      references,
      onReferencesChange,
      onError,
    }));

    act(() => result.current.removeReference('remove'));
    expect(onReferencesChange).toHaveBeenCalledWith([references[0]]);
  });

  it('authorizes enough candidates to skip existing paths before applying the remaining limit', async () => {
    const references: InsightsPendingDocumentReference[] = Array.from(
      { length: 19 },
      (_, index) => ({
        id: `existing-${index}`,
        filename: `existing-${index}.md`,
        path: `E:\\Project\\existing-${index}.md`,
      }),
    );
    const duplicateAuthorization = deferred<ReturnType<typeof authorizedFile>>();
    const newAuthorization = deferred<ReturnType<typeof authorizedFile>>();
    const authorizeFile = vi.fn()
      .mockReturnValueOnce(duplicateAuthorization.promise)
      .mockReturnValueOnce(newAuthorization.promise);
    const { result } = renderHook(() => useInsightsDocumentReferences({
      projectId: 'project-1',
      references,
      onReferencesChange,
      onError,
      authorizeFile,
    }));
    const files = [new File(['a'], 'a.md'), new File(['b'], 'b.md')];
    let processing!: Promise<void>;

    act(() => {
      processing = result.current.processFiles(files);
    });
    expect(result.current.isProcessing).toBe(true);
    expect(authorizeFile).toHaveBeenCalledTimes(2);

    await act(async () => {
      duplicateAuthorization.resolve(authorizedFile(
        'existing-0.md',
        references[0].path,
        'duplicate-token',
      ));
      newAuthorization.resolve(authorizedFile(
        'b.md',
        'E:\\External\\b.md',
        'token-b',
      ));
      await processing;
    });

    expect(result.current.isProcessing).toBe(false);
    expect(onError).toHaveBeenLastCalledWith(null);
    expect(onReferencesChange.mock.calls.at(-1)?.[0]).toHaveLength(20);
    expect(onReferencesChange.mock.calls.at(-1)?.[0].at(-1)?.path).toBe('E:\\External\\b.md');
  });

  it('does not report the limit when a duplicate follows the final available reference', () => {
    const references: InsightsPendingDocumentReference[] = Array.from(
      { length: 19 },
      (_, index) => ({
        id: `existing-${index}`,
        filename: `existing-${index}.md`,
        path: `E:\\Project\\existing-${index}.md`,
      }),
    );
    const { result } = renderHook(() => useInsightsDocumentReferences({
      projectId: 'project-1',
      references,
      onReferencesChange,
      onError,
    }));

    act(() => result.current.addReferences([{
      path: 'E:\\Project\\new.md',
    }, {
      path: references[0].path,
    }]));

    expect(onReferencesChange.mock.calls.at(-1)?.[0]).toHaveLength(20);
    expect(onError).toHaveBeenLastCalledWith(null);
  });

  it('discards an authorization that resolves after the chat scope changes', async () => {
    const authorization = deferred<ReturnType<typeof authorizedFile>>();
    const { result, rerender } = renderHook(
      ({ scopeKey }) => useInsightsDocumentReferences({
        projectId: 'project-1',
        scopeKey,
        references: [],
        onReferencesChange,
        onError,
        authorizeFile: () => authorization.promise,
      }),
      { initialProps: { scopeKey: 'session-a' } },
    );

    let processing!: Promise<void>;
    act(() => {
      processing = result.current.processFiles([new File(['x'], 'old-session.log')]);
    });
    rerender({ scopeKey: 'session-b' });
    expect(onReferencesChange).toHaveBeenLastCalledWith([]);
    await act(async () => {
      authorization.resolve(authorizedFile(
        'old-session.log',
        'E:\\Logs\\old-session.log',
        'old-token',
      ));
      await processing;
    });

    expect(onReferencesChange).toHaveBeenCalledTimes(1);
    expect(result.current.isProcessing).toBe(false);
  });

  it('clears pending references when the active chat scope changes', () => {
    const pending: InsightsPendingDocumentReference = {
      id: 'pending',
      filename: 'pending.md',
      path: 'E:\\Project\\pending.md',
    };
    const { rerender } = renderHook(
      ({ projectId, scopeKey, references }) => useInsightsDocumentReferences({
        projectId,
        scopeKey,
        references,
        onReferencesChange,
        onError,
      }),
      {
        initialProps: {
          projectId: 'project-1',
          scopeKey: 'session-a',
          references: [pending],
        },
      },
    );

    rerender({
      projectId: 'project-1',
      scopeKey: 'session-b',
      references: [pending],
    });

    expect(onReferencesChange).toHaveBeenCalledTimes(1);
    expect(onReferencesChange).toHaveBeenCalledWith([]);
  });

  it('continues accepting authorizations after the StrictMode effect replay', async () => {
    const file = new File(['x'], 'strict.log');
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      StrictMode,
      null,
      children,
    );
    const { result } = renderHook(() => useInsightsDocumentReferences({
      projectId: 'project-1',
      scopeKey: 'session-a',
      references: [],
      onReferencesChange,
      onError,
      authorizeFile: async () => authorizedFile(
        'strict.log',
        'E:\\Logs\\strict.log',
        'strict-token',
      ),
    }), { wrapper });

    await act(async () => result.current.processFiles([file]));

    expect(onReferencesChange).toHaveBeenCalledWith([
      expect.objectContaining({ path: 'E:\\Logs\\strict.log' }),
    ]);
  });

  it('merges an authorization into the latest references after a removal', async () => {
    const authorization = deferred<ReturnType<typeof authorizedFile>>();
    const keep: InsightsPendingDocumentReference = {
      id: 'keep',
      filename: 'keep.md',
      path: 'E:\\Project\\keep.md',
    };
    const remove: InsightsPendingDocumentReference = {
      id: 'remove',
      filename: 'remove.md',
      path: 'E:\\Project\\remove.md',
    };
    const { result } = renderHook(() => useInsightsDocumentReferences({
      projectId: 'project-1',
      scopeKey: 'session-a',
      references: [keep, remove],
      onReferencesChange,
      onError,
      authorizeFile: () => authorization.promise,
    }));

    let processing!: Promise<void>;
    act(() => {
      processing = result.current.processFiles([new File(['x'], 'new.log')]);
      result.current.removeReference('remove');
    });
    await act(async () => {
      authorization.resolve(authorizedFile('new.log', 'E:\\Logs\\new.log', 'new-token'));
      await processing;
    });

    expect(onReferencesChange.mock.calls.at(-1)?.[0].map((reference) => reference.path)).toEqual([
      keep.path,
      'E:\\Logs\\new.log',
    ]);
  });

  it('merges concurrent authorizations without overwriting either result', async () => {
    const first = deferred<ReturnType<typeof authorizedFile>>();
    const second = deferred<ReturnType<typeof authorizedFile>>();
    const authorizeFile = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useInsightsDocumentReferences({
      projectId: 'project-1',
      scopeKey: 'session-a',
      references: [],
      onReferencesChange,
      onError,
      authorizeFile,
    }));

    let firstProcessing!: Promise<void>;
    let secondProcessing!: Promise<void>;
    act(() => {
      firstProcessing = result.current.processFiles([new File(['1'], 'first.log')]);
      secondProcessing = result.current.processFiles([new File(['2'], 'second.log')]);
    });
    await act(async () => {
      second.resolve(authorizedFile('second.log', 'E:\\Logs\\second.log', 'second-token'));
      await secondProcessing;
    });
    expect(result.current.isProcessing).toBe(true);

    await act(async () => {
      first.resolve(authorizedFile('first.log', 'E:\\Logs\\first.log', 'first-token'));
      await firstProcessing;
    });

    expect(onReferencesChange.mock.calls.at(-1)?.[0].map((reference) => reference.path)).toEqual([
      'E:\\Logs\\second.log',
      'E:\\Logs\\first.log',
    ]);
    expect(result.current.isProcessing).toBe(false);
  });
});
