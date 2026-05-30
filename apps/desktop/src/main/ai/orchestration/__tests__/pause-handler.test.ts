import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RATE_LIMIT_PAUSE_FILE,
  RESUME_FILE,
  waitForRateLimitResume,
  writeRateLimitPauseFile,
} from '../pause-handler';

describe('pause-handler', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createSpecDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'autocode-pause-handler-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('resumes all concurrent rate-limit waiters when one RESUME file is consumed', async () => {
    vi.useFakeTimers();
    const specDir = createSpecDir();
    writeRateLimitPauseFile(specDir, '429 too many requests', null);

    const waiters = [
      waitForRateLimitResume(specDir, 60_000),
      waitForRateLimitResume(specDir, 60_000),
    ];
    writeFileSync(join(specDir, RESUME_FILE), '', 'utf8');

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(Promise.all(waiters)).resolves.toEqual([true, true]);
    expect(existsSync(join(specDir, RESUME_FILE))).toBe(false);
    expect(existsSync(join(specDir, RATE_LIMIT_PAUSE_FILE))).toBe(false);
  });
});
