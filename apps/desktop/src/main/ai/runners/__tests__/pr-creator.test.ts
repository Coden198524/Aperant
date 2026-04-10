import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGenerateText = vi.fn();
const mockCreateSimpleClient = vi.fn();
const mockExecFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockGenerateCommitMessage = vi.fn();

vi.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

vi.mock('../../client/factory', () => ({
  createSimpleClient: (...args: unknown[]) => mockCreateSimpleClient(...args),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

vi.mock('../commit-message', () => ({
  generateCommitMessage: (...args: unknown[]) => mockGenerateCommitMessage(...args),
}));

import { createPR } from '../github/pr-creator';

function baseConfig(overrides: Partial<Parameters<typeof createPR>[0]> = {}) {
  return {
    projectDir: '/project',
    worktreePath: '/project/.auto-claude/worktrees/tasks/002-task',
    specId: '002-task',
    branchName: 'auto-claude/002-task',
    baseBranch: 'master',
    title: 'auto-claude: 002-task',
    ghPath: 'gh',
    gitPath: 'git',
    ...overrides,
  };
}

describe('createPR', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSimpleClient.mockResolvedValue({
      model: { modelId: 'test-model' },
      systemPrompt: 'system',
    });
    mockGenerateText.mockResolvedValue({ text: 'PR body' });
    mockExistsSync.mockReturnValue(false);
    mockGenerateCommitMessage.mockResolvedValue('feat: update 002-task');
  });

  it('returns a clear error when the branch has no commits and no working tree changes', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-list') {
        return '0';
      }
      if (args[0] === 'status') {
        return '';
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const result = await createPR(baseConfig());

    expect(result).toEqual({
      success: false,
      error: 'No commits found between master and auto-claude/002-task. Commit your task changes before creating a PR.',
    });
    expect(mockExecFileSync).not.toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'create']),
      expect.anything(),
    );
  });

  it('auto-commits pending worktree changes before creating the PR', async () => {
    let revListCalls = 0;

    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-list') {
        revListCalls += 1;
        return revListCalls >= 2 ? '1' : '0';
      }
      if (args[0] === 'status' && args[1] === '--porcelain') {
        return ' M src/app.ts';
      }
      if (args[0] === 'add' && args[1] === '-A') {
        return '';
      }
      if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--stat') {
        return '1 file changed, 3 insertions(+)';
      }
      if (args[0] === 'diff' && args[1] === '--cached' && args[2] === '--name-only') {
        return 'src/app.ts\n';
      }
      if (args[0] === 'commit') {
        return '[auto-claude/002-task abc123] feat: update 002-task';
      }
      if (args[0] === 'push') {
        return '';
      }
      if (args[0] === 'diff' && args[1] === '--stat') {
        return '1 file changed, 3 insertions(+)';
      }
      if (args[0] === 'log' && args[1] === '--oneline') {
        return 'abc123 feat: update 002-task';
      }
      if (args[0] === 'pr' && args[1] === 'create') {
        return 'https://github.com/example/repo/pull/123';
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    });

    const result = await createPR(baseConfig());

    expect(result).toEqual({
      success: true,
      prUrl: 'https://github.com/example/repo/pull/123',
      alreadyExists: false,
    });
    expect(mockGenerateCommitMessage).toHaveBeenCalledWith({
      projectDir: '/project',
      specName: '002-task',
      diffSummary: '1 file changed, 3 insertions(+)',
      filesChanged: ['src/app.ts'],
    });
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'feat: update 002-task'],
      expect.objectContaining({ cwd: '/project/.auto-claude/worktrees/tasks/002-task' }),
    );
  });
});
