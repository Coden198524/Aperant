import i18n from '../../../shared/i18n';
import type { ChangelogTask, ChangelogSourceMode, GitCommit } from '../../../shared/types';

export interface SummaryInfo {
  count: number;
  labelKey: 'task' | 'commit' | 'item';
  details: string;
}

function formatSummaryDetails(items: string[], remainingCount: number): string {
  const separator = i18n.t('changelog:summary.separator', { defaultValue: ', ' });
  const summary = items.join(separator);

  if (remainingCount <= 0) {
    return summary;
  }

  const moreLabel = i18n.t('changelog:summary.more', {
    count: remainingCount,
    defaultValue: '+{{count}} more'
  });

  return summary ? `${summary}${separator}${moreLabel}` : moreLabel;
}

export function getSummaryInfo(
  sourceMode: ChangelogSourceMode,
  selectedTaskIds: string[],
  selectedTasks: ChangelogTask[],
  previewCommits: GitCommit[]
): SummaryInfo {
  switch (sourceMode) {
    case 'tasks':
      return {
        count: selectedTaskIds.length,
        labelKey: 'task',
        details: formatSummaryDetails(
          selectedTasks.slice(0, 3).map((t) => t.title),
          selectedTasks.length - 3
        )
      };
    case 'git-history':
    case 'branch-diff':
      return {
        count: previewCommits.length,
        labelKey: 'commit',
        details: formatSummaryDetails(
          previewCommits.slice(0, 3).map((c) => c.subject.substring(0, 40)),
          previewCommits.length - 3
        )
      };
    default:
      return { count: 0, labelKey: 'item', details: '' };
  }
}

export function formatVersionTag(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

export function getVersionBumpDescription(versionReason: string | null): string | null {
  if (!versionReason) return null;

  switch (versionReason) {
    case 'breaking':
      return i18n.t('changelog:versionBump.breaking');
    case 'feature':
      return i18n.t('changelog:versionBump.feature');
    default:
      return i18n.t('changelog:versionBump.default');
  }
}
