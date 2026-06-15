/**
 * EmbeddingService
 *
 * Five-tier provider auto-detection:
 *   1. qwen3-embedding:8b via Ollama (>32GB RAM)
 *   2. qwen3-embedding:4b via Ollama (recommended default)
 *   3. qwen3-embedding:0.6b via Ollama (low-memory)
 *   4. Any other Ollama embedding model (nomic-embed-text, all-minilm, bge-*, etc.)
 *   5. Degraded hash-based fallback (no semantic similarity — install Ollama model to improve)
 *
 * Uses contextual embeddings: file/module context prepended to every embed call.
 * Supports MRL (Matryoshka) dimensions: 256-dim for candidate gen, 1024-dim for storage.
 * Caches embeddings in the embedding_cache table with 7-day TTL.
 */

import { createHash } from 'crypto';
import type { Client } from '@libsql/client';
import { embed, embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAzure } from '@ai-sdk/azure';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Memory } from '@autocode/core';
import type { MemoryEmbeddingProvider } from '../../../shared/types/project';
import {
  stripLowValueContextCostMemoryLines,
  stripLowValueMemoryLines,
} from './outcome-content';

// ============================================================
// TYPES
// ============================================================

export type EmbeddingProvider =
  | 'openai' | 'google' | 'azure' | 'voyage'
  | 'ollama-8b' | 'ollama-4b' | 'ollama-0.6b' | 'ollama-generic'
  | 'none';

export interface EmbeddingConfig {
  provider?: MemoryEmbeddingProvider;
  openaiApiKey?: string;
  openaiEmbeddingModel?: string;
  googleApiKey?: string;
  googleEmbeddingModel?: string;
  azureApiKey?: string;
  azureBaseUrl?: string;
  azureDeployment?: string;
  voyageApiKey?: string;
  voyageModel?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
}

/** Contextual text prefix for AST chunks before embedding */
export interface ASTChunk {
  content: string;
  filePath: string;
  language: string;
  chunkType: 'function' | 'class' | 'module' | 'prose';
  startLine: number;
  endLine: number;
  name?: string;
  contextPrefix: string;
}

// ============================================================
// CONTEXTUAL TEXT BUILDERS (exported for use by other modules)
// ============================================================

const MEMORY_CONTEXTUAL_FILE_LIMIT = 8;

/**
 * Build contextual text for an AST chunk before embedding.
 * Prepends file/chunk context to improve retrieval quality.
 */
export function buildContextualText(chunk: ASTChunk): string {
  const prefix = [
    `File: ${chunk.filePath}`,
    chunk.chunkType !== 'module' ? `${chunk.chunkType}: ${chunk.name ?? 'unknown'}` : null,
    `Lines: ${chunk.startLine}-${chunk.endLine}`,
  ]
    .filter(Boolean)
    .join(' | ');

  return `${prefix}\n\n${chunk.content}`;
}

/**
 * Build contextual text for a memory entry before embedding.
 * Prepends file/module/type context to improve retrieval quality.
 */
export function buildMemoryContextualText(memory: Memory): string {
  const relatedFiles = uniqueContextualFilePaths(memory.relatedFiles).slice(0, MEMORY_CONTEXTUAL_FILE_LIMIT);
  const primaryModule = uniqueContextualTextItems(memory.relatedModules)[0];
  const content = getMemoryContentForEmbedding(memory);
  const parts = [
    relatedFiles.length > 0 ? `Files: ${formatCompactContextualPathList(relatedFiles)}` : null,
    primaryModule ? `Module: ${primaryModule}` : null,
    `Type: ${memory.type}`,
  ]
    .filter(Boolean)
    .join(' | ');

  return parts ? `${parts}\n\n${content}` : content;
}

function getMemoryContentForEmbedding(memory: Memory): string {
  return memory.type === 'context_cost'
    ? stripLowValueContextCostMemoryLines(memory.content)
    : stripLowValueMemoryLines(memory.content);
}

function uniqueContextualFilePaths(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const value of values) {
    const normalized = normalizeContextualFilePath(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    files.push(normalized);
  }
  return files;
}

function normalizeContextualFilePath(value: string): string {
  let normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized.replace(/\/$/, '');
}

