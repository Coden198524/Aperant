/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Roadmap } from '../../Roadmap';
import { TooltipProvider } from '../../ui/tooltip';
import { useRoadmapStore } from '../../../stores/roadmap-store';
import type { Roadmap as RoadmapData } from '../../../../shared/types';

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (_key: string, fallbackOrParams?: string | Record<string, unknown>) => {
      if (typeof fallbackOrParams === 'string') return fallbackOrParams;
      if (typeof fallbackOrParams?.defaultValue === 'string') return fallbackOrParams.defaultValue;
      return _key;
    },
    i18n: {
      language: 'zh-CN',
    },
  }),
}));

vi.mock('../../AddCompetitorDialog', () => ({
  AddCompetitorDialog: () => null,
}));

vi.mock('../../CompetitorAnalysisViewer', () => ({
  CompetitorAnalysisViewer: () => null,
}));

describe('Roadmap generation dialog', () => {
  const projectId = 'project-1';
  const generateRoadmapMock = vi.fn();
  const refreshRoadmapMock = vi.fn();

  const existingRoadmap: RoadmapData = {
    id: 'roadmap-1',
    projectId,
    projectName: 'Test Project',
    version: '1.0',
    vision: 'Make a useful app',
    targetAudience: {
      primary: 'Developers',
      secondary: [],
    },
    phases: [
      {
        id: 'phase-1',
        name: 'Phase 1',
        description: 'First phase',
        order: 1,
        status: 'planned',
        features: [],
        milestones: [],
      },
    ],
    features: [],
    status: 'draft',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

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
      getRoadmapStatus: vi.fn().mockResolvedValue({ success: true, data: { isRunning: false } }),
      getRoadmap: vi.fn().mockResolvedValue({ success: true, data: null }),
      generateRoadmap: generateRoadmapMock,
      refreshRoadmap: refreshRoadmapMock,
      onRoadmapProgress: vi.fn(() => vi.fn()),
      onRoadmapComplete: vi.fn(() => vi.fn()),
      onRoadmapError: vi.fn(() => vi.fn()),
      onRoadmapStopped: vi.fn(() => vi.fn()),
    });
  });

  it('starts generation after clicking enable analysis in the dialog', async () => {
    render(
      <TooltipProvider>
        <Roadmap projectId={projectId} />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Generate Roadmap' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, Enable Analysis' }));

    await waitFor(() => {
      expect(generateRoadmapMock).toHaveBeenCalledWith(projectId, true, undefined);
    });

    expect(screen.getByText('Starting roadmap generation...')).toBeInTheDocument();
  });

  it('shows generation progress before the backend start call resolves', async () => {
    let resolveStart: ((value: { success: true }) => void) | undefined;
    generateRoadmapMock.mockReturnValue(new Promise((resolve) => {
      resolveStart = resolve;
    }));

    render(
      <TooltipProvider>
        <Roadmap projectId={projectId} />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Generate Roadmap' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, Enable Analysis' }));

    expect(await screen.findByText('Starting roadmap generation...')).toBeInTheDocument();

    await waitFor(() => {
      expect(generateRoadmapMock).toHaveBeenCalledWith(projectId, true, undefined);
    });
    resolveStart?.({ success: true });
  });

  it('starts refresh after clicking enable analysis from an existing roadmap', async () => {
    useRoadmapStore.setState({
      roadmap: existingRoadmap,
      competitorAnalysis: null,
      currentProjectId: projectId,
      generationStatus: {
        phase: 'idle',
        progress: 0,
        message: '',
      },
    });

    Object.assign(window.electronAPI, {
      getRoadmap: vi.fn().mockResolvedValue({ success: true, data: existingRoadmap }),
    });

    render(
      <TooltipProvider>
        <Roadmap projectId={projectId} />
      </TooltipProvider>
    );

    fireEvent.click(screen.getByLabelText('accessibility.regenerateRoadmapAriaLabel'));
    fireEvent.click(await screen.findByRole('button', { name: 'Yes, Enable Analysis' }));

    await waitFor(() => {
      expect(refreshRoadmapMock).toHaveBeenCalledWith(projectId, true, undefined);
    });

    expect(screen.getByText('Refreshing roadmap...')).toBeInTheDocument();
  });
});
