import type { SupportedLanguage } from '../../../shared/constants/i18n';
import type { ValidatedImplementationPlan } from './implementation-plan';

const HAN_CHARACTER_RE = /[\u3400-\u9fff]/;
const LATIN_TOKEN_RE = /[A-Za-z][A-Za-z0-9_-]*/g;
const IGNORED_LATIN_TOKENS = new Set([
  'api',
  'cli',
  'cpu',
  'css',
  'fps',
  'git',
  'gpu',
  'html',
  'http',
  'https',
  'ipc',
  'ios',
  'json',
  'qa',
  'sql',
  'svg',
  'ts',
  'tsx',
  'ui',
  'url',
  'ux',
  'xml',
  'yaml',
  'yml',
]);

function stripTechnicalTokens(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, ' ')
    .replace(/(?:^|[\s(])(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/g, ' ')
    .replace(/--?[A-Za-z0-9_-]+(?:=[^\s]+)?/g, ' ')
    .replace(/[{}[\]()<>:;,.!?'"~@#$%^&*+=|\\/-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksEnglishOnly(text: string, minimumMeaningfulTokens: number): boolean {
  if (!text.trim()) {
    return false;
  }

  const normalized = stripTechnicalTokens(text);
  if (!normalized) {
    return false;
  }

  if (HAN_CHARACTER_RE.test(normalized)) {
    return false;
  }

  const tokens = normalized.match(LATIN_TOKEN_RE) ?? [];
  const meaningfulTokens = tokens.filter((token) => {
    const lower = token.toLowerCase();
    if (IGNORED_LATIN_TOKENS.has(lower)) {
      return false;
    }
    if (/^[A-Z0-9_]{2,5}$/.test(token)) {
      return false;
    }
    return true;
  });

  return meaningfulTokens.length >= minimumMeaningfulTokens;
}

export function validateImplementationPlanLanguage(
  plan: ValidatedImplementationPlan,
  language?: SupportedLanguage,
): string[] {
  if (language !== 'zh-CN') {
    return [];
  }

  const errors: string[] = [];

  if (typeof plan.feature === 'string' && looksEnglishOnly(plan.feature, 1)) {
    errors.push('At "feature": must be written in Simplified Chinese (zh-CN), not English.');
  }

  for (const [phaseIndex, phase] of plan.phases.entries()) {
    if (looksEnglishOnly(phase.name, 1)) {
      errors.push(`At "phases.${phaseIndex}.name": must be written in Simplified Chinese (zh-CN), not English.`);
    }

    const phaseDescription = (phase as Record<string, unknown>).description;
    if (typeof phaseDescription === 'string' && looksEnglishOnly(phaseDescription, 3)) {
      errors.push(`At "phases.${phaseIndex}.description": must be written in Simplified Chinese (zh-CN), not English.`);
    }

    for (const [subtaskIndex, subtask] of phase.subtasks.entries()) {
      if (looksEnglishOnly(subtask.title, 1)) {
        errors.push(`At "phases.${phaseIndex}.subtasks.${subtaskIndex}.title": must be written in Simplified Chinese (zh-CN), not English.`);
      }
      if (looksEnglishOnly(subtask.description, 3)) {
        errors.push(`At "phases.${phaseIndex}.subtasks.${subtaskIndex}.description": must be written in Simplified Chinese (zh-CN), not English.`);
      }
    }
  }

  return errors;
}
