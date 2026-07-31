import { describe, expect, it, vi } from 'vitest';

import { createOpenSpecAutomaticInputResponder } from '../../../agent/openspec-auto-answer';
import type { ToolContext } from '../../types';
import { askUserQuestionTool } from '../ask-user-question';
import { openSpecTaskTool } from '../openspec-task';
import { todoWriteTool } from '../todo-write';

const context = {
  cwd: '/project',
  projectDir: '/project',
  specDir: '/project',
  securityProfile: {
    baseCommands: new Set<string>(),
    stackCommands: new Set<string>(),
    scriptCommands: new Set<string>(),
    customCommands: new Set<string>(),
    customScripts: { shellScripts: [] },
    getAllAllowedCommands: () => new Set<string>(),
  },
  openSpecDelegatedPrompts: {
    sync: 'PINNED OFFICIAL SYNC PROMPT',
  },
} as ToolContext;

describe('OpenSpec upstream host tools', () => {
  it('returns the recommended AskUserQuestion answer through the automatic responder', async () => {
    const requestUserInput = createOpenSpecAutomaticInputResponder({
      agentType: 'openspec',
      openSpecRunId: 'run-1',
      language: 'en',
      abortSignal: new AbortController().signal,
    });
    expect(requestUserInput).toBeTypeOf('function');
    if (!requestUserInput) {
      throw new Error('Expected an automatic responder for the OpenSpec run.');
    }
    const trackedResponder = vi.fn(requestUserInput);

    const result = await askUserQuestionTool.config.execute({
      questions: [{
        question: 'Choose the migration strategy.',
        options: [
          { label: 'One-shot replacement' },
          {
            label: 'Incremental migration',
            description: 'Recommended because it preserves compatibility',
          },
        ],
      }],
    }, {
      ...context,
      requestUserInput: trackedResponder,
    });

    expect(result).toBe('Incremental migration');
    expect(trackedResponder).toHaveBeenCalledOnce();
    expect(trackedResponder).toHaveBeenCalledWith({
      questions: [{
        question: 'Choose the migration strategy.',
        options: [
          { label: 'One-shot replacement' },
          {
            label: 'Incremental migration',
            description: 'Recommended because it preserves compatibility',
          },
        ],
      }],
    });
  });

  it('provides the TodoWrite shape used by Propose and Fast Forward', async () => {
    expect(todoWriteTool.metadata.name).toBe('TodoWrite');
    const result = await todoWriteTool.config.execute({
      todos: [
        { content: 'Create proposal', status: 'completed' },
        {
          content: 'Create specs',
          status: 'in_progress',
          activeForm: 'Creating specs',
        },
        { content: 'Create tasks', status: 'pending' },
      ],
    }, context);
    expect(JSON.parse(result)).toMatchObject({
      accepted: true,
      total: 3,
      completed: 1,
      in_progress: 1,
      pending: 1,
    });
  });

  it('delegates only official Sync work to the isolated executor', async () => {
    expect(openSpecTaskTool.metadata.name).toBe('Task');
    const runOpenSpecDelegation = vi.fn().mockResolvedValue(
      'SYNC CHILD SESSION COMPLETE',
    );
    const delegatedContext: ToolContext = {
      ...context,
      runOpenSpecDelegation,
    };
    const prompt = "Use Skill tool to invoke openspec-sync-specs for change 'change-a'.";
    const result = await openSpecTaskTool.config.execute({
      subagent_type: 'general-purpose',
      prompt,
      description: 'Synchronize delta specs',
    }, delegatedContext);
    expect(result).toBe('SYNC CHILD SESSION COMPLETE');
    expect(runOpenSpecDelegation).toHaveBeenCalledOnce();
    expect(runOpenSpecDelegation).toHaveBeenCalledWith({
      action: 'sync',
      prompt,
      description: 'Synchronize delta specs',
    });

    await expect(openSpecTaskTool.config.execute({
      subagent_type: 'specialist',
      prompt: 'openspec-sync-specs',
    }, context)).resolves.toContain('Unsupported');
    await expect(openSpecTaskTool.config.execute({
      subagent_type: 'general-purpose',
      prompt: 'Run a Standard planning subagent.',
    }, context)).resolves.toContain('Only the official');
  });

  it('fails Archive closed when the isolated executor is absent or fails', async () => {
    await expect(openSpecTaskTool.config.execute({
      subagent_type: 'general-purpose',
      prompt: 'openspec-sync-specs',
    }, context)).rejects.toThrow('Archive cannot continue');

    const failedContext: ToolContext = {
      ...context,
      runOpenSpecDelegation: vi.fn().mockRejectedValue(
        new Error('sync child failed'),
      ),
    };
    await expect(openSpecTaskTool.config.execute({
      subagent_type: 'general-purpose',
      prompt: 'openspec-sync-specs',
    }, failedContext)).rejects.toThrow('sync child failed');
  });
});
