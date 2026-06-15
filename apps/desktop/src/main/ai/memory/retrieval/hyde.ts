/**
 * HyDE (Hypothetical Document Embeddings) Fallback
 *
 * When a query returns sparse results, HyDE generates a hypothetical memory
 * that would perfectly answer the query, then embeds that hypothetical document
 * instead of the raw query. This improves retrieval for underspecified queries.
 *
 * Reference: "Precise Zero-Shot Dense Retrieval without Relevance Labels"
 * (Gao et al., 2022)
 */

import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { foldRepeatedAutocodePromptLines } from '@autocode/core/runtime/prompt-context';
import type { EmbeddingService } from '../embedding-service';
import { estimateTokens } from './context-packer';

const MAX_HYDE_QUERY_CHARS = 600;
const MAX_HYDE_QUERY_TOKENS = 150;
const MAX_HYDE_DOCUMENT_CHARS = 900;
const MAX_HYDE_DOCUMENT_TOKENS = 225;

/**
 * Generate a hypothetical memory embedding for a query using HyDE.
 *
 * @param query - The search query
 * @param embeddingService - Service for computing the final embedding
 * @param model - Language model for generating hypothetical document
 * @returns 1024-dim embedding of the hypothetical document
 */
export async function hydeSearch(
  query: string,
  embeddingService: EmbeddingService,
  model: LanguageModel,
): Promise<number[]> {
  const compactQuery = compactHydeText(
    query,
    MAX_HYDE_QUERY_CHARS,
    MAX_HYDE_QUERY_TOKENS,
  );

  try {
    const { text } = await generateText({
      model,
      prompt: `Write a 2-sentence factual memory entry that would answer this query: "${compactQuery}"

Focus on code, architecture, or development patterns.`,
      maxOutputTokens: 100,
    });

    // Embed the hypothetical document
    return embeddingService.embed(
      compactHydeText(
        text.trim() || compactQuery,
        MAX_HYDE_DOCUMENT_CHARS,
        MAX_HYDE_DOCUMENT_TOKENS,
      ),
      1024,
    );
  } catch {
    // If generation fails, fall back to embedding the original query
    return embeddingService.embed(compactQuery, 1024);
  }
}

function compactHydeText(text: string, maxChars: number, maxTokens: number): string {
  if (maxChars <= 0 || maxTokens <= 0) {
    return '';
  }
  const compact = foldRepeatedAutocodePromptLines(text).replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars && estimateTokens(compact) <= maxTokens) {
    return compact;
  }

  const charBounded = compactHydeTextByChars(compact, maxChars);
  if (estimateTokens(charBounded) <= maxTokens) {
    return charBounded;
  }

  let best = '';
  let low = 1;
  let high = Math.min(maxChars, compact.length);
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = compactHydeTextByChars(compact, midpoint);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function compactHydeTextByChars(compact: string, maxChars: number): string {
  if (maxChars <= 0 || compact.length <= maxChars) {
    return compact.slice(0, Math.max(0, maxChars));
  }
  if (maxChars <= 3) {
    return compact.slice(0, maxChars);
  }

  const marker = ' ... [middle omitted] ... ';
  const effectiveMarker = maxChars <= marker.length + 24 ? '...' : marker;
  const budget = maxChars - effectiveMarker.length;
  const headBudget = Math.ceil(budget * 0.62);
  const tailBudget = Math.max(0, budget - headBudget);
  return `${compact.slice(0, headBudget).trimEnd()}${effectiveMarker}${compact.slice(-tailBudget).trimStart()}`;
}
