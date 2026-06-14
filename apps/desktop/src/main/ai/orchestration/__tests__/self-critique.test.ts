import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SELF_CRITIQUE_PATTERN_FILE_MAX_BYTES,
  readPatternFileSample,
  runSelfCritique,
} from '../self-critique';

describe('self-critique pattern loading', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'self-critique-project-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('samples large pattern files before critique', async () => {
    const patternFile = 'large-pattern.ts';
    const head = 'import { readFile } from "node:fs/promises";\n';
    const middle = 'MIDDLE_SENTINEL_SHOULD_NOT_BE_SAMPLED';
    const tail = '\nasync function loadPattern() { try { return true; } catch (error) { return false; } }\nTAIL_SENTINEL_SHOULD_BE_SAMPLED';
    const content = [
      head,
      'h'.repeat(2048),
      'm'.repeat(SELF_CRITIQUE_PATTERN_FILE_MAX_BYTES),
      middle,
      'n'.repeat(SELF_CRITIQUE_PATTERN_FILE_MAX_BYTES),
      tail,
    ].join('');

    await writeFile(join(projectDir, patternFile), content, 'utf-8');

    const sample = await readPatternFileSample(projectDir, patternFile);

    expect(sample.length).toBeLessThan(content.length);
    expect(sample).toContain('self-critique pattern sample truncated');
    expect(sample).toContain('import { readFile }');
    expect(sample).toContain('TAIL_SENTINEL_SHOULD_BE_SAMPLED');
    expect(sample).not.toContain(middle);
  });

  it('uses sampled pattern signals during critique', async () => {
    const patternFile = 'pattern.ts';
    const content = [
      'import { readFile } from "node:fs/promises";\n',
      'x'.repeat(SELF_CRITIQUE_PATTERN_FILE_MAX_BYTES * 2),
      '\nasync function loadPattern() { try { return true; } catch (error) { return false; } }\n',
    ].join('');
    await writeFile(join(projectDir, patternFile), content, 'utf-8');

    const result = await runSelfCritique({
      projectDir,
      specDir: join(projectDir, '.autocode', 'specs', '001-task'),
      generatedFiles: [{
        path: 'new-file.ts',
        content: 'async function load_pattern() { return Promise.resolve(true); }\n',
        isNew: true,
      }],
      subtask: {
        id: '1.1',
        description: 'Follow pattern file',
        patternFiles: [patternFile],
      },
    });

    const patternCheck = result.checks.find((check) => check.name === 'Pattern Adherence');
    expect(patternCheck?.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('Import style does not match pattern'),
      expect.stringContaining('Missing try-catch error handling'),
    ]));
  });
});
