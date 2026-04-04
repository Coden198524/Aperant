import {
  Code2,
  AlertTriangle,
  AlertCircle,
  TrendingUp,
  FileCode,
  BookOpen,
  Clock
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../ui/badge';
import { Card } from '../../ui/card';
import {
  CODE_QUALITY_SEVERITY_COLORS,
  IDEATION_EFFORT_COLORS
} from '../../../../shared/constants';
import type { CodeQualityIdea } from '../../../../shared/types';
import {
  getCodeQualityCategoryLabel,
  getCodeQualitySeverityLabel,
  getIdeationEffortLabel
} from '../../../lib/i18n-labels';

interface CodeQualityDetailsProps {
  idea: CodeQualityIdea;
}

export function CodeQualityDetails({ idea }: CodeQualityDetailsProps) {
  const { t } = useTranslation('common');

  return (
    <>
      {/* Metrics */}
      <div className="grid grid-cols-2 gap-2">
        <Card className="p-3 text-center">
          <div className={`text-lg font-semibold ${CODE_QUALITY_SEVERITY_COLORS[idea.severity]}`}>
            {getCodeQualitySeverityLabel(t, idea.severity)}
          </div>
          <div className="text-xs text-muted-foreground">{t('ideation.detail.severity', { defaultValue: 'Severity' })}</div>
        </Card>
        <Card className="p-3 text-center">
          <div className={`text-lg font-semibold ${IDEATION_EFFORT_COLORS[idea.estimatedEffort]}`}>
            {getIdeationEffortLabel(t, idea.estimatedEffort)}
          </div>
          <div className="text-xs text-muted-foreground">{t('ideation.detail.effort', { defaultValue: 'Effort' })}</div>
        </Card>
      </div>

      {/* Category */}
      <div>
        <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
          <Code2 className="h-4 w-4" />
          {t('ideation.detail.category', { defaultValue: 'Category' })}
        </h3>
        <Badge variant="outline">
          {getCodeQualityCategoryLabel(t, idea.category)}
        </Badge>
      </div>

      {/* Breaking Change Warning */}
      {idea.breakingChange && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <span className="text-sm font-medium text-destructive">
              {t('ideation.detail.breakingChange', { defaultValue: 'Breaking Change' })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {t('ideation.detail.breakingChangeDescription', {
              defaultValue: 'This refactoring may break existing code or tests.'
            })}
          </p>
        </div>
      )}

      {/* Current State */}
      <div>
        <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {t('ideation.detail.currentState', { defaultValue: 'Current State' })}
        </h3>
        <p className="text-sm text-muted-foreground">{idea.currentState}</p>
      </div>

      {/* Proposed Change */}
      <div>
        <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-success" />
          {t('ideation.detail.proposedChange', { defaultValue: 'Proposed Change' })}
        </h3>
        <p className="text-sm text-muted-foreground whitespace-pre-line">{idea.proposedChange}</p>
      </div>

      {/* Code Example */}
      {idea.codeExample && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <FileCode className="h-4 w-4" />
            {t('ideation.detail.codeExample', { defaultValue: 'Code Example' })}
          </h3>
          <pre className="text-xs font-mono bg-muted/50 p-3 rounded-lg overflow-x-auto">
            {idea.codeExample}
          </pre>
        </div>
      )}

      {/* Metrics (if available) */}
      {idea.metrics && (
        <div>
          <h3 className="text-sm font-medium mb-2">{t('ideation.detail.metrics', { defaultValue: 'Metrics' })}</h3>
          <div className="grid grid-cols-2 gap-2">
            {idea.metrics.lineCount && (
              <Card className="p-2 text-center">
                <div className="text-sm font-semibold">{idea.metrics.lineCount}</div>
                <div className="text-xs text-muted-foreground">{t('ideation.detail.lines', { defaultValue: 'Lines' })}</div>
              </Card>
            )}
            {idea.metrics.complexity && (
              <Card className="p-2 text-center">
                <div className="text-sm font-semibold">{idea.metrics.complexity}</div>
                <div className="text-xs text-muted-foreground">{t('ideation.detail.complexity', { defaultValue: 'Complexity' })}</div>
              </Card>
            )}
            {idea.metrics.duplicateLines && (
              <Card className="p-2 text-center">
                <div className="text-sm font-semibold">{idea.metrics.duplicateLines}</div>
                <div className="text-xs text-muted-foreground">{t('ideation.detail.duplicateLines', { defaultValue: 'Duplicate Lines' })}</div>
              </Card>
            )}
            {idea.metrics.testCoverage !== undefined && (
              <Card className="p-2 text-center">
                <div className="text-sm font-semibold">{idea.metrics.testCoverage}%</div>
                <div className="text-xs text-muted-foreground">{t('ideation.detail.testCoverage', { defaultValue: 'Test Coverage' })}</div>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* Affected Files */}
      {idea.affectedFiles && idea.affectedFiles.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <FileCode className="h-4 w-4" />
            {t('ideation.detail.affectedFiles', { defaultValue: 'Affected Files' })}
          </h3>
          <ul className="space-y-1">
            {idea.affectedFiles.map((file, i) => (
              <li key={i} className="text-sm font-mono text-muted-foreground">
                {file}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Best Practice */}
      {idea.bestPractice && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <BookOpen className="h-4 w-4" />
            {t('ideation.detail.bestPractice', { defaultValue: 'Best Practice' })}
          </h3>
          <p className="text-sm text-muted-foreground">{idea.bestPractice}</p>
        </div>
      )}

      {/* Prerequisites */}
      {idea.prerequisites && idea.prerequisites.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
            <Clock className="h-4 w-4" />
            {t('ideation.detail.prerequisites', { defaultValue: 'Prerequisites' })}
          </h3>
          <ul className="space-y-1">
            {idea.prerequisites.map((prereq, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-muted-foreground">•</span>
                {prereq}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
