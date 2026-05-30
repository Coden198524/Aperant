import { EventEmitter } from 'events';
import { streamText } from 'ai';
import { createSimpleClient } from './ai/client/factory';
import { getActiveProviderFeatureSettings } from './ipc-handlers/feature-settings-helper';
import { safeBreadcrumb, safeCaptureException } from './sentry';

const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.warn('[DescriptionImprover]', ...args);
  }
}

const SYSTEM_PROMPT = `Rewrite rough task descriptions into clear, actionable prose for the next engineer.

Rules:
- Preserve original intent, language, file paths, identifiers, numbers, quoted errors, and @mentions.
- Fill obvious gaps with sensible defaults; do not ask questions or leave TBD/TODO/placeholders.
- Keep scope proportional. Do not invent unrelated features or redesign beyond the request.
- Use plain prose in the user's language, usually 1-3 short paragraphs.
- Mention what to build, why, key behavior or constraints, done criteria, and obvious out-of-scope notes when useful.
- Output only the rewritten description. No headers, code fences, preamble, estimates, story points, or priority labels.`;

function isResponsesApiModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return (
    modelId.startsWith('gpt-5') ||
    modelId.includes('codex') ||
    modelId === 'o3' ||
    modelId.startsWith('o3-') ||
    modelId === 'o4-mini' ||
    modelId.startsWith('o4-')
  );
}

export class DescriptionImprover extends EventEmitter {
  async improve(description: string, title?: string): Promise<string | null> {
    if (!description || !description.trim()) {
      return null;
    }

    const userPrompt = this.buildUserPrompt(description, title);

    debug('Improving description, length:', description.length);

    safeBreadcrumb({
      category: 'description-improver',
      message: 'Improving task description via Vercel AI SDK',
      level: 'info',
      data: { descriptionLength: description.length },
    });

    try {
      // Reuse the user's "naming" model setting — same tier as title generation,
      // already configured for lightweight text rewrites.
      const namingSettings = getActiveProviderFeatureSettings('naming');
      debug('Using naming settings:', namingSettings.model, namingSettings.thinkingLevel);

      const client = await createSimpleClient({
        systemPrompt: SYSTEM_PROMPT,
        modelShorthand: namingSettings.model,
        thinkingLevel: namingSettings.thinkingLevel as 'low' | 'medium' | 'high' | 'xhigh',
      });

      const isResponsesModel = isResponsesApiModel(client.resolvedModelId);

      const result = streamText({
        model: client.model,
        system: isResponsesModel ? undefined : client.systemPrompt,
        prompt: userPrompt,
        providerOptions: isResponsesModel ? {
          openai: {
            ...(client.systemPrompt ? { instructions: client.systemPrompt } : {}),
            store: false,
          },
        } : undefined,
      });

      const raw = (await result.text).trim();
      if (!raw) {
        debug('AI returned empty response');
        safeBreadcrumb({
          category: 'description-improver',
          message: 'AI returned empty response',
          level: 'warning',
        });
        return null;
      }

      const cleaned = this.stripMarkdownFences(raw);
      debug('Improved description, length:', cleaned.length);
      safeBreadcrumb({
        category: 'description-improver',
        message: 'Description improved successfully',
        level: 'info',
      });
      return cleaned;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
        debug('Rate limit detected:', message);
        safeBreadcrumb({
          category: 'description-improver',
          message: 'Rate limit detected',
          level: 'warning',
        });
        this.emit('sdk-rate-limit', {
          source: 'description-improver',
          message,
          timestamp: new Date().toISOString(),
        });
        throw new Error('rate_limit');
      }

      if (message.includes('401') || message.toLowerCase().includes('unauthorized')) {
        debug('Auth failure during description improvement');
        safeBreadcrumb({
          category: 'description-improver',
          message: 'Auth failure',
          level: 'error',
        });
        safeCaptureException(error instanceof Error ? error : new Error(message), {
          contexts: { descriptionImprover: { phase: 'auth' } },
        });
        throw new Error('auth_failure');
      }

      debug('Description improvement failed:', message);
      safeBreadcrumb({
        category: 'description-improver',
        message: 'Description improvement failed',
        level: 'error',
        data: { error: message },
      });
      safeCaptureException(error instanceof Error ? error : new Error(message), {
        contexts: { descriptionImprover: { phase: 'generation' } },
      });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  private buildUserPrompt(description: string, title?: string): string {
    const titlePart = title?.trim() ? `Title: ${title.trim()}\n\n` : '';
    return `${titlePart}Original description:\n${description}\n\nOutput the rewritten description only.`;
  }

  private stripMarkdownFences(text: string): string {
    let cleaned = text.trim();
    // Strip leading/trailing ``` fences if the model added them despite instructions
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
    return cleaned.trim();
  }
}

export const descriptionImprover = new DescriptionImprover();
