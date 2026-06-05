import {
  translateAutocodeLogMessage,
  translateAutocodePhaseMessage,
} from '@autocode/core/runtime/agent-log-messages';
import type { SupportedLanguage } from '../../../shared/constants/i18n';

export function translateLogMessage(message: string, language?: SupportedLanguage): string {
  return translateAutocodeLogMessage(message, language);
}

export function translatePhaseMessage(phase: string, message: string, language?: SupportedLanguage): string {
  return translateAutocodePhaseMessage(phase, message, language);
}
