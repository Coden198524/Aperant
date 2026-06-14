/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SecurityHardeningIdea } from '../../../shared/types';
import { IdeaDetailPanel } from './IdeaDetailPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      const labels: Record<string, string> = {
        'common:ideation.description': '描述',
        'common:ideation.rationale': '理由',
        'common:ideation.convertToTask': '转为 Auto-Build 任务',
        'common:ideation.dismissIdea': '忽略创意',
        'common:ideation.goToTask': '进入任务',
      };
      return labels[key] ?? options?.defaultValue ?? key;
    },
  }),
}));

const convertedArchivedIdea: SecurityHardeningIdea = {
  id: 'idea-1',
  type: 'security_hardening',
  title: '加固命令执行',
  description: '限制命令模板。',
  rationale: '降低注入风险。',
  status: 'archived',
  createdAt: new Date('2026-06-14T00:00:00.000Z'),
  taskId: '012-harden-command-execution',
  category: 'input_validation',
  severity: 'high',
  affectedFiles: ['src/runtime/agentCommandBuilder.ts'],
  vulnerability: 'Shell injection',
  currentRisk: 'Untrusted input can reach shell execution.',
  remediation: 'Validate command templates before execution.',
};

describe('IdeaDetailPanel', () => {
  it('shows the linked task action for archived converted ideas', () => {
    render(
      <IdeaDetailPanel
        idea={convertedArchivedIdea}
        onClose={vi.fn()}
        onConvert={vi.fn()}
        onDismiss={vi.fn()}
        onGoToTask={vi.fn()}
      />
    );

    expect(screen.getByText('进入任务')).toBeTruthy();
    expect(screen.queryByText('转为 Auto-Build 任务')).toBeNull();
    expect(screen.queryByText('忽略创意')).toBeNull();
  });
});
