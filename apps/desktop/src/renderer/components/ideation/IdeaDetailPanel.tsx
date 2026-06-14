import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ExternalLink, Lightbulb, Loader2, Play, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import {
  IDEATION_TYPE_COLORS,
  IDEATION_STATUS_COLORS
} from '../../../shared/constants';
import type { Idea } from '../../../shared/types';
import { TypeIcon } from './TypeIcon';
import {
  isCodeImprovementIdea,
  isUIUXIdea,
  isDocumentationGapIdea,
  isSecurityHardeningIdea,
  isPerformanceOptimizationIdea,
  isCodeQualityIdea
} from './type-guards';
import { CodeImprovementDetails } from './details/CodeImprovementDetails';
import { UIUXDetails } from './details/UIUXDetails';
import { DocumentationGapDetails } from './details/DocumentationGapDetails';
import { SecurityHardeningDetails } from './details/SecurityHardeningDetails';
import { PerformanceOptimizationDetails } from './details/PerformanceOptimizationDetails';
import { CodeQualityDetails } from './details/CodeQualityDetails';
import { getIdeationStatusLabel, getIdeationTypeLabel } from '../../lib/i18n-labels';

interface IdeaDetailPanelProps {
  idea: Idea;
  onClose: () => void;
  onConvert: (idea: Idea) => void;
  onGoToTask?: (taskId: string) => void;
  onDismiss: (idea: Idea) => void;
  isConverting?: boolean;
}

const DETAIL_PANEL_WIDTH_STORAGE_KEY = 'ideation-detail-panel-width';
const DEFAULT_DETAIL_PANEL_WIDTH = 480;
const MIN_DETAIL_PANEL_WIDTH = 360;
const MAX_DETAIL_PANEL_WIDTH = 720;
const DETAIL_PANEL_SIDE_MARGIN = 56;

function getMaxDetailPanelWidth(): number {
  if (typeof window === 'undefined') {
    return MAX_DETAIL_PANEL_WIDTH;
  }

  return Math.max(
    MIN_DETAIL_PANEL_WIDTH,
    Math.min(MAX_DETAIL_PANEL_WIDTH, window.innerWidth - DETAIL_PANEL_SIDE_MARGIN)
  );
}

function clampDetailPanelWidth(width: number): number {
  return Math.max(MIN_DETAIL_PANEL_WIDTH, Math.min(width, getMaxDetailPanelWidth()));
}

function loadDetailPanelWidth(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_DETAIL_PANEL_WIDTH;
  }

  const saved = Number(localStorage.getItem(DETAIL_PANEL_WIDTH_STORAGE_KEY));
  if (Number.isFinite(saved) && saved > 0) {
    return clampDetailPanelWidth(saved);
  }

  return clampDetailPanelWidth(DEFAULT_DETAIL_PANEL_WIDTH);
}

export function IdeaDetailPanel({ idea, onClose, onConvert, onGoToTask, onDismiss, isConverting }: IdeaDetailPanelProps) {
  const { t } = useTranslation('common');
  const [panelWidth, setPanelWidth] = useState(loadDetailPanelWidth);
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const isDismissed = idea.status === 'dismissed';
  const isArchived = idea.status === 'archived';
  const isConverted = idea.status === 'converted' || (isArchived && Boolean(idea.taskId));
  const canActOnIdea = !isDismissed && !isArchived && !isConverted;

  useEffect(() => {
    const handleWindowResize = () => {
      setPanelWidth((width) => {
        const next = clampDetailPanelWidth(width);
        localStorage.setItem(DETAIL_PANEL_WIDTH_STORAGE_KEY, String(Math.round(next)));
        return next;
      });
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  useEffect(() => {
    return () => {
      resizeStateRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const handleResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    resizeStateRef.current = {
      startX: event.clientX,
      startWidth: panelWidth,
    };
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;

      setPanelWidth(clampDetailPanelWidth(resizeState.startWidth - (moveEvent.clientX - resizeState.startX)));
    };

    const handlePointerUp = () => {
      resizeStateRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setPanelWidth((width) => {
        const next = clampDetailPanelWidth(width);
        localStorage.setItem(DETAIL_PANEL_WIDTH_STORAGE_KEY, String(Math.round(next)));
        return next;
      });
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  };

  return (
    <div
      className="fixed inset-y-0 right-0 bg-card border-l border-border shadow-lg flex flex-col z-50"
      style={{ width: `${panelWidth}px`, maxWidth: `calc(100vw - ${DETAIL_PANEL_SIDE_MARGIN}px)` }}
    >
      <div
        className="absolute inset-y-0 -left-2 z-20 w-3 cursor-ew-resize touch-none transition-colors hover:bg-primary/20 active:bg-primary/25"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('common:accessibility.resizePanelAriaLabel', { defaultValue: '调整详情面板宽度' })}
        onPointerDown={handleResizeStart}
      />
      {/* Header */}
      <div className="shrink-0 p-4 border-b border-border electron-no-drag">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <Badge variant="outline" className={IDEATION_TYPE_COLORS[idea.type]}>
                <TypeIcon type={idea.type} />
                <span className="ml-1">{getIdeationTypeLabel(t, idea.type)}</span>
              </Badge>
              {idea.status !== 'draft' && (
                <Badge variant="outline" className={IDEATION_STATUS_COLORS[idea.status]}>
                  {getIdeationStatusLabel(t, idea.status)}
                </Badge>
              )}
            </div>
            <h2 className="font-semibold">{idea.title}</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t('accessibility.closePanelAriaLabel')}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {/* Description */}
        <div>
          <h3 className="text-sm font-medium mb-2">{t('common:ideation.description')}</h3>
          <p className="text-sm text-muted-foreground">{idea.description}</p>
        </div>

        {/* Rationale */}
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <Lightbulb className="h-4 w-4" />
            {t('common:ideation.rationale')}
          </h3>
          <p className="text-sm text-muted-foreground">{idea.rationale}</p>
        </div>

        {/* Type-specific content */}
        {isCodeImprovementIdea(idea) && <CodeImprovementDetails idea={idea} />}
        {isUIUXIdea(idea) && <UIUXDetails idea={idea} />}
        {isDocumentationGapIdea(idea) && <DocumentationGapDetails idea={idea} />}
        {isSecurityHardeningIdea(idea) && <SecurityHardeningDetails idea={idea} />}
        {isPerformanceOptimizationIdea(idea) && <PerformanceOptimizationDetails idea={idea} />}
        {isCodeQualityIdea(idea) && <CodeQualityDetails idea={idea} />}
      </div>

      {/* Actions */}
      {canActOnIdea && (
        <div className="shrink-0 p-4 border-t border-border space-y-2">
          <Button className="w-full" onClick={() => onConvert(idea)} disabled={isConverting}>
            {isConverting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            {isConverting ? t('common:ideation.converting') : t('common:ideation.convertToTask')}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              onDismiss(idea);
              onClose();
            }}
          >
            <X className="h-4 w-4 mr-2" />
            {t('common:ideation.dismissIdea')}
          </Button>
        </div>
      )}
      {isConverted && idea.taskId && onGoToTask && (
        <div className="shrink-0 p-4 border-t border-border">
          <Button className="w-full" onClick={() => onGoToTask(idea.taskId!)}>
            <ExternalLink className="h-4 w-4 mr-2" />
            {t('common:ideation.goToTask')}
          </Button>
        </div>
      )}
    </div>
  );
}
