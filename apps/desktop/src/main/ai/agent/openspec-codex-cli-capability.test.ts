import { describe, expect, it } from 'vitest';

import { OPEN_SPEC_ACTIONS } from '../../../shared/types';
import {
  __openSpecCodexCliCapabilityTestUtils,
  canUseOpenSpecCodexCliFallback,
  resolveOpenSpecCodexCliFallbackRegistration,
  type OpenSpecCodexCliFallbackRegistrationInput,
} from './openspec-codex-cli-capability';

describe('OpenSpec Codex CLI fallback capabilities', () => {
  it('allows the reviewed resume-safe Explore and Apply Actions', () => {
    expect(__openSpecCodexCliCapabilityTestUtils.supportedActions).toEqual([
      'explore',
      'apply',
    ]);
    for (const action of __openSpecCodexCliCapabilityTestUtils.supportedActions) {
      expect(canUseOpenSpecCodexCliFallback(action)).toBe(true);
    }
  });

  it('fails closed for every other pinned or unknown Action', () => {
    const blockedActions = OPEN_SPEC_ACTIONS.filter(
      (action) => !__openSpecCodexCliCapabilityTestUtils.supportedActions.includes(action),
    );
    for (const action of blockedActions) {
      expect(canUseOpenSpecCodexCliFallback(action)).toBe(false);
    }
    expect(canUseOpenSpecCodexCliFallback(undefined)).toBe(false);
    expect(canUseOpenSpecCodexCliFallback('future-action' as never)).toBe(false);
  });
});

describe('OpenSpec Codex CLI fallback registration', () => {
  function createValidInput(): OpenSpecCodexCliFallbackRegistrationInput {
    return {
      agentType: 'openspec',
      provider: 'openai',
      initialMessages: [{
        role: 'user',
        content: ' \r\nExplore this design without changing files.\n ',
      }],
      action: 'explore',
      readOnly: true,
      allowedPathRoots: ['C:\\workspace'],
      trustedRuntimeReadPaths: ['C:\\runtime\\AGENTS.md'],
      allowedWritePaths: [],
    };
  }

  it('returns a complete resume-safe payload without rewriting prompt bytes', () => {
    const input = createValidInput();

    const registration =
      resolveOpenSpecCodexCliFallbackRegistration(input);

    expect(registration).toEqual({
      action: 'explore',
      userMessage: ' \r\nExplore this design without changing files.\n ',
      readOnly: true,
      allowProviderFailureFallbackAfterProgress: true,
      allowedPathRoots: ['C:\\workspace'],
      trustedRuntimeReadPaths: ['C:\\runtime\\AGENTS.md'],
      allowedWritePaths: [],
    });
    expect(registration?.allowedPathRoots).not.toBe(input.allowedPathRoots);
    expect(registration?.trustedRuntimeReadPaths).not.toBe(
      input.trustedRuntimeReadPaths,
    );
    expect(registration?.allowedWritePaths).not.toBe(input.allowedWritePaths);
  });

  it('registers a preselected Apply Action with scoped write roots', () => {
    const registration = resolveOpenSpecCodexCliFallbackRegistration({
      ...createValidInput(),
      initialMessages: [{
        role: 'user',
        content: 'change-a',
      }],
      action: 'apply',
      readOnly: false,
      allowedWritePaths: [
        'C:\\workspace\\openspec',
        'C:\\workspace\\src',
      ],
    });

    expect(registration).toEqual({
      action: 'apply',
      userMessage: 'change-a',
      readOnly: false,
      allowProviderFailureFallbackAfterProgress: true,
      allowedPathRoots: ['C:\\workspace'],
      trustedRuntimeReadPaths: ['C:\\runtime\\AGENTS.md'],
      allowedWritePaths: [
        'C:\\workspace\\openspec',
        'C:\\workspace\\src',
      ],
    });
  });

  it('registers API-key sessions because Codex CLI uses its own login state', () => {
    expect(resolveOpenSpecCodexCliFallbackRegistration(
      createValidInput(),
    )).not.toBeNull();
  });

  const invalidCases: Array<{
    name: string;
    override: Partial<OpenSpecCodexCliFallbackRegistrationInput>;
  }> = [
    {
      name: 'a non-OpenSpec agent',
      override: { agentType: 'coder' },
    },
    {
      name: 'a non-OpenAI provider',
      override: { provider: 'anthropic' },
    },
    {
      name: 'missing messages',
      override: { initialMessages: undefined },
    },
    {
      name: 'no messages',
      override: { initialMessages: [] },
    },
    {
      name: 'multiple messages',
      override: {
        initialMessages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ],
      },
    },
    {
      name: 'an assistant message',
      override: {
        initialMessages: [{ role: 'assistant', content: 'response' }],
      },
    },
    {
      name: 'a message without content',
      override: {
        initialMessages: [{ role: 'user' }],
      },
    },
    {
      name: 'a blank user message',
      override: {
        initialMessages: [{ role: 'user', content: ' \r\n\t' }],
      },
    },
    {
      name: 'a missing Action',
      override: { action: undefined },
    },
    {
      name: 'an Action outside the reviewed allowlist',
      override: { action: 'archive' },
    },
    {
      name: 'a missing read-only flag',
      override: { readOnly: undefined },
    },
    {
      name: 'a writable session',
      override: { readOnly: false },
    },
    {
      name: 'missing write paths',
      override: { allowedWritePaths: undefined },
    },
    {
      name: 'a non-empty write path list',
      override: { allowedWritePaths: ['C:\\workspace'] },
    },
    {
      name: 'missing allowed path roots',
      override: { allowedPathRoots: undefined },
    },
    {
      name: 'no allowed path roots',
      override: { allowedPathRoots: [] },
    },
    {
      name: 'a blank allowed path root',
      override: { allowedPathRoots: [' '] },
    },
    {
      name: 'missing trusted runtime read paths',
      override: { trustedRuntimeReadPaths: undefined },
    },
    {
      name: 'no trusted runtime read paths',
      override: { trustedRuntimeReadPaths: [] },
    },
    {
      name: 'a blank trusted runtime read path',
      override: { trustedRuntimeReadPaths: ['\t'] },
    },
  ];

  for (const { name, override } of invalidCases) {
    it(`does not register for ${name}`, () => {
      expect(resolveOpenSpecCodexCliFallbackRegistration({
        ...createValidInput(),
        ...override,
      })).toBeNull();
    });
  }
});
