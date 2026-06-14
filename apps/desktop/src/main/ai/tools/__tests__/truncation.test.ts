import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_OUTPUT_MAX_LINES } from '@autocode/core';

import { truncateToolOutput } from '../truncation';

describe('truncateToolOutput', () => {
  it('returns small output unchanged', () => {
    const result = truncateToolOutput('short output', 'Read', 'unused');

    expect(result).toEqual({
      content: 'short output',
      wasTruncated: false,
      originalSize: Buffer.byteLength('short output', 'utf-8'),
    });
  });

  it('writes full spillover output and returns a compact hint for large output', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'autocode-truncation-'));
    try {
      const output = Array.from({ length: 2100 }, (_, index) => `line-${index}`).join('\n');
      const result = truncateToolOutput(output, 'Tool.Name@v2', projectDir);

      expect(result.wasTruncated).toBe(true);
      expect(result.spilloverPath).toContain('Tool_Name_v2-');
      expect(result.content).toContain('[Output truncated:');
      expect(result.content).toContain(`showing ${TOOL_OUTPUT_MAX_LINES} preview lines from head/tail`);
      expect(result.content).toContain('line-0');
      expect(result.content).toContain('line-2099');
      expect(result.content).toContain('[Full output saved to:');
      expect(readFileSync(result.spilloverPath!, 'utf-8')).toBe(output);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
