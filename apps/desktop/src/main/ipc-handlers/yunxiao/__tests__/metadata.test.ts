import { describe, expect, it } from 'vitest';
import { buildYunxiaoTaskMetadata } from '../metadata';

describe('buildYunxiaoTaskMetadata', () => {
  it('defaults imported Yunxiao tasks to require review before coding', () => {
    const metadata = buildYunxiaoTaskMetadata({
      workItemId: '123',
      identifier: 'PROJ-123',
      url: 'https://example.com/work-item/123'
    });

    expect(metadata.sourceType).toBe('yunxiao');
    expect(metadata.yunxiaoWorkItemId).toBe('123');
    expect(metadata.yunxiaoIdentifier).toBe('PROJ-123');
    expect(metadata.requireReviewBeforeCoding).toBe(true);
  });
});
