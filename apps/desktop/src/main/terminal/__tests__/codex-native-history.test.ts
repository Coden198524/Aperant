import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCodexNativeHistoryCacheForTests,
  CODEX_SESSION_PREVIEW_BYTES,
  getCodexNativeHistory,
  readCodexSessionPreview,
} from '../codex-native-history';

const SESSION_ID = '019fa0c4-14c3-7931-9a4d-807927dda6be';
const OTHER_SESSION_ID = '019fa0c4-14c3-7931-9a4d-807927dda6bf';

let testRoot: string | undefined;

function createTestRoot(): string {
  testRoot = mkdtempSync(join(tmpdir(), 'autocode-codex-history-'));
  return testRoot;
}

function writeJsonLines(filePath: string, records: unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

function writeSession(
  root: string,
  id: string,
  projectPath: string,
  firstText: string,
): string {
  const filePath = join(
    root,
    'sessions',
    '2026',
    '07',
    '29',
    `rollout-2026-07-29T12-00-00-${id}.jsonl`,
  );
  writeJsonLines(filePath, [
    {
      type: 'session_meta',
      payload: {
        id,
        timestamp: '2026-07-29T12:00:00.000Z',
        cwd: projectPath,
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: firstText }],
      },
    },
  ]);
  return filePath;
}

afterEach(() => {
  clearCodexNativeHistoryCacheForTests();
  if (testRoot) {
    rmSync(testRoot, { recursive: true, force: true });
    testRoot = undefined;
  }
});

describe('Codex native history', () => {
  it('reads only a bounded preview from a logically huge rollout file', async () => {
    const root = createTestRoot();
    const sessionPath = writeSession(root, SESSION_ID, 'E:\\Work\\Aperant', 'Bounded history');

    // Extending creates a sparse logical file on supported filesystems. The
    // regression is independent of sparse support because the reader reports
    // exactly how many bytes it consumed.
    truncateSync(sessionPath, 512 * 1024 * 1024);

    const preview = await readCodexSessionPreview(sessionPath);

    expect(preview).toMatchObject({
      id: SESSION_ID,
      projectPath: 'E:\\Work\\Aperant',
    });
    expect(preview?.bytesRead).toBeLessThanOrEqual(CODEX_SESSION_PREVIEW_BYTES);
  });

  it('filters by project and keeps the newest matching sessions', async () => {
    const root = createTestRoot();
    writeSession(root, SESSION_ID, 'E:\\Work\\Aperant', 'Implement Spec mode');
    writeSession(root, OTHER_SESSION_ID, 'E:\\Work\\Elsewhere', 'Unrelated session');
    writeJsonLines(join(root, 'session_index.jsonl'), [
      {
        id: SESSION_ID,
        thread_name: 'Indexed title',
        updated_at: '2026-07-29T12:00:00.000Z',
      },
      {
        id: OTHER_SESSION_ID,
        thread_name: 'Other title',
        updated_at: '2026-07-29T11:00:00.000Z',
      },
    ]);

    const history = await getCodexNativeHistory('E:\\Work\\Aperant', {
      codexRoot: root,
      useCache: false,
    });

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: SESSION_ID,
      cli: 'codex',
      title: 'Indexed title',
      projectPath: 'E:\\Work\\Aperant',
    });
  });

  it('deduplicates concurrent scans through the shared cache', async () => {
    const root = createTestRoot();
    writeSession(root, SESSION_ID, 'E:\\Work\\Aperant', 'Cached session');

    const [first, second] = await Promise.all([
      getCodexNativeHistory('E:\\Work\\Aperant', { codexRoot: root }),
      getCodexNativeHistory('E:\\Work\\Aperant', { codexRoot: root }),
    ]);

    expect(first).toEqual(second);
    expect(first.map((session) => session.id)).toEqual([SESSION_ID]);
  });
});
