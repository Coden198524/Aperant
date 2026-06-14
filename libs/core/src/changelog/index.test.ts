import { describe, expect, it } from 'vitest';

import {
  AUTOCODE_CHANGELOG_MAX_COMMITS,
  AUTOCODE_CHANGELOG_MAX_TASKS,
  AUTOCODE_VERSION_BUMP_MAX_COMMITS,
  buildAutocodeChangelogPrompt,
  buildAutocodeGitChangelogPrompt,
  buildAutocodeVersionBumpPrompt,
  type AutocodeChangelogGenerationRequest,
  type AutocodeGitCommit,
} from './index.js';

function baseRequest(overrides: Partial<AutocodeChangelogGenerationRequest> = {}): AutocodeChangelogGenerationRequest {
  return {
    projectId: 'project-1',
    sourceMode: 'tasks',
    version: '1.2.3',
    date: '2026-06-14',
    format: 'keep-a-changelog',
    audience: 'user-facing',
    emojiLevel: 'none',
    ...overrides,
  };
}

function makeCommit(index: number, subject = `feat: change ${index}`): AutocodeGitCommit {
  return {
    hash: `abc${index}`,
    fullHash: `abcdef${index}`,
    subject,
    author: 'Contributor',
    authorEmail: 'contributor@example.com',
    date: '2026-06-14',
  };
}

describe('changelog prompt budgets', () => {
  it('caps completed task summaries for changelog generation', () => {
    const specs = Array.from({ length: AUTOCODE_CHANGELOG_MAX_TASKS + 3 }, (_, index) => ({
      taskId: `task-${index + 1}`,
      specId: `spec-${index + 1}`,
      spec: `# Feature ${index + 1}\n\n## Overview\n\n${'Detailed overview. '.repeat(40)}`,
    }));

    const prompt = buildAutocodeChangelogPrompt(baseRequest(), specs);

    expect(prompt).toContain(`spec-${AUTOCODE_CHANGELOG_MAX_TASKS}`);
    expect(prompt).not.toContain(`spec-${AUTOCODE_CHANGELOG_MAX_TASKS + 1}`);
    expect(prompt).toContain('3 additional completed tasks omitted');
    expect(prompt).toContain('truncated');
  });

  it('caps git commit summaries for changelog generation', () => {
    const commits = Array.from({ length: AUTOCODE_CHANGELOG_MAX_COMMITS + 4 }, (_, index) => makeCommit(index + 1));

    const prompt = buildAutocodeGitChangelogPrompt(
      baseRequest({ sourceMode: 'git-history' }),
      commits,
    );

    expect(prompt).toContain(`abc${AUTOCODE_CHANGELOG_MAX_COMMITS}`);
    expect(prompt).not.toContain(`abc${AUTOCODE_CHANGELOG_MAX_COMMITS + 1}`);
    expect(prompt).toContain('4 additional commits omitted');
  });

  it('prioritizes breaking changes when version-bump prompt is capped', () => {
    const commits = Array.from({ length: AUTOCODE_VERSION_BUMP_MAX_COMMITS + 20 }, (_, index) => makeCommit(index + 1));
    commits[commits.length - 1] = makeCommit(999, 'feat!: remove legacy auth mode');

    const prompt = buildAutocodeVersionBumpPrompt(commits, '1.2.3');

    expect(prompt).toContain('feat!: remove legacy auth mode');
    expect(prompt).toContain(`${commits.length - AUTOCODE_VERSION_BUMP_MAX_COMMITS} additional commits omitted`);
    expect(prompt).not.toContain(`abc${AUTOCODE_VERSION_BUMP_MAX_COMMITS + 20}`);
  });
});
