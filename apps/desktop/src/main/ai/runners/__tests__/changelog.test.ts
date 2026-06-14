import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Mocks — must be declared before any imports that use them
// =============================================================================

const mockGenerateText = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

const mockCreateSimpleClient = vi.fn();

vi.mock('../../client/factory', () => ({
  createSimpleClient: (...args: unknown[]) => mockCreateSimpleClient(...args),
}));

// =============================================================================
// Import after mocking
// =============================================================================

import {
  CHANGELOG_COMMITS_MAX_CHARS,
  CHANGELOG_PREVIOUS_CHANGELOG_MAX_CHARS,
  CHANGELOG_TASK_DESCRIPTION_MAX_CHARS,
  CHANGELOG_TASKS_MAX,
  generateChangelog,
} from '../changelog';
import type { ChangelogConfig } from '../changelog';

// =============================================================================
// Helpers
// =============================================================================

/** A fake model object used by the mock client */
const fakeModel = { modelId: 'claude-haiku-test' };

function makeMockClient(systemPrompt = 'You are a technical writer.') {
  return { model: fakeModel, systemPrompt };
}

function baseConfig(overrides: Partial<ChangelogConfig> = {}): ChangelogConfig {
  return {
    projectName: 'TestProject',
    version: '1.0.0',
    sourceMode: 'tasks',
    tasks: [
      { title: 'Add dark mode', description: 'Implemented dark mode toggle', category: 'feature' },
    ],
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('generateChangelog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSimpleClient.mockResolvedValue(makeMockClient());
  });

  // ---------------------------------------------------------------------------
  // Successful generation
  // ---------------------------------------------------------------------------

  it('returns success with trimmed text when LLM responds', async () => {
    mockGenerateText.mockResolvedValue({ text: '  ## [1.0.0]\n\n### Added\n- Dark mode\n  ' });

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(true);
    expect(result.text).toBe('## [1.0.0]\n\n### Added\n- Dark mode');
    expect(result.error).toBeUndefined();
  });

  it('passes project name and version in the prompt to createSimpleClient', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [2.0.0]' });

    await generateChangelog(baseConfig({ projectName: 'MyApp', version: '2.0.0' }));

    // createSimpleClient receives system-level configuration
    expect(mockCreateSimpleClient).toHaveBeenCalledOnce();
    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    expect(clientArgs).toHaveProperty('modelShorthand');
    expect(clientArgs).toHaveProperty('thinkingLevel');
  });

  it('passes model and systemPrompt from client to generateText', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(baseConfig());

    expect(mockGenerateText).toHaveBeenCalledOnce();
    const callArgs = mockGenerateText.mock.calls[0][0];
    expect(callArgs.model).toBe(fakeModel);
    expect(callArgs.system).toBe('You are a technical writer.');
    expect(callArgs.prompt).toContain('TestProject');
    expect(callArgs.prompt).toContain('1.0.0');
  });

  // ---------------------------------------------------------------------------
  // Task mode — prompt content
  // ---------------------------------------------------------------------------

  it('includes task titles and categories in prompt for tasks mode', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    const config = baseConfig({
      tasks: [
        { title: 'My feature', description: 'desc', category: 'feature', issueNumber: 42 },
      ],
    });
    await generateChangelog(config);

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('My feature');
    expect(prompt).toContain('feature');
    expect(prompt).toContain('#42');
  });

  // ---------------------------------------------------------------------------
  // Git history / branch-diff modes
  // ---------------------------------------------------------------------------

  it('includes commit messages in prompt for git-history mode', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(
      baseConfig({ sourceMode: 'git-history', commits: 'feat: add login\nfix: bug #5' }),
    );

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('feat: add login');
  });

  it('truncates commits to the prompt budget', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });
    const longCommits = 'x'.repeat(10_000);

    await generateChangelog(baseConfig({ sourceMode: 'branch-diff', commits: longCommits }));

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    const xCount = (prompt.match(/x/g) ?? []).length;
    expect(xCount).toBeLessThanOrEqual(CHANGELOG_COMMITS_MAX_CHARS);
    expect(prompt).toContain('truncated');
  });

  it('caps task count and per-task descriptions in prompt for tasks mode', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });
    const tasks = Array.from({ length: CHANGELOG_TASKS_MAX + 5 }, (_, index) => ({
      title: `Task ${index + 1}`,
      description: index === 0 ? 'd'.repeat(2_000) : `Description ${index + 1}`,
      category: 'feature',
    }));

    await generateChangelog(baseConfig({ tasks }));

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain(`Task ${CHANGELOG_TASKS_MAX}`);
    expect(prompt).not.toContain(`Task ${CHANGELOG_TASKS_MAX + 1}`);
    expect(prompt).toContain('5 additional completed tasks omitted');
    const dCount = (prompt.match(/d/g) ?? []).length;
    expect(dCount).toBeLessThanOrEqual(CHANGELOG_TASK_DESCRIPTION_MAX_CHARS + 80);
    expect(prompt).toContain('truncated');
  });

  // ---------------------------------------------------------------------------
  // Previous changelog style reference
  // ---------------------------------------------------------------------------

  it('includes previousChangelog when provided', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(
      baseConfig({ previousChangelog: '## [0.9.0]\n\n### Added\n- Old feature' }),
    );

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('Previous Changelog');
    expect(prompt).toContain('0.9.0');
  });

  it('truncates previousChangelog to the style-reference budget', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(baseConfig({ previousChangelog: 'p'.repeat(5_000) }));

    const prompt = mockGenerateText.mock.calls[0][0].prompt as string;
    const pCount = (prompt.match(/p/g) ?? []).length;
    expect(pCount).toBeLessThanOrEqual(CHANGELOG_PREVIOUS_CHANGELOG_MAX_CHARS);
    expect(prompt).toContain('truncated');
  });

  // ---------------------------------------------------------------------------
  // Default model / thinking level
  // ---------------------------------------------------------------------------

  it('uses sonnet model and low thinking level by default', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(baseConfig());

    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    expect(clientArgs.modelShorthand).toBe('sonnet');
    expect(clientArgs.thinkingLevel).toBe('low');
  });

  it('accepts custom modelShorthand and thinkingLevel', async () => {
    mockGenerateText.mockResolvedValue({ text: '## [1.0.0]' });

    await generateChangelog(baseConfig({ modelShorthand: 'haiku', thinkingLevel: 'high' }));

    const clientArgs = mockCreateSimpleClient.mock.calls[0][0];
    expect(clientArgs.modelShorthand).toBe('haiku');
    expect(clientArgs.thinkingLevel).toBe('high');
  });

  // ---------------------------------------------------------------------------
  // Empty response handling
  // ---------------------------------------------------------------------------

  it('returns failure when LLM returns empty text', async () => {
    mockGenerateText.mockResolvedValue({ text: '   ' });

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(false);
    expect(result.text).toBe('');
    expect(result.error).toBe('Empty response from AI');
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it('returns failure with error message when generateText throws', async () => {
    mockGenerateText.mockRejectedValue(new Error('Rate limit exceeded'));

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(false);
    expect(result.text).toBe('');
    expect(result.error).toBe('Rate limit exceeded');
  });

  it('returns failure with string coercion when non-Error is thrown', async () => {
    mockGenerateText.mockRejectedValue('timeout');

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout');
  });

  it('returns failure when createSimpleClient throws', async () => {
    mockCreateSimpleClient.mockRejectedValue(new Error('No auth available'));

    const result = await generateChangelog(baseConfig());

    expect(result.success).toBe(false);
    expect(result.error).toBe('No auth available');
  });
});