function formatCompactContextualPathList(paths: readonly string[]): string {
  const expanded = paths.join(', ');
  if (paths.length < 2) {
    return expanded;
  }

  const segments = paths.map(splitContextualPath);
  if (segments.some((parts) => parts.length < 2)) {
    return expanded;
  }

  const maxCommonDepth = Math.min(...segments.map((parts) => parts.length - 1));
  let commonDepth = 0;
  for (let index = 0; index < maxCommonDepth; index += 1) {
    const segment = segments[0][index].toLowerCase();
    if (!segments.every((parts) => parts[index].toLowerCase() === segment)) {
      break;
    }
    commonDepth += 1;
  }

  if (commonDepth < 2) {
    return expanded;
  }

  const commonDir = segments[0].slice(0, commonDepth).join('/');
  const tails = segments.map((parts) => parts.slice(commonDepth).join('/'));
  const compact = `${commonDir}/{${tails.join(', ')}}`;
  return compact.length < expanded.length ? compact : expanded;
}

function splitContextualPath(path: string): string[] {
  return normalizeContextualFilePath(path).split('/').filter(Boolean);
}

function uniqueContextualTextItems(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, ' ').trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(normalized);
  }
  return items;
}

// ============================================================
// SERIALIZATION HELPERS
// ============================================================

function serializeEmbedding(embedding: number[]): Buffer {
  const buf = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buf.writeFloatLE(embedding[i], i * 4);
  }
  return buf;
}

function deserializeEmbedding(buf: ArrayBuffer | Buffer | Uint8Array): number[] {
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as ArrayBuffer);
  const result: number[] = [];
  for (let i = 0; i < view.length; i += 4) {
    result.push(view.readFloatLE(i));
  }
  return result;
}

// ============================================================
// EMBEDDING CACHE
// ============================================================

class EmbeddingCache {
  private readonly db: Client;
  private readonly TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor(db: Client) {
    this.db = db;
  }

  private cacheKey(text: string, modelId: string, dims: number): string {
    return createHash('sha256').update(`${text}:${modelId}:${dims}`).digest('hex');
  }

  async get(text: string, modelId: string, dims: number): Promise<number[] | null> {
    try {
      const key = this.cacheKey(text, modelId, dims);
      const result = await this.db.execute({
        sql: 'SELECT embedding FROM embedding_cache WHERE key = ? AND expires_at > ?',
        args: [key, Date.now()],
      });
      if (result.rows.length === 0) return null;
      const rawEmbedding = result.rows[0].embedding;
      if (!rawEmbedding) return null;
      return deserializeEmbedding(rawEmbedding as ArrayBuffer);
    } catch {
      return null;
    }
  }

  async set(text: string, modelId: string, dims: number, embedding: number[]): Promise<void> {
    try {
      const key = this.cacheKey(text, modelId, dims);
      const expiresAt = Date.now() + this.TTL_MS;
      await this.db.execute({
        sql: 'INSERT OR REPLACE INTO embedding_cache (key, embedding, model_id, dims, expires_at) VALUES (?, ?, ?, ?, ?)',
        args: [key, serializeEmbedding(embedding), modelId, dims, expiresAt],
      });
    } catch {
      // Cache write failure is non-fatal
    }
  }

  async purgeExpired(): Promise<void> {
    try {
      await this.db.execute({
        sql: 'DELETE FROM embedding_cache WHERE expires_at <= ?',
        args: [Date.now()],
      });
    } catch {
      // Non-fatal
    }
  }
}

// ============================================================
// OLLAMA PROVIDER
// ============================================================

const OLLAMA_BASE_URL = 'http://localhost:11434';

interface OllamaTagsResponse {
  models: Array<{ name: string }>;
}

