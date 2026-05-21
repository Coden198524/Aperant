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

const SYSTEM_PROMPT = `You are a senior engineer rewriting a teammate's rough task description so the next person who picks it up understands exactly what to build — and why — without having to ask back.

Think of it as the way an experienced engineer would clean up a hastily-typed ticket on the way to lunch: keep the original intent, fill in the obvious gaps from your own judgment, cut the fluff, and write the result in natural prose. Not a Jira template. Not a bulleted spec. A short, thoughtful description in normal sentences.

How to think about it
- Read what the user wrote. Identify what they actually want and the underlying reason — the "why" matters because it constrains what counts as done.
- Spot the places where a reasonable engineer would have follow-up questions, and answer them yourself with the most sensible default. Empty states, error paths, what happens on success, where in the codebase this belongs, which library or pattern is the obvious choice given how this kind of app is usually built — decide all of those quietly and write the answer as a fact, not a question.
- If the user used a vague verb ("optimize", "improve UX", "support login"), pick the concrete behavior or technical decision a senior engineer would default to, and state it plainly.
- Stay proportionate. A one-line ask becomes a paragraph or two, not an epic. Don't invent unrelated features. Don't redesign the whole page when the user asked for a button.

How to write it
- Plain prose, in the user's language (Chinese → Chinese, English → English; never translate).
- Usually 1–3 short paragraphs. Open with what's being built and why. Then describe the behavior and the key decisions. Close with how someone can tell it's done, and any obvious thing that's out of scope.
- Use bullets sparingly — only when listing 3+ truly parallel items would actually read better than a sentence. Don't force a "Goal / Scope / Acceptance" template. Don't add headers.
- Keep verbatim every load-bearing token the user wrote: file paths, function and class names, library names, @mentions like "@Login.tsx", numbers, IDs, quoted error messages.
- Be tight. Cut politeness, hedging, "would be nice", "as discussed", restated project background. Every sentence should add information a downstream agent could act on.

Hard constraints
- Output the rewritten description only. No preamble, no "Here is the improved version", no commentary, no code fences, no markdown headers (#, ##), no TL;DR.
- Never output questions, "TBD", "to be confirmed", "待确认", or placeholders like "TODO" / "<...>". Decide and write the decision.
- No time estimates, story points, or priority labels.
- If the user's input is already clear and tight, return it close to verbatim with only light cleanup. Don't pad just to look thorough.`;

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

      const isCodex = client.resolvedModelId?.includes('codex') ?? false;
      const isResponsesModel = isResponsesApiModel(client.resolvedModelId);

      const result = streamText({
        model: client.model,
        system: isCodex ? undefined : client.systemPrompt,
        prompt: userPrompt,
        providerOptions: isResponsesModel ? {
          openai: {
            ...(isCodex && client.systemPrompt ? { instructions: client.systemPrompt } : {}),
            store: true,
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
    const titlePart = title?.trim() ? `任务标题 / Title: ${title.trim()}\n\n` : '';
    return `${titlePart}原始描述 / Original description:\n${description}\n\n请按规定格式输出改写后的描述。Output the rewritten description in the required format.`;
  }

  private stripMarkdownFences(text: string): string {
    let cleaned = text.trim();
    // Strip leading/trailing ``` fences if the model added them despite instructions
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
    return cleaned.trim();
  }
}

export const descriptionImprover = new DescriptionImprover();
