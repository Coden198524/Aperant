/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import '../../../../shared/i18n';
import { DiffViewDialog } from './DiffViewDialog';
import type { WorktreeDiff } from '../../../../shared/types';

describe('DiffViewDialog', () => {
  const worktreeDiff: WorktreeDiff = {
    summary: '1 files changed, 2 insertions(+), 1 deletions(-)',
    files: [
      {
        path: 'src/example.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch: [
          'diff --git a/src/example.ts b/src/example.ts',
          'index 123..456 100644',
          '--- a/src/example.ts',
          '+++ b/src/example.ts',
          '@@ -1,2 +1,3 @@',
          '-const oldValue = 1;',
          '+const newValue = 2;',
          '+const anotherValue = 3;',
        ].join('\n'),
      },
    ],
  };

  it('renders inline patch content for changed files', () => {
    render(
      <DiffViewDialog
        open={true}
        worktreeDiff={worktreeDiff}
        isLoadingDiff={false}
        onOpenChange={() => {}}
      />
    );

    expect(screen.getByRole('heading', { name: /changed files/i })).toBeInTheDocument();
    expect(screen.getByText('src/example.ts')).toBeInTheDocument();
    expect(screen.getByText('-const oldValue = 1;')).toBeInTheDocument();
    expect(screen.getByText('+const newValue = 2;')).toBeInTheDocument();
  });
});
