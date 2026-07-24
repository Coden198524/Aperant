import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mocks — must be declared before any imports that use them
// =============================================================================

const mockStreamText = vi.fn();

vi.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
  stepCountIs: (n: number) => ({ type: 'stepCount', count: n }),
}));

const mockCreateSimpleClient = vi.fn();

vi.mock('../../client/factory', () => ({
  createSimpleClient: (...args: unknown[]) => mockCreateSimpleClient(...args),
}));

// Filesystem mocks — project context files are absent by default
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReadFileSync = vi.fn();
const mockReaddirSync = vi.fn().mockReturnValue([]);

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
}));

// Mock tool registry
const mockGetToolsForAgent = vi.fn().mockReturnValue({});
vi.mock('../../tools/build-registry', () => ({
  buildToolRegistry: () => ({
    getToolsForAgent: mockGetToolsForAgent,
  }),
}));

// json-repair is used for safeParseJson in the insights runner
vi.mock('../../../utils/json-repair', () => ({
  safeParseJson: (text: string) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },
}));

// parseLLMJson is used for task suggestion extraction
vi.mock('../../schema/structured-output', () => ({
  parseLLMJson: vi.fn().mockReturnValue(null),
}));

vi.mock('../../schema/insight-extractor', () => ({
  TaskSuggestionSchema: {},
}));

// =============================================================================
// Import after mocking
// =============================================================================

import {
  INSIGHTS_CURRENT_MESSAGE_MAX_CHARS,
  INSIGHTS_HISTORY_MAX_CHARS,
  INSIGHTS_HISTORY_MAX_MESSAGES,
  INSIGHTS_HISTORY_MESSAGE_MAX_CHARS,
  INSIGHTS_PROJECT_DOCS_REFERENCE_MAX_BYTES,
  runInsightsQuery,
} from '../insights';
import type { InsightsConfig, InsightsStreamEvent } from '../insights';
import { parseLLMJson } from '../../schema/structured-output';
import { MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS } from '../../../../shared/constants';

// =============================================================================
// Helpers
// =============================================================================

const fakeModel = { modelId: 'claude-sonnet-test' };

function makeMockClient(systemPrompt = 'You are an AI assistant.') {
  return {
    model: fakeModel,
    systemPrompt,
    tools: {},
    maxSteps: 30,
  };
}

function makeStream(parts: Array<Record<string, unknown>>) {
  return {
    fullStream: (async function* () {
      for (const part of parts) {
        yield part;
      }
    })(),
  };
}

