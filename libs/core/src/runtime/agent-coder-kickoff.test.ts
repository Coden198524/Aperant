import { describe, expect, it } from 'vitest';

import {
  buildAutocodeFocusedCoderKickoffMessageFromContext,
  findAutocodeSubtaskKickoffContext,
} from './agent-coder-kickoff.js';

describe('agent coder kickoff prompt compaction', () => {
  it('folds repeated completed work summaries before coder kickoff prompts', () => {
    const repeatedLine = 'CODER_KICKOFF_REPEAT: same prior verification line without new signal.';
    const plan = {
      workflow_type: 'feature',
      phases: [
        {
          name: 'Implementation',
          subtasks: [
            {
              id: '1.1',
              title: 'Previous work',
              status: 'completed',
              completion_summary: [
                'CODER_KICKOFF_HEAD',
                ...Array.from({ length: 120 }, () => repeatedLine),
                'CODER_KICKOFF_TAIL',
              ].join('\n'),
            },
            {
              id: '1.2',
              title: 'Current work',
              description: 'Implement the current focused change.',
              status: 'pending',
              files_to_modify: ['src/auth/session.ts'],
            },
          ],
        },
      ],
    };

    const context = findAutocodeSubtaskKickoffContext(plan, '1.2');
    const message = buildAutocodeFocusedCoderKickoffMessageFromContext({
      specDir: 'E:/Work/Aperant/.autocode/specs/demo',
      projectDir: 'E:/Work/Aperant',
      subtaskId: '1.2',
      context,
    });

    expect(message).toContain('## Prior Completed Work In This Phase');
    expect(message).toContain('CODER_KICKOFF_HEAD');
    expect(message).toContain('CODER_KICKOFF_TAIL');
    expect(message).toContain('119 repeated line(s) omitted for prompt budget');
    expect((message.match(/CODER_KICKOFF_REPEAT/g) ?? [])).toHaveLength(1);
  });

  it('adds source-ledger and MMO architecture guidance for game documentation tasks', () => {
    const message = buildAutocodeFocusedCoderKickoffMessageFromContext({
      specDir: 'E:/Work/Aperant/.autocode/specs/mmo-docs',
      projectDir: 'E:/Work/Aperant',
      subtaskId: '1.1',
      context: {
        id: '1.1',
        workflowType: 'documentation',
        projectType: 'game-mmo',
        documentationProfile: 'game-mmo-source',
        documentationFocus: ['gameplay', 'client/engine', 'server authority', 'network sync'],
        title: 'Write MMO source documentation',
        description: 'Analyze MMO source architecture and generate Markdown docs.',
        filesToCreate: ['doc_outline.md', 'evidence_index.md', 'docs/mmo.md'],
        filesToModify: [],
        patternFiles: ['server/**/*', 'client/**/*', 'config/**/*'],
      },
    });

    expect(message).toContain('Do not rely on README/manifests alone');
    expect(message).toContain('claim-to-source ledger');
    expect(message).toContain('Source Evidence Appendix');
    expect(message).toContain('concrete source/config paths for each major system');
    expect(message).toContain('not found or uncovered');
    expect(message).toContain('system matrix with source entry points');
  });

  it('adds reader-first flow guidance for analysis documentation tasks', () => {
    const message = buildAutocodeFocusedCoderKickoffMessageFromContext({
      specDir: 'E:/Work/Aperant/.autocode/specs/login-analysis',
      projectDir: 'E:/Work/Aperant',
      subtaskId: '1.1',
      context: {
        id: '1.1',
        workflowType: 'analysis / documentation',
        title: '分析登录准入和排队流程',
        description: '生成 login_access_analysis.md，说明开服前禁止登录和人数过多排队流程。',
        filesToCreate: ['login_access_analysis.md'],
        filesToModify: [],
        patternFiles: ['server/auth/**/*login*', 'config/**/*'],
      },
    });

    expect(message).toContain('Documentation-only workflow');
    expect(message).toContain('Reader-first final document');
    expect(message).toContain('Conclusion Snapshot');
    expect(message).toContain('结论速览');
    expect(message).toContain('Main Flow');
    expect(message).toContain('主流程');
    expect(message).toContain('Source Evidence Appendix');
    expect(message).toContain('Move detailed startup checks, manual rehearsal forms');
    expect(message).toContain('Avoid mechanical top-level structures');
  });

  it('adds contract, regression, and summary requirements for coding tasks', () => {
    const message = buildAutocodeFocusedCoderKickoffMessageFromContext({
      specDir: 'E:/Work/Aperant/.autocode/specs/auth-fix',
      projectDir: 'E:/Work/Aperant',
      subtaskId: '2.1',
      context: {
        id: '2.1',
        workflowType: 'feature',
        title: 'Fix auth persistence',
        description: 'Fix auth session persistence.',
        filesToCreate: [],
        filesToModify: ['src/auth/session-store.ts'],
        patternFiles: ['src/auth/session-store.test.ts'],
      },
    });

    expect(message).toContain('Code quality: before editing, identify the touched implementation contract');
    expect(message).toContain('public APIs, schemas, IPC/protocol contracts');
    expect(message).toContain('placeholder code');
    expect(message).toContain('closest regression test');
    expect(message).toContain('Completion summary must name concrete changed files/contracts');
    expect(message).toContain('actual launch/open/use-path smoke check');
    expect(message).toContain('failed or unavailable startup/use-path check blocks completion');
    expect(message).toContain('Do not call update_subtask_status with status completed for user-facing or runnable work');
  });

  it('does not classify mixed code and documentation tasks as documentation-only', () => {
    const message = buildAutocodeFocusedCoderKickoffMessageFromContext({
      specDir: 'E:/Work/Aperant/.autocode/specs/mixed-task',
      projectDir: 'E:/Work/Aperant',
      subtaskId: '2.2',
      context: {
        id: '2.2',
        workflowType: 'feature',
        title: 'Implement auth change and update README',
        description: 'Change auth behavior and document the new option.',
        filesToCreate: [],
        filesToModify: ['src/auth/session-store.ts', 'README.md'],
        patternFiles: ['src/auth/session-store.test.ts'],
      },
    });

    expect(message).not.toContain('Documentation-only workflow');
    expect(message).toContain('Code quality: before editing, identify the touched implementation contract');
  });

  it('passes structured architecture guidance into focused coder prompts', () => {
    const context = findAutocodeSubtaskKickoffContext({
      workflow_type: 'feature',
      phases: [
        {
          name: 'Implementation',
          subtasks: [
            {
              id: '1.2',
              title: 'Create HTML entry',
              description: 'Create the static application shell.',
              architecture: 'static entry layer; HTML structure contract strategy; requirements.md R1',
              files_to_create: ['index.html'],
            },
          ],
        },
      ],
    }, '1.2');

    const message = buildAutocodeFocusedCoderKickoffMessageFromContext({
      specDir: 'E:/Work/Aperant/.autocode/specs/gomoku',
      projectDir: 'E:/Work/Aperant',
      subtaskId: '1.2',
      context,
    });

    expect(message).toContain('- Architecture: static entry layer; HTML structure contract strategy; requirements.md R1');
  });
});
