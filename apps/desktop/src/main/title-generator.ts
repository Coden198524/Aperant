import { EventEmitter } from 'events';
import { streamText } from 'ai';
import { createSimpleClient } from './ai/client/factory';
import { getActiveProviderFeatureSettings } from './ipc-handlers/feature-settings-helper';
import { safeBreadcrumb, safeCaptureException } from './sentry';

/**
 * Debug logging - only logs when DEBUG=true or in development mode
 */
const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';

function debug(...args: unknown[]): void {
  if (DEBUG) {
    console.warn('[TitleGenerator]', ...args);
  }
}

const BASE_SYSTEM_PROMPT =
  'Generate concise task titles. Output only the title: no quotes, preamble, or explanation.';

export interface GenerateTitleOptions {
  language?: string;
}

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

/**
 * Service for generating task titles from descriptions using the Vercel AI SDK.
 *
 * Replaces the previous Python subprocess implementation.
 * Emits "sdk-rate-limit" events on 429 errors (same interface as before).
 */
export class TitleGenerator extends EventEmitter {
  constructor() {
    super();
    debug('TitleGenerator initialized');
  }

  /**
   * No-op configure() kept for backward compatibility with project-handlers.ts.
   * Python path and source path are no longer needed.
   */
  // biome-ignore lint/suspicious/noExplicitAny: kept for backward compatibility
  configure(_pythonPath?: string, _autoBuildSourcePath?: string): void {
    // No-op: TypeScript implementation does not need Python path or source path
  }

  /**
   * Generate a task title from a description using the configured AI provider
   * @param description - The task description to generate a title from
   * @returns Promise resolving to the generated title or null on failure
   */
  async generateTitle(description: string, options: GenerateTitleOptions = {}): Promise<string | null> {
    const systemPrompt = this.createSystemPrompt(options.language);
    const prompt = this.createTitlePrompt(description, options.language);

    debug('Generating title for description:', description.substring(0, 100) + '...');

    safeBreadcrumb({
      category: 'title-generator',
      message: 'Generating title via Vercel AI SDK',
      level: 'info',
      data: { descriptionLength: description.length, language: options.language },
    });

    try {
      // Read the user's configured naming model for their active provider.
      // This ensures we use the correct model for the active provider
      // (e.g., Codex models for OpenAI Codex OAuth, Gemini for Google, etc.)
      const namingSettings = getActiveProviderFeatureSettings('naming');
      debug('Using naming settings:', namingSettings.model, namingSettings.thinkingLevel);

      const client = await createSimpleClient({
        systemPrompt,
        modelShorthand: namingSettings.model,
        thinkingLevel: namingSettings.thinkingLevel as 'low' | 'medium' | 'high' | 'xhigh',
      });

      // Responses models require instructions instead of system messages in input.
      const isResponsesModel = isResponsesApiModel(client.resolvedModelId);

      const result = streamText({
        model: client.model,
        system: isResponsesModel ? undefined : client.systemPrompt,
        prompt,
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
          category: 'title-generator',
          message: 'AI returned empty response',
          level: 'warning',
        });
        return null;
      }

      const title = this.cleanTitle(raw);
      debug('Generated title:', title);
      safeBreadcrumb({
        category: 'title-generator',
        message: 'Title generated successfully',
        level: 'info',
      });
      return title;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Surface 429 rate-limit errors as sdk-rate-limit events
      if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
        debug('Rate limit detected:', message);
        safeBreadcrumb({
          category: 'title-generator',
          message: 'Rate limit detected',
          level: 'warning',
        });
        this.emit('sdk-rate-limit', {
          source: 'title-generator',
          message,
          timestamp: new Date().toISOString(),
        });
        return null;
      }

      // Auth failures
      if (message.includes('401') || message.toLowerCase().includes('unauthorized')) {
        debug('Auth failure during title generation');
        safeBreadcrumb({
          category: 'title-generator',
          message: 'Auth failure',
          level: 'error',
        });
        safeCaptureException(error instanceof Error ? error : new Error(message), {
          contexts: { titleGenerator: { phase: 'auth' } },
        });
        return null;
      }

      debug('Title generation failed:', message);
      safeBreadcrumb({
        category: 'title-generator',
        message: 'Title generation failed',
        level: 'error',
        data: { error: message },
      });
      safeCaptureException(error instanceof Error ? error : new Error(message), {
        contexts: { titleGenerator: { phase: 'generation' } },
      });
      return null;
    }
  }

  /**
   * Create the prompt for title generation
   */
  private createSystemPrompt(language?: string): string {
    return `${BASE_SYSTEM_PROMPT}\n${this.createLanguageInstruction(language)}`;
  }

  private createTitlePrompt(description: string, language?: string): string {
    return `Generate an action-oriented task title.

${this.createLanguageInstruction(language)}

Description:
${description}

Title:`;
  }

  private createLanguageInstruction(language?: string): string {
    switch (language) {
      case 'zh-CN':
        return 'Output the title in Simplified Chinese. Use a concise Chinese phrase, usually 6-14 Chinese characters. Keep file paths, APIs, product names, and quoted identifiers unchanged.';
      case 'fr':
        return 'Output the title in French. Use a concise 3-7 word phrase. Keep file paths, APIs, product names, and quoted identifiers unchanged.';
      case 'en':
        return 'Output the title in English. Use a concise 3-7 word phrase. Keep file paths, APIs, product names, and quoted identifiers unchanged.';
      default:
        return 'Match the primary language of the task description. Keep file paths, APIs, product names, and quoted identifiers unchanged.';
    }
  }

  /**
   * Clean up the generated title
   */
  private cleanTitle(title: string): string {
    // Remove quotes if present
    let cleaned = title.replace(/^["']|["']$/g, '');

    // Remove any "Title:" or similar prefixes
    cleaned = cleaned.replace(/^(title|task|feature|标题|任务|功能)[:：\s]*/i, '');

    // Take first line only
    cleaned = cleaned.split('\n')[0]?.trim() ?? cleaned;

    // Capitalize first letter
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

    // Truncate if too long (max 100 chars)
    if (cleaned.length > 100) {
      cleaned = `${cleaned.substring(0, 97)}...`;
    }

    return cleaned.trim();
  }
}

// Export singleton instance
export const titleGenerator = new TitleGenerator();