function baseConfig(overrides: Partial<InsightsConfig> = {}): InsightsConfig {
  return {
    projectDir: '/project',
    message: 'How does authentication work?',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('runInsightsQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSimpleClient.mockResolvedValue(makeMockClient());
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    vi.mocked(parseLLMJson).mockReturnValue(null);
  });

  // ---------------------------------------------------------------------------
  // Successful run — no streaming events needed from caller
  // ---------------------------------------------------------------------------

  it('returns response text accumulated from stream', async () => {
    mockStreamText.mockReturnValue(
      makeStream([
        { type: 'text-delta', text: 'Authentication uses JWT tokens.' },
        { type: 'text-delta', text: ' Tokens expire after 1 hour.' },
      ]),
    );

    const result = await runInsightsQuery(baseConfig());

    expect(result.text).toBe('Authentication uses JWT tokens. Tokens expire after 1 hour.');
    expect(result.taskSuggestion).toBeNull();
    expect(result.toolCalls).toEqual([]);
  });

  it('returns empty text and no task suggestion when stream is empty', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    const result = await runInsightsQuery(baseConfig());

    expect(result.text).toBe('');
    expect(result.taskSuggestion).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Task suggestion extraction
  // ---------------------------------------------------------------------------

  it('extracts task suggestion from response text when marker present', async () => {
    const suggestion = {
      title: 'Add rate limiting',
      description: 'Implement per-user rate limiting on auth endpoints',
      metadata: { category: 'security', complexity: 'medium', impact: 'high' },
    };

    mockStreamText.mockReturnValue(
      makeStream([
        {
          type: 'text-delta',
          text: `Here is my suggestion.\n__TASK_SUGGESTION__:${JSON.stringify(suggestion)}\n`,
        },
      ]),
    );

    vi.mocked(parseLLMJson).mockReturnValueOnce(suggestion as unknown as ReturnType<typeof parseLLMJson>);

    const result = await runInsightsQuery(baseConfig());

    expect(result.taskSuggestion).not.toBeNull();
    expect(result.taskSuggestion?.title).toBe('Add rate limiting');
    expect(result.taskSuggestion?.metadata.category).toBe('security');
  });

  it('returns null taskSuggestion when no marker in response', async () => {
    mockStreamText.mockReturnValue(
      makeStream([{ type: 'text-delta', text: 'No suggestions here.' }]),
    );

    const result = await runInsightsQuery(baseConfig());

    expect(result.taskSuggestion).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Tool call tracking
  // ---------------------------------------------------------------------------

  it('tracks tool calls in result.toolCalls', async () => {
    mockStreamText.mockReturnValue(
      makeStream([
        { type: 'tool-call', toolName: 'Read', toolCallId: 'c1', input: { file_path: 'src/auth.ts' } },
        { type: 'tool-result', toolCallId: 'c1', toolName: 'Read', output: 'file content' },
        { type: 'tool-call', toolName: 'Glob', toolCallId: 'c2', input: { pattern: '**/*.ts' } },
        { type: 'tool-result', toolCallId: 'c2', toolName: 'Glob', output: 'src/auth.ts' },
      ]),
    );

    const result = await runInsightsQuery(baseConfig());

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].name).toBe('Read');
    expect(result.toolCalls[1].name).toBe('Glob');
  });

  it('extracts file_path from Read tool call input', async () => {
    mockStreamText.mockReturnValue(
      makeStream([
        {
          type: 'tool-call',
          toolName: 'Read',
          toolCallId: 'c1',
          input: { file_path: 'src/auth.ts' },
        },
      ]),
    );

    const result = await runInsightsQuery(baseConfig());

    expect(result.toolCalls[0].input).toBe('src/auth.ts');
  });

  it('extracts pattern from Grep/Glob tool call input', async () => {
    mockStreamText.mockReturnValue(
      makeStream([
        {
          type: 'tool-call',
          toolName: 'Grep',
          toolCallId: 'c1',
          input: { pattern: 'useAuth' },
        },
      ]),
    );

    const result = await runInsightsQuery(baseConfig());

    expect(result.toolCalls[0].input).toBe('pattern: useAuth');
  });

  // ---------------------------------------------------------------------------
  // Stream callbacks
  // ---------------------------------------------------------------------------

  it('forwards text-delta events to onStream callback', async () => {
    mockStreamText.mockReturnValue(
      makeStream([
        { type: 'text-delta', text: 'chunk1' },
        { type: 'text-delta', text: 'chunk2' },
      ]),
    );

    const events: InsightsStreamEvent[] = [];
    await runInsightsQuery(baseConfig(), (e) => events.push(e));

    const textEvents = events.filter((e) => e.type === 'text-delta');
    expect(textEvents).toHaveLength(2);
  });

  it('forwards tool-start events for tool-call stream parts', async () => {
    mockStreamText.mockReturnValue(
      makeStream([
        { type: 'tool-call', toolName: 'Grep', toolCallId: 'c1', input: { pattern: 'login' } },
      ]),
    );

    const events: InsightsStreamEvent[] = [];
    await runInsightsQuery(baseConfig(), (e) => events.push(e));

    const toolStartEvents = events.filter((e) => e.type === 'tool-start');
    expect(toolStartEvents).toHaveLength(1);
    expect((toolStartEvents[0] as { type: 'tool-start'; name: string }).name).toBe('Grep');
  });

  it('forwards tool-end events for tool-result stream parts', async () => {
    mockStreamText.mockReturnValue(
      makeStream([
        { type: 'tool-result', toolCallId: 'c1', toolName: 'Read', output: 'content' },
      ]),
    );

    const events: InsightsStreamEvent[] = [];
    await runInsightsQuery(baseConfig(), (e) => events.push(e));

    const toolEndEvents = events.filter((e) => e.type === 'tool-end');
    expect(toolEndEvents).toHaveLength(1);
  });

  it('forwards error events for error stream parts', async () => {
    mockStreamText.mockReturnValue(
      makeStream([{ type: 'error', error: new Error('tool failed') }]),
    );

    const events: InsightsStreamEvent[] = [];
    await expect(runInsightsQuery(baseConfig(), (e) => events.push(e))).rejects.toThrow(
      'tool failed',
    );

    const errorEvents = events.filter((e) => e.type === 'error');
    expect(errorEvents).toHaveLength(1);
    expect((errorEvents[0] as { type: 'error'; error: string }).error).toBe('tool failed');
  });

  // ---------------------------------------------------------------------------
  // Error propagation
  // ---------------------------------------------------------------------------

  it('rethrows when streamText iteration throws', async () => {
    mockStreamText.mockReturnValue({
      // biome-ignore lint/correctness/useYield: intentionally throwing before yield to test error path
      fullStream: (async function* () {
        throw new Error('API timeout');
      })(),
    });

    await expect(runInsightsQuery(baseConfig())).rejects.toThrow('API timeout');
  });

  it('emits error event to callback before rethrowing', async () => {
    mockStreamText.mockReturnValue({
      // biome-ignore lint/correctness/useYield: intentionally throwing before yield to test error path
      fullStream: (async function* () {
        throw new Error('rate limited');
      })(),
    });

    const events: InsightsStreamEvent[] = [];
    await expect(runInsightsQuery(baseConfig(), (e) => events.push(e))).rejects.toThrow(
      'rate limited',
    );

    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Client configuration
  // ---------------------------------------------------------------------------

  it('uses sonnet model and medium thinking level by default', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runInsightsQuery(baseConfig());

    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    expect(clientArgs.modelShorthand).toBe('sonnet');
    expect(clientArgs.thinkingLevel).toBe('medium');
  });

  it('accepts custom modelShorthand and thinkingLevel', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runInsightsQuery(baseConfig({ modelShorthand: 'haiku', thinkingLevel: 'low' }));

    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    expect(clientArgs.modelShorthand).toBe('haiku');
    expect(clientArgs.thinkingLevel).toBe('low');
  });

  it('keeps generated project documentation context compact in the system prompt', async () => {
    mockStreamText.mockReturnValue(makeStream([]));
    mockExistsSync.mockImplementation((filePath: unknown) => {
      const normalized = String(filePath).replace(/\\/g, '/');
      return normalized.includes('/project/.autocode/project-docs/');
    });
    mockReadFileSync.mockImplementation((filePath: unknown) => {
      const name = String(filePath).replace(/\\/g, '/').split('/').pop();
      return [
        `# ${name}`,
        '',
        '## Architecture',
        '',
        '- Renderer owns task views and state hydration.',
        '- Main process owns IPC and long-running AI orchestration.',
        '',
        ...Array.from({ length: 220 }, (_, index) => (
          `- Deep repeated detail ${index}: ${'large documentation paragraph '.repeat(8)}`
        )),
      ].join('\n');
    });

    await runInsightsQuery(baseConfig());

    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    const systemPrompt = clientArgs.systemPrompt as string;
    expect(INSIGHTS_PROJECT_DOCS_REFERENCE_MAX_BYTES).toBeLessThan(12_000);
    expect(systemPrompt).toContain('Project Documentation Reference');
    expect(systemPrompt).toContain('Compact excerpt');
    expect(systemPrompt).toContain('Renderer owns task views');
    expect(systemPrompt).not.toContain('Deep repeated detail 219');
    expect(Buffer.byteLength(systemPrompt, 'utf8')).toBeLessThan(
      INSIGHTS_PROJECT_DOCS_REFERENCE_MAX_BYTES + 1_600,
    );
  });

  // ---------------------------------------------------------------------------
  // History handling
  // ---------------------------------------------------------------------------

  it('includes conversation history in the prompt when provided', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runInsightsQuery(
      baseConfig({
        message: 'What about refresh tokens?',
        history: [
          { role: 'user', content: 'How does auth work?' },
          { role: 'assistant', content: 'It uses JWT.' },
        ],
      }),
    );

    const callArgs = mockStreamText.mock.calls[0][0];
    const prompt = callArgs.prompt as string;
    expect(prompt).toContain('How does auth work?');
    expect(prompt).toContain('It uses JWT.');
    expect(prompt).toContain('What about refresh tokens?');
  });

  it('passes only referenced paths and grants read-only access to those exact files', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runInsightsQuery(baseConfig({
      message: 'Summarize the decision record.',
      documents: [{
        id: 'adr-1',
        filename: 'ADR-001.md',
        path: 'E:/External/ADR-001.md',
        size: 8 * 1024 ** 3,
      }],
    }));

    const callArgs = mockStreamText.mock.calls[0][0];
    const prompt = callArgs.prompt as string;
    expect(prompt).toContain('Summarize the decision record.');
    expect(prompt).toContain('ADR-001.md');
    expect(prompt).toContain('E:/External/ADR-001.md');
    expect(prompt).toContain('paths only; contents are not embedded');
    expect(prompt).not.toContain('BEGIN ATTACHED DOCUMENT');
    expect(callArgs.messages).toBeUndefined();
    expect(mockGetToolsForAgent.mock.calls[0][1]).toMatchObject({
      allowedPathRoots: ['/project'],
      allowedExactFilePaths: ['E:/External/ADR-001.md'],
    });
    expect(mockCreateSimpleClient.mock.calls[0][0].systemPrompt).toContain(
      'Read only those exact paths as needed',
    );
  });

  it('lists every referenced path without embedding file payloads', async () => {
    mockStreamText.mockReturnValue(makeStream([]));
    const documents = Array.from({ length: 3 }, (_, index) => ({
      id: `document-${index}`,
      filename: `document-${index}.log`,
      path: `E:/Logs/document-${index}.log`,
      size: 20 * 1024 ** 3,
    }));

    await runInsightsQuery(baseConfig({ documents }));

    const prompt = mockStreamText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('E:/Logs/document-0.log');
    expect(prompt).toContain('E:/Logs/document-1.log');
    expect(prompt).toContain('E:/Logs/document-2.log');
    expect(prompt).not.toContain('data:');
  });

  it('rejects an over-budget document path batch before building tools or a prompt', async () => {
    const segmentLength = Math.floor(MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS / 3) + 1;
    const documents = Array.from({ length: 3 }, (_, index) => ({
      id: `document-${index}`,
      filename: `document-${index}.log`,
      path: `E:/${String(index).repeat(segmentLength)}`,
    }));

    await expect(runInsightsQuery(baseConfig({ documents }))).rejects.toThrow(
      `${MAX_INSIGHTS_DOCUMENT_PATH_CHARACTERS}-character`,
    );
    expect(mockCreateSimpleClient).not.toHaveBeenCalled();
    expect(mockGetToolsForAgent).not.toHaveBeenCalled();
    expect(mockStreamText).not.toHaveBeenCalled();
  });

  it('compacts long insights history while preserving the current question', async () => {
    mockStreamText.mockReturnValue(makeStream([]));
    const history = Array.from({ length: INSIGHTS_HISTORY_MAX_MESSAGES + 4 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `history-${index} ${'verbose detail '.repeat(120)} HISTORY_TAIL_${index}`,
    }));

    await runInsightsQuery(baseConfig({
      message: 'Current question should remain complete.',
      history,
    }));

    const callArgs = mockStreamText.mock.calls[0][0];
    const prompt = callArgs.prompt as string;
    expect(prompt).toContain(`up to ${INSIGHTS_HISTORY_MAX_MESSAGES} most recent of ${history.length} messages`);
    expect(prompt).not.toContain('history-0');
    expect(prompt).not.toContain('history-3');
    expect(prompt).toContain(`history-${history.length - 1}`);
    expect(prompt).toContain(`HISTORY_TAIL_${history.length - 1}`);
    expect(prompt).toContain('history middle omitted');
    expect(prompt).toContain('Current question should remain complete.');
    expect(prompt.length).toBeLessThan(
      INSIGHTS_HISTORY_MAX_CHARS + INSIGHTS_HISTORY_MESSAGE_MAX_CHARS + 700,
    );
  });

  it('compacts an oversized current question when history is empty', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runInsightsQuery(baseConfig({
      message: [
        'question-head',
        'large pasted log '.repeat(2_000),
        'question-tail final error detail',
      ].join('\n'),
    }));

    const callArgs = mockStreamText.mock.calls[0][0];
    const prompt = callArgs.prompt as string;
    expect(prompt.length).toBeLessThanOrEqual(INSIGHTS_CURRENT_MESSAGE_MAX_CHARS);
    expect(prompt).toContain('question-head');
    expect(prompt).toContain('question-tail final error detail');
    expect(prompt).toContain('current question truncated');
  });

  it('compacts an oversized current question when history is present', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runInsightsQuery(baseConfig({
      message: [
        'current-head',
        'diagnostic '.repeat(2_000),
        'current-tail exact question',
      ].join('\n'),
      history: [{ role: 'assistant', content: 'Previous compact answer.' }],
    }));

    const callArgs = mockStreamText.mock.calls[0][0];
    const prompt = callArgs.prompt as string;
    expect(prompt).toContain('Previous compact answer.');
    expect(prompt).toContain('current-head');
    expect(prompt).toContain('current-tail exact question');
    expect(prompt).toContain('current question truncated');
    expect(prompt.length).toBeLessThan(
      INSIGHTS_HISTORY_MAX_CHARS + INSIGHTS_CURRENT_MESSAGE_MAX_CHARS + 700,
    );
  });

  it('uses message directly as prompt when history is empty', async () => {
    mockStreamText.mockReturnValue(makeStream([]));

    await runInsightsQuery(baseConfig({ message: 'What is the entry point?' }));

    const callArgs = mockStreamText.mock.calls[0][0];
    expect(callArgs.prompt).toBe('What is the entry point?');
  });
});
