/**
 * Cross-Encoder Reranker
 *
 * Provider auto-detection priority:
 *   1. Ollama — Qwen3-Reranker-0.6B (local, zero cost)
 *   2. Cohere — rerank-v3.5 (~$1/1K queries)
 *   3. None — passthrough (position-based scoring)
 *
 * Gracefully degrades to passthrough if neither provider is available.
 */

const OLLAMA_BASE_URL = 'http://localhost:11434';
const COHERE_RERANK_URL = 'https://api.cohere.com/v2/rerank';
const QWEN3_RERANKER_MODEL = 'qwen3-reranker:0.6b';
const MAX_RERANK_QUERY_CHARS = 300;
const MAX_RERANK_DOCUMENT_CHARS = 1200;

export type RerankerProvider = 'ollama' | 'cohere' | 'none';

export interface RerankerCandidate {
  memoryId: string;
  content: string;
}

export interface RerankerResult {
  memoryId: string;
  score: number;
}

export class Reranker {
  private provider: RerankerProvider;

  constructor(provider?: RerankerProvider) {
    this.provider = provider ?? 'none';
  }

  /**
   * Auto-detect and initialize the best available reranker provider.
   * Call once before using rerank().
   */
  async initialize(): Promise<void> {
    // Check Ollama for Qwen3-Reranker-0.6B
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const data = (await response.json()) as { models: Array<{ name: string }> };
        const hasReranker = data.models.some((m) =>
          m.name.startsWith(QWEN3_RERANKER_MODEL),
        );
        if (hasReranker) {
          this.provider = 'ollama';
          return;
        }
      }
    } catch {
      // Ollama not available
    }

    // Check for Cohere API key
    if (process.env.COHERE_API_KEY) {
      this.provider = 'cohere';
      return;
    }

    this.provider = 'none';
  }

  getProvider(): RerankerProvider {
    return this.provider;
  }

  /**
   * Rerank candidates using cross-encoder scoring.
   * Falls back to passthrough (positional scoring) if provider is 'none'.
   *
   * @param query - The original search query
   * @param candidates - Candidates to rerank with their content
   * @param topK - Number of top results to return
   */
  async rerank(
    query: string,
    candidates: RerankerCandidate[],
    topK: number = 8,
  ): Promise<RerankerResult[]> {
    const boundedTopK = Math.max(0, topK);
    if (boundedTopK === 0 || candidates.length === 0) {
      return [];
    }
    if (this.provider === 'none' || candidates.length <= boundedTopK) {
      return candidates
        .slice(0, boundedTopK)
        .map((c, i) => ({
          memoryId: c.memoryId,
          score: 1 - i / Math.max(candidates.length, 1),
        }));
    }

    const compactQuery = compactRerankerText(query, MAX_RERANK_QUERY_CHARS, { preserveTail: true });
    const compactCandidates = compactRerankerCandidates(candidates);
    if (this.provider === 'ollama') {
      return this.rerankOllama(compactQuery, compactCandidates, boundedTopK);
    }

    return this.rerankCohere(compactQuery, compactCandidates, boundedTopK);
  }

  // ============================================================
  // PRIVATE: OLLAMA RERANKER
  // ============================================================

  /**
   * Rerank using Qwen3-Reranker-0.6B via Ollama.
   *
   * Qwen3-Reranker uses a specific prompt format:
   *   "<|im_start|>system\nJudge the relevance...<|im_end|>\n
   *    <|im_start|>user\nQuery: ...\nDocument: ...<|im_end|>\n
   *    <|im_start|>assistant\n<think>\n"
   *
   * We approximate reranking by computing embeddings for (query, doc) pairs
   * and scoring based on the embedding similarity. A true cross-encoder would
   * use the model's classification head — this is a pragmatic approximation.
   */
  private async rerankOllama(
    query: string,
    candidates: RerankerCandidate[],
    topK: number,
  ): Promise<RerankerResult[]> {
    const scored: RerankerResult[] = [];

    await Promise.allSettled(
      candidates.map(async (candidate, fallbackRank) => {
        try {
          const prompt = buildQwen3RerankerPrompt(query, candidate.content);
          const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: QWEN3_RERANKER_MODEL, prompt }),
            signal: AbortSignal.timeout(5000),
          });

          if (!response.ok) {
            scored.push({
              memoryId: candidate.memoryId,
              score: 1 - fallbackRank / candidates.length,
            });
            return;
          }

          const data = (await response.json()) as { embedding: number[] };
          // Use L2 norm of the embedding as a relevance proxy
          // (higher norm from the relevance prompt = more confident match)
          const norm = Math.sqrt(
            data.embedding.reduce((s, v) => s + v * v, 0),
          );
          scored.push({ memoryId: candidate.memoryId, score: norm });
        } catch {
          scored.push({
            memoryId: candidate.memoryId,
            score: 1 - fallbackRank / candidates.length,
          });
        }
      }),
    );

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  // ============================================================
  // PRIVATE: COHERE RERANKER
  // ============================================================

  /**
   * Rerank using Cohere rerank-v3.5.
   * Cost: ~$1 per 1000 search queries.
   */
  private async rerankCohere(
    query: string,
    candidates: RerankerCandidate[],
    topK: number,
  ): Promise<RerankerResult[]> {
    const cohereKey = process.env.COHERE_API_KEY;
    if (!cohereKey) {
      return this.passthroughRerank(candidates, topK);
    }

    try {
      const response = await fetch(COHERE_RERANK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cohereKey}`,
        },
        body: JSON.stringify({
          model: 'rerank-v3.5',
          query,
          documents: candidates.map((c) => c.content),
          top_n: topK,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return this.passthroughRerank(candidates, topK);
      }

      const data = (await response.json()) as {
        results: Array<{ index: number; relevance_score: number }>;
      };

      return data.results.map((r) => ({
        memoryId: candidates[r.index].memoryId,
        score: r.relevance_score,
      }));
    } catch {
      return this.passthroughRerank(candidates, topK);
    }
  }

  private passthroughRerank(
    candidates: RerankerCandidate[],
    topK: number,
  ): RerankerResult[] {
    return candidates
      .slice(0, topK)
      .map((c, i) => ({
        memoryId: c.memoryId,
        score: 1 - i / Math.max(candidates.length, 1),
      }));
  }
}

// ============================================================
// PROMPT HELPERS
// ============================================================

function compactRerankerCandidates(candidates: RerankerCandidate[]): RerankerCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    content: compactRerankerText(candidate.content, MAX_RERANK_DOCUMENT_CHARS, { preserveTail: true }),
  }));
}

function buildQwen3RerankerPrompt(query: string, document: string): string {
  return [
    '<|im_start|>system',
    'Judge document relevance to the query. Answer "yes" or "no".',
    '<|im_end|>',
    '<|im_start|>user',
    `Query: ${query}`,
    `Document: ${document}`,
    '<|im_end|>',
    '<|im_start|>assistant',
    '<think>',
  ].join('\n');
}

function compactRerankerText(
  text: string,
  maxChars: number,
  options: { preserveTail?: boolean } = {},
): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  if (!options.preserveTail) {
    return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  const marker = ' ... [middle omitted] ... ';
  if (maxChars <= marker.length + 24) {
    return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }
  const budget = maxChars - marker.length;
  const headBudget = Math.ceil(budget * 0.62);
  const tailBudget = Math.max(0, budget - headBudget);
  return `${compact.slice(0, headBudget).trimEnd()}${marker}${compact.slice(-tailBudget).trimStart()}`;
}
