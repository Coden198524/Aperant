import { describe, expect, it } from 'vitest';
import type { FileNode } from '../../../shared/types/project';
import { buildVisibleTaskFiles } from './TaskFiles';

function file(name: string): FileNode {
  return {
    name,
    path: `C:\\spec\\${name}`,
    isDirectory: false,
  };
}

describe('TaskFiles artifact selection', () => {
  it('shows the latest failed design as design.md when the canonical file is missing', () => {
    const files = buildVisibleTaskFiles([
      file('spec.md'),
      file('design.md.failed-20260712110000'),
      file('design.md.failed-20260712120000'),
      file('task_logs.jsonl'),
    ]);
    const design = files.find(item => item.canonicalName === 'design.md');

    expect(design).toMatchObject({
      name: 'design.md.failed-20260712120000',
      canonicalName: 'design.md',
      isFailedArtifact: true,
    });
    expect(files.map(item => item.canonicalName)).toEqual([
      'spec.md',
      'design.md',
      'task_logs.jsonl',
    ]);
  });

  it('prefers the canonical design and hides failed backups when both exist', () => {
    const files = buildVisibleTaskFiles([
      file('design.md.failed-20260712120000'),
      file('design.md'),
    ]);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      name: 'design.md',
      canonicalName: 'design.md',
      isFailedArtifact: false,
    });
  });

  it('continues to hide internal runner artifacts and directories', () => {
    const files = buildVisibleTaskFiles([
      file('autocode-run-prompt.md'),
      file('autocode-run-prompt.md.failed-20260712120000'),
      { name: 'nested', path: 'C:\\spec\\nested', isDirectory: true },
      file('requirements.md'),
    ]);

    expect(files.map(item => item.canonicalName)).toEqual(['requirements.md']);
  });
});