async function checkOllamaAvailable(baseUrl = OLLAMA_BASE_URL): Promise<OllamaTagsResponse | null> {
  try {
    // CodeQL: file data in outbound request - validate baseUrl is a string pointing to localhost
    const safeBaseUrl = typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : OLLAMA_BASE_URL;
    const response = await fetch(`${safeBaseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    return (await response.json()) as OllamaTagsResponse;
  } catch {
    return null;
  }
}

async function getSystemRamGb(): Promise<number> {
  try {
    // Node.js os.totalmem() returns bytes
    const { totalmem } = await import('os');
    return totalmem() / (1024 * 1024 * 1024);
  } catch {
    return 0;
  }
}

async function ollamaEmbed(model: string, text: string, baseUrl = OLLAMA_BASE_URL): Promise<number[]> {
  // CodeQL: file data in outbound request - validate model name and baseUrl from config are strings
  const safeBaseUrl = typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : OLLAMA_BASE_URL;
  const safeModel = typeof model === 'string' && model.length > 0 ? model : '';
  const response = await fetch(`${safeBaseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: safeModel, prompt: text }),
  });
  if (!response.ok) {
    throw new Error(`Ollama embed failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as { embedding: number[] };
  return data.embedding;
}

async function ollamaEmbedBatch(model: string, texts: string[], baseUrl = OLLAMA_BASE_URL): Promise<number[][]> {
  // Ollama doesn't have native batch API — run concurrently
  return Promise.all(texts.map((text) => ollamaEmbed(model, text, baseUrl)));
}

// ============================================================
// MRL TRUNCATION
// ============================================================

/**
 * Truncate an embedding to a target dimension.
 * For Qwen3 MRL models, the first N dimensions preserve most of the information.
 */
function truncateToDim(embedding: number[], targetDim: number): number[] {
  if (embedding.length <= targetDim) return embedding;
  // L2-normalize the truncated slice per MRL spec
  const slice = embedding.slice(0, targetDim);
  const norm = Math.sqrt(slice.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return slice;
  return slice.map((v) => v / norm);
}

// ============================================================
// EMBEDDING SERVICE
// ============================================================

export class EmbeddingService {
  private provider: EmbeddingProvider = 'none';
  private readonly cache: EmbeddingCache;
  private ollamaModel = 'qwen3-embedding:4b';
  private initialized = false;
  private readonly config: EmbeddingConfig | undefined;

  constructor(dbClient: Client, config?: EmbeddingConfig) {
    this.cache = new EmbeddingCache(dbClient);
    this.config = config;
  }

  /**
   * Auto-detect the best available embedding provider.
   * Priority: configured cloud provider > Ollama (RAM-based model selection) > hash fallback
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // If a cloud provider is configured with its required API key, use it directly
    if (this.config?.provider) {
      const p = this.config.provider;
      if (p === 'openai' && this.config.openaiApiKey) {
        this.provider = 'openai';
        return;
      }
      if (p === 'google' && this.config.googleApiKey) {
        this.provider = 'google';
        return;
      }
      if (p === 'azure_openai' && this.config.azureApiKey && this.config.azureDeployment) {
        this.provider = 'azure';
        return;
      }
      if (p === 'voyage' && this.config.voyageApiKey) {
        this.provider = 'voyage';
        return;
      }
      // If config.provider === 'ollama', fall through to Ollama auto-detect below
    }

    // Ollama auto-detection
    const ollamaBaseUrl = this.config?.ollamaBaseUrl ?? OLLAMA_BASE_URL;
    const ollamaTags = await checkOllamaAvailable(ollamaBaseUrl);
    if (ollamaTags) {
      const modelNames = ollamaTags.models.map((m) => m.name);

      // If a specific Ollama model is configured, use it directly
      if (this.config?.ollamaModel) {
        const configuredModel = this.config.ollamaModel;
        if (modelNames.some((n) => n === configuredModel || n.startsWith(`${configuredModel}:`))) {
          this.provider = 'ollama-generic';
          this.ollamaModel = configuredModel;
          return;
        }
      }

      const ramGb = await getSystemRamGb();

      if (ramGb > 32 && modelNames.some((n) => n.startsWith('qwen3-embedding:8b'))) {
        this.provider = 'ollama-8b';
        this.ollamaModel = 'qwen3-embedding:8b';
        return;
      }

      if (modelNames.some((n) => n.startsWith('qwen3-embedding:4b'))) {
        this.provider = 'ollama-4b';
        this.ollamaModel = 'qwen3-embedding:4b';
        return;
      }

      if (modelNames.some((n) => n.startsWith('qwen3-embedding:0.6b'))) {
        this.provider = 'ollama-0.6b';
        this.ollamaModel = 'qwen3-embedding:0.6b';
        return;
      }

      // Check for any other embedding model on Ollama
      const embeddingModels = modelNames.filter(
        (n) => n.includes('embed') || n.includes('minilm') || n.includes('bge'),
      );
      if (embeddingModels.length > 0) {
        this.provider = 'ollama-generic';
        this.ollamaModel = embeddingModels[0];
        return;
      }
    }

    // Final fallback: degraded hash-based embeddings (no semantic similarity)
    this.provider = 'none';
  }

  getProvider(): EmbeddingProvider {
    return this.provider;
  }

  /**
   * Embed a single text string.
   * Checks cache first; writes to cache on miss.
   *
   * @param text - The text to embed (should already be contextually formatted)
   * @param dims - Target dimension: 256 for Stage 1 candidate gen, 1024 for storage (default)
   */
  async embed(text: string, dims: 256 | 1024 = 1024): Promise<number[]> {
    const modelId = this.getModelId(dims);

    // Check cache
    const cached = await this.cache.get(text, modelId, dims);
    if (cached) return cached;

    const embedding = await this.computeEmbed(text, dims);

    await this.cache.set(text, modelId, dims, embedding);
    return embedding;
  }

  /**
   * Embed multiple texts in batch (for promotion-time bulk embeds).
   *
   * @param texts - Array of texts to embed
   * @param dims - Target dimension (default: 1024)
   */
  async embedBatch(texts: string[], dims: 256 | 1024 = 1024): Promise<number[][]> {
    if (texts.length === 0) return [];

    const modelId = this.getModelId(dims);

    // Check cache for all texts
    const results: (number[] | null)[] = await Promise.all(
      texts.map((text) => this.cache.get(text, modelId, dims)),
    );

    // Identify cache misses
    const missIndices: number[] = [];
    const missTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (results[i] === null) {
        missIndices.push(i);
        missTexts.push(texts[i]);
      }
    }

    if (missTexts.length > 0) {
      const freshEmbeddings = await this.computeEmbedBatch(missTexts, dims);

      // Store in cache and fill results
      await Promise.all(
        missTexts.map((text, i) => this.cache.set(text, modelId, dims, freshEmbeddings[i])),
      );

      for (let i = 0; i < missIndices.length; i++) {
        results[missIndices[i]] = freshEmbeddings[i];
      }
    }

    return results as number[][];
  }

  /**
   * Embed a memory using contextual text (file/module/type context prepended).
   * Always uses 1024-dim for storage quality.
   */
  async embedMemory(memory: Memory): Promise<number[]> {
    const contextualText = buildMemoryContextualText(memory);
    return this.embed(contextualText, 1024);
  }

  /**
   * Embed an AST chunk using contextual text.
   * Always uses 1024-dim for storage quality.
   */
  async embedChunk(chunk: ASTChunk): Promise<number[]> {
    const contextualText = buildContextualText(chunk);
    return this.embed(contextualText, 1024);
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private getModelId(dims: 256 | 1024): string {
    switch (this.provider) {
      case 'openai':
        return `openai:${this.config?.openaiEmbeddingModel ?? 'text-embedding-3-small'}-d${dims}`;
      case 'google':
        return `google:${this.config?.googleEmbeddingModel ?? 'gemini-embedding-001'}-d${dims}`;
      case 'azure':
        return `azure:${this.config?.azureDeployment}-d${dims}`;
      case 'voyage':
        return `voyage:${this.config?.voyageModel ?? 'voyage-3'}-d${dims}`;
      case 'ollama-8b':
        return `qwen3-embedding:8b-d${dims}`;
      case 'ollama-4b':
        return `qwen3-embedding:4b-d${dims}`;
      case 'ollama-0.6b':
        return `qwen3-embedding:0.6b-d${dims}`;
      case 'ollama-generic':
        return `${this.ollamaModel}-d${dims}`;
      case 'none':
        return 'none-degraded';
    }
  }

  private createEmbeddingModel() {
    const config = this.config;
    switch (this.provider) {
      case 'openai': {
        if (!config?.openaiApiKey) {
          throw new Error('OpenAI embedding provider selected without an API key.');
        }
        const openai = createOpenAI({ apiKey: config.openaiApiKey });
        return openai.embedding(config.openaiEmbeddingModel ?? 'text-embedding-3-small');
      }
      case 'google': {
        if (!config?.googleApiKey) {
          throw new Error('Google embedding provider selected without an API key.');
        }
        const google = createGoogleGenerativeAI({ apiKey: config.googleApiKey });
        return google.embedding(config.googleEmbeddingModel ?? 'gemini-embedding-001');
      }
      case 'azure': {
        if (!config?.azureApiKey || !config.azureDeployment) {
          throw new Error('Azure embedding provider selected without required deployment configuration.');
        }
        const azure = createAzure({ apiKey: config.azureApiKey, baseURL: config.azureBaseUrl });
        return azure.embedding(config.azureDeployment);
      }
      case 'voyage': {
        if (!config?.voyageApiKey) {
          throw new Error('Voyage embedding provider selected without an API key.');
        }
        const voyage = createOpenAICompatible({
          name: 'voyage',
          apiKey: config.voyageApiKey,
          baseURL: 'https://api.voyageai.com/v1',
        });
        return voyage.textEmbeddingModel(config.voyageModel ?? 'voyage-3');
      }
      default:
        return undefined;
    }
  }

  private requireEmbeddingModel() {
    const model = this.createEmbeddingModel();
    if (!model) {
      throw new Error(`No embedding model available for provider ${this.provider}.`);
    }
    return model;
  }

  private async computeEmbed(text: string, dims: 256 | 1024): Promise<number[]> {
    switch (this.provider) {
      case 'openai':
      case 'azure': {
        const model = this.requireEmbeddingModel();
        const { embedding } = await embed({
          model,
          value: text,
          providerOptions: { openai: { dimensions: dims } },
        });
        return embedding;
      }
      case 'google': {
        const model = this.requireEmbeddingModel();
        const { embedding } = await embed({
          model,
          value: text,
          providerOptions: { google: { outputDimensionality: dims } },
        });
        return embedding;
      }
      case 'voyage': {
        const model = this.requireEmbeddingModel();
        const { embedding } = await embed({ model, value: text });
        return dims === 256 ? truncateToDim(embedding, 256) : embedding;
      }

      case 'ollama-8b':
      case 'ollama-4b':
      case 'ollama-0.6b':
      case 'ollama-generic': {
        const ollamaBaseUrl = this.config?.ollamaBaseUrl ?? OLLAMA_BASE_URL;
        const raw = await ollamaEmbed(this.ollamaModel, text, ollamaBaseUrl);
        return dims === 256 ? truncateToDim(raw, 256) : raw;
      }

      case 'none': {
        return this.degradedEmbed(text, dims);
      }
    }
  }

  private async computeEmbedBatch(texts: string[], dims: 256 | 1024): Promise<number[][]> {
    switch (this.provider) {
      case 'openai':
      case 'azure': {
        const model = this.requireEmbeddingModel();
        const { embeddings } = await embedMany({
          model,
          values: texts,
          providerOptions: { openai: { dimensions: dims } },
        });
        return embeddings;
      }
      case 'google': {
        const model = this.requireEmbeddingModel();
        const { embeddings } = await embedMany({
          model,
          values: texts,
          providerOptions: { google: { outputDimensionality: dims } },
        });
        return embeddings;
      }
      case 'voyage': {
        const model = this.requireEmbeddingModel();
        const { embeddings } = await embedMany({ model, values: texts });
        return dims === 256 ? embeddings.map((e) => truncateToDim(e, 256)) : embeddings;
      }

      case 'ollama-8b':
      case 'ollama-4b':
      case 'ollama-0.6b':
      case 'ollama-generic': {
        const ollamaBaseUrl = this.config?.ollamaBaseUrl ?? OLLAMA_BASE_URL;
        const raws = await ollamaEmbedBatch(this.ollamaModel, texts, ollamaBaseUrl);
        return dims === 256 ? raws.map((r) => truncateToDim(r, 256)) : raws;
      }

      case 'none': {
        return Promise.all(texts.map((t) => this.degradedEmbed(t, dims)));
      }
    }
  }

  private degradedEmbedWarned = false;

  /**
   * Degraded fallback that returns deterministic hash-based pseudo-embeddings.
   * NOT suitable for semantic search — similar texts will NOT have similar embeddings.
   * Users should install an Ollama embedding model or set OPENAI_API_KEY for real search.
   */
  private degradedEmbed(text: string, dims: 256 | 1024 = 1024): number[] {
    if (!this.degradedEmbedWarned) {
      console.warn(
        '[EmbeddingService] No embedding provider available. ' +
          'Install Ollama with an embedding model (e.g., `ollama pull nomic-embed-text`) ' +
          'for semantic search. Using hash-based fallback (no semantic similarity).',
      );
      this.degradedEmbedWarned = true;
    }
    // Deterministic fallback: hash text to produce consistent pseudo-embedding
    // NOT suitable for semantic search — similar texts won't have similar embeddings
    const hash = createHash('sha256').update(text).digest();
    const embedding: number[] = [];
    for (let i = 0; i < dims; i++) {
      embedding.push((hash[i % hash.length] / 255) * 2 - 1);
    }
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? embedding.map((v) => v / norm) : embedding;
  }
}
