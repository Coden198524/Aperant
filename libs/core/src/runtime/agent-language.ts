import type { AutocodeAgentMessage } from './agent-messages.js';

export type AutocodeOutputLanguage = 'zh-CN' | 'fr' | string | undefined;

export function getAutocodeLanguageRequirement(language: AutocodeOutputLanguage): string | null {
  switch (language) {
    case 'zh-CN':
      return 'Use Simplified Chinese for all user-facing prose. Keep code, paths, commands, logs, schema keys, and technical identifiers in their required form.';
    case 'fr':
      return 'Use French for all user-facing prose. Keep code, paths, commands, logs, schema keys, and technical identifiers in their required form.';
    default:
      return null;
  }
}

export function getAutocodeImplementationPlanLanguageRequirement(
  language: AutocodeOutputLanguage,
): string | null {
  switch (language) {
    case 'zh-CN':
      return 'Write all user-facing planning text in Simplified Chinese. Keep paths, commands, APIs, class names, and code identifiers unchanged.';
    case 'fr':
      return 'Write all user-facing planning text in French. Keep paths, commands, APIs, class names, and code identifiers unchanged.';
    default:
      return null;
  }
}

export function getAutocodeStrictLanguageRequirement(language: AutocodeOutputLanguage): string | null {
  switch (language) {
    case 'zh-CN':
      return [
        'Use Simplified Chinese for all user-facing prose: progress updates, summaries, plans, QA reports, markdown, and errors.',
        'Keep source code, paths, commands, compiler output, schema keys, API names, class/function names, and required status tokens unchanged.',
        'If the user explicitly requests another language, follow the user.',
      ].join('\n');
    case 'fr':
      return [
        'Use French for all user-facing prose: progress updates, summaries, plans, QA reports, markdown, and errors.',
        'Keep source code, paths, commands, compiler output, schema keys, API names, class/function names, and required status tokens unchanged.',
        'If the user explicitly requests another language, follow the user.',
      ].join('\n');
    default:
      return null;
  }
}

export function appendAutocodeLanguageRequirement(
  content: string,
  language: AutocodeOutputLanguage,
): string {
  const requirement = getAutocodeStrictLanguageRequirement(language) ??
    getAutocodeLanguageRequirement(language);
  if (!requirement || content.includes('## OUTPUT LANGUAGE REQUIREMENT')) {
    return content;
  }
  return `${content}\n\n## OUTPUT LANGUAGE REQUIREMENT\n${requirement}`;
}

export function appendAutocodeLanguageRequirementToMessages<T extends AutocodeAgentMessage>(
  messages: T[],
  language: AutocodeOutputLanguage,
): T[] {
  const requirement = getAutocodeStrictLanguageRequirement(language) ??
    getAutocodeLanguageRequirement(language);
  if (!requirement || messages.length === 0) {
    return messages;
  }

  let updated = false;
  return messages.map((message) => {
    if (updated || message.role !== 'user' || typeof message.content !== 'string') {
      return message;
    }
    updated = true;
    return {
      ...message,
      content: appendAutocodeLanguageRequirement(message.content, language),
    };
  });
}
