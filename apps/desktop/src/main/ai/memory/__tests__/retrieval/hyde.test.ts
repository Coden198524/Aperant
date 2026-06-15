import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import type { EmbeddingService } from '../../embedding-service';
import { estimateTokens } from '../../retrieval/context-packer';
import { hydeSearch } from '../../retrieval/hyde';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

function makeEmbeddingService(): EmbeddingService {
  return {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  } as unknown as EmbeddingService;
}

describe('hydeSearch input compaction', () => {
  it('keeps localized HyDE prompts and generated documents within token budgets', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: [
        '假设记忆开头',
        '这是一段会显著增加 token 的中文 HyDE 生成文档。'.repeat(180),
        '假设记忆尾部',
      ].join(' '),
    } as Awaited<ReturnType<typeof generateText>>);
    const embeddingService = makeEmbeddingService();

    const result = await hydeSearch(
      [
        '查询开头',
        '这是一段会显著增加 token 的中文 HyDE 查询。'.repeat(120),
        '查询尾部',
      ].join(' '),
      embeddingService,
      {} as never,
    );

    expect(result).toEqual([0.1, 0.2, 0.3]);

    const prompt = vi.mocked(generateText).mock.calls[0]?.[0].prompt;
    expect(prompt).toContain('查询开头');
    expect(prompt).toContain('查询尾部');
    expect(prompt).toContain('[middle omitted]');
    expect(estimateTokens(String(prompt))).toBeLessThanOrEqual(210);

    const embeddedText = vi.mocked(embeddingService.embed).mock.calls[0]?.[0] as string;
    expect(embeddedText).toContain('假设记忆开头');
    expect(embeddedText).toContain('假设记忆尾部');
    expect(embeddedText).toContain('[middle omitted]');
    expect(embeddedText.length).toBeLessThanOrEqual(900);
    expect(estimateTokens(embeddedText)).toBeLessThanOrEqual(225);
  });

  it('embeds the compacted localized query when generation fails', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error('model unavailable'));
    const embeddingService = makeEmbeddingService();

    await hydeSearch(
      [
        '失败查询开头',
        '这是一段会显著增加 token 的中文 fallback 查询。'.repeat(120),
        '失败查询尾部',
      ].join(' '),
      embeddingService,
      {} as never,
    );

    const embeddedText = vi.mocked(embeddingService.embed).mock.calls[0]?.[0] as string;
    expect(embeddedText).toContain('失败查询开头');
    expect(embeddedText).toContain('失败查询尾部');
    expect(embeddedText).toContain('[middle omitted]');
    expect(embeddedText.length).toBeLessThanOrEqual(600);
    expect(estimateTokens(embeddedText)).toBeLessThanOrEqual(150);
  });
});
