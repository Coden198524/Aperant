/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoadmapGeneration } from '../hooks';
import { useRoadmapStore } from '../../../stores/roadmap-store';

describe('useRoadmapGeneration', () => {
  const projectId = 'project-1';
  const generateRoadmapMock = vi.fn();
  const refreshRoadmapMock = vi.fn();

  beforeEach(() => {
    useRoadmapStore.setState({
      roadmap: null,
      competitorAnalysis: null,
      currentProjectId: null,
      generationStatus: {
        phase: 'idle',
        progress: 0,
        message: '',
      },
    });

    generateRoadmapMock.mockResolvedValue({ success: true });
    refreshRoadmapMock.mockResolvedValue({ success: true });

    Object.assign(window.electronAPI, {
      generateRoadmap: generateRoadmapMock,
      refreshRoadmap: refreshRoadmapMock,
    });
  });

  it('starts roadmap generation when the enable analysis dialog action is clicked', async () => {
    const { result } = renderHook(() => useRoadmapGeneration(projectId));

    act(() => {
      result.current.handleGenerate();
    });

    expect(result.current.showCompetitorDialog).toBe(true);

    act(() => {
      result.current.handleCompetitorDialogAccept();
    });

    await waitFor(() => {
      expect(generateRoadmapMock).toHaveBeenCalledWith(projectId, true, undefined);
    });
  });

  it('starts roadmap refresh when the enable analysis dialog action is clicked after refresh', async () => {
    const { result } = renderHook(() => useRoadmapGeneration(projectId));

    act(() => {
      result.current.handleRefresh();
    });

    expect(result.current.showCompetitorDialog).toBe(true);

    act(() => {
      result.current.handleCompetitorDialogAccept();
    });

    await waitFor(() => {
      expect(refreshRoadmapMock).toHaveBeenCalledWith(projectId, true, undefined);
    });
  });
});
