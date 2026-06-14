/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ElectronApiMock = Record<string, ReturnType<typeof vi.fn>>;

function installElectronApiMock(): { api: ElectronApiMock; unsubs: ReturnType<typeof vi.fn>[] } {
  const unsubs: ReturnType<typeof vi.fn>[] = [];
  const createListener = () => vi.fn(() => {
    const unsub = vi.fn();
    unsubs.push(unsub);
    return unsub;
  });

  const api: ElectronApiMock = {
    getIdeation: vi.fn(async () => ({ success: true, data: null })),
    isIdeationRunning: vi.fn(async () => ({ success: true, data: { isRunning: false } })),
    onIdeationProgress: createListener(),
    onIdeationLog: createListener(),
    onIdeationTypeComplete: createListener(),
    onIdeationTypeFailed: createListener(),
    onIdeationComplete: createListener(),
    onIdeationError: createListener(),
    onIdeationStopped: createListener(),
  };

  Object.defineProperty(window, 'electronAPI', {
    value: api,
    configurable: true,
  });

  return { api, unsubs };
}

describe('ideation-store listeners', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('keeps IPC listeners alive across ideation page unmounts', async () => {
    const { api, unsubs } = installElectronApiMock();
    const { setupIdeationListeners } = await import('../ideation-store');

    const cleanupFirstMount = setupIdeationListeners();
    const cleanupSecondMount = setupIdeationListeners();

    expect(api.onIdeationProgress).toHaveBeenCalledTimes(1);
    expect(api.onIdeationLog).toHaveBeenCalledTimes(1);
    expect(api.onIdeationTypeComplete).toHaveBeenCalledTimes(1);
    expect(api.onIdeationTypeFailed).toHaveBeenCalledTimes(1);
    expect(api.onIdeationComplete).toHaveBeenCalledTimes(1);
    expect(api.onIdeationError).toHaveBeenCalledTimes(1);
    expect(api.onIdeationStopped).toHaveBeenCalledTimes(1);

    cleanupFirstMount();
    cleanupSecondMount();

    expect(unsubs.every((unsub) => unsub.mock.calls.length === 0)).toBe(true);
  });

  it('localizes known ideation log messages for Simplified Chinese', async () => {
    installElectronApiMock();
    const { translateIdeationLogMessage } = await import('../ideation-store');

    expect(translateIdeationLogMessage('Starting ideation generation in parallel...', 'zh-CN'))
      .toBe('开始并行生成创意...');
    expect(translateIdeationLogMessage('Starting code_improvements...', 'zh-CN'))
      .toBe('开始生成代码改进创意...');
    expect(translateIdeationLogMessage('code_improvements completed with 5 ideas', 'zh-CN'))
      .toBe('代码改进已生成 5 条创意');
  });

  it('restores the generating state from the main process when re-entering the page', async () => {
    const { api } = installElectronApiMock();
    api.isIdeationRunning.mockResolvedValueOnce({ success: true, data: { isRunning: true } });

    const { loadIdeation, useIdeationStore } = await import('../ideation-store');

    await loadIdeation('project-1');

    const state = useIdeationStore.getState();
    expect(api.isIdeationRunning).toHaveBeenCalledWith('project-1');
    expect(state.currentProjectId).toBe('project-1');
    expect(state.isGenerating).toBe(true);
    expect(state.generationStatus.phase).toBe('generating');
  });
});
