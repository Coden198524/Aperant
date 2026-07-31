import { describe, expect, it } from 'vitest';

import {
  __agentManagerTestUtils,
  __openSpecAgentManagerTestUtils,
  type OpenSpecAgentActionInput,
} from './agent-manager';

describe('AgentManager isolated OpenSpec session config', () => {
  it('falls back to the tracked app language when settings have not persisted it', () => {
    expect(__agentManagerTestUtils.resolveAgentAppLanguage(
      undefined,
      'zh',
    )).toBe('zh-CN');
    expect(__agentManagerTestUtils.resolveAgentAppLanguage(
      'fr',
      'zh-CN',
    )).toBe('fr');
  });

  it('preserves official prompt bytes and adds language and autonomy only to the user message', () => {
    const officialPrompt = 'Official OpenSpec prompt\r\n  exact whitespace  \n';
    const userMessage = 'change-a 用户原始需求\r\n';
    const actionInput: OpenSpecAgentActionInput = {
      taskId: 'task-a',
      projectId: 'project-a',
      runId: 'run-a',
      action: 'archive',
      projectPath: 'C:\\workspace',
      runtimeRoot: 'D:\\registered-store',
      specDir: 'C:\\workspace\\.autocode\\specs\\task-a',
      prompt: officialPrompt,
      userMessage,
      commandEnv: {
        PATH: 'C:\\pinned-openspec-shim',
        OPENSPEC_TELEMETRY: '0',
      },
      allowedPathRoots: ['C:\\workspace', 'D:\\registered-store'],
      trustedRuntimeReadPaths: [
        'C:\\pinned-openspec-shim',
        'C:\\app\\resources\\openspec',
        'C:\\app',
      ],
      allowedWritePaths: ['D:\\registered-store\\openspec'],
      openSpecStoreId: 'shared-specs',
      readOnly: false,
      delegatedPrompts: {
        sync: 'Official Sync prompt\n',
      },
    };

    const session = __openSpecAgentManagerTestUtils.buildOpenSpecSessionConfig({
      actionInput,
      language: 'zh-CN',
      phase: 'planning',
      maxSteps: 120,
      phaseStepBudgets: { planning: 120 },
      thinkingLevel: 'high',
      provider: 'openai',
      modelId: 'gpt-test',
      apiKey: 'test-key',
      providerModelInvocationRoutes: [],
      securityProfile: {
        baseCommands: ['git'],
        stackCommands: ['npm'],
        scriptCommands: [],
        customCommands: [],
        customScripts: { shellScripts: [] },
      },
    });

    expect(Buffer.from(session.systemPrompt, 'utf8'))
      .toEqual(Buffer.from(officialPrompt, 'utf8'));
    expect(session.initialMessages).toHaveLength(1);
    expect(session.initialMessages[0]?.role).toBe('user');
    expect(session.initialMessages[0]?.content.startsWith(userMessage)).toBe(true);
    expect(session.initialMessages[0]?.content).toContain(
      '## OUTPUT LANGUAGE REQUIREMENT',
    );
    expect(session.initialMessages[0]?.content).toContain(
      'Use Simplified Chinese for all user-facing prose',
    );
    expect(session.initialMessages[0]?.content).toContain(
      '## OPENSPEC AUTOMATIC DECISION REQUIREMENT',
    );
    expect(session.initialMessages[0]?.content).toContain(
      '不要暂停或等待人工输入',
    );
    expect(session.initialMessages[0]?.content).toContain(
      '不要再次询问用户',
    );
    expect(session).toMatchObject({
      agentType: 'openspec',
      preservePromptBytes: true,
      disableTaskLogs: true,
      openSpecRunId: 'run-a',
      openSpecAction: 'archive',
      openSpecReadOnly: false,
      language: 'zh-CN',
      specDir: 'D:\\registered-store',
      projectDir: 'D:\\registered-store',
      phase: 'planning',
      workflowMode: 'balanced',
      responsePersistence: false,
      mcpOptions: {
        context7Enabled: false,
        memoryEnabled: false,
        linearEnabled: false,
        yunxiaoEnabled: false,
        electronMcpEnabled: false,
        puppeteerMcpEnabled: false,
        customMcpServers: [],
        mcpEnv: { GRAPHITI_ENABLED: 'false' },
      },
      toolContext: {
        cwd: 'D:\\registered-store',
        projectDir: 'D:\\registered-store',
        specDir: 'D:\\registered-store',
        allowedPathRoots: ['C:\\workspace', 'D:\\registered-store'],
        trustedRuntimeReadPaths: [
          'C:\\pinned-openspec-shim',
          'C:\\app\\resources\\openspec',
          'C:\\app',
        ],
        allowedWritePaths: ['D:\\registered-store\\openspec'],
        openSpecBashPolicy: {
          allowedPathRoots: ['C:\\workspace', 'D:\\registered-store'],
          allowedWritePaths: ['D:\\registered-store\\openspec'],
          storeId: 'shared-specs',
        },
      },
    });
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain('SpecOrchestrator');
    expect(serialized).not.toContain('implementation_plan');
    expect(serialized).not.toContain('qa_reviewer');
    expect(session).not.toHaveProperty('useAgenticOrchestration');
    expect(session).not.toHaveProperty('projectDocsReference');
  });

  it('adds English autonomy instructions and marks Explore as read-only', () => {
    const session = __openSpecAgentManagerTestUtils.buildOpenSpecSessionConfig({
      actionInput: {
        taskId: 'task-a',
        runId: 'run-a',
        action: 'explore',
        projectPath: 'C:\\workspace',
        runtimeRoot: 'C:\\workspace',
        specDir: 'C:\\runtime',
        prompt: 'Explore prompt',
        userMessage: 'Investigate',
        commandEnv: {},
        allowedPathRoots: ['C:\\workspace'],
        trustedRuntimeReadPaths: [
          'C:\\pinned-openspec-shim',
          'C:\\app\\resources\\openspec',
          'C:\\app',
        ],
        allowedWritePaths: [],
        readOnly: true,
      },
      language: 'en',
      phase: 'planning',
      maxSteps: 40,
      thinkingLevel: 'high',
      provider: 'anthropic',
      modelId: 'claude-test',
      securityProfile: {
        baseCommands: [],
        stackCommands: [],
        scriptCommands: [],
        customCommands: [],
        customScripts: { shellScripts: [] },
      },
    });

    expect(session.openSpecReadOnly).toBe(true);
    expect(session.language).toBe('en');
    expect(session.initialMessages).toHaveLength(1);
    expect(session.initialMessages[0]?.role).toBe('user');
    expect(session.initialMessages[0]?.content.startsWith('Investigate')).toBe(true);
    expect(session.initialMessages[0]?.content).toContain(
      '## OPENSPEC AUTOMATIC DECISION REQUIREMENT',
    );
    expect(session.initialMessages[0]?.content).toContain(
      'do not pause or wait for human input',
    );
    expect(session.initialMessages[0]?.content).not.toContain(
      '## OUTPUT LANGUAGE REQUIREMENT',
    );
    expect(session.toolContext.readOnlySession).toBe(true);
    expect(session.toolContext.openSpecBashPolicy).toEqual({
      allowedPathRoots: ['C:\\workspace'],
      allowedWritePaths: [],
    });
  });
});
