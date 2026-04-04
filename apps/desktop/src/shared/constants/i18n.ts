/**
 * Internationalization constants
 * Available languages and display labels
 */

export type SupportedLanguage = 'en' | 'fr' | 'zh-CN';

export const AVAILABLE_LANGUAGES = [
  { value: 'en' as const, label: 'English', nativeLabel: 'English' },
  { value: 'fr' as const, label: 'French', nativeLabel: 'Français' },
  { value: 'zh-CN' as const, label: 'Chinese (Simplified)', nativeLabel: '简体中文' }
] as const;

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

export function resolveSupportedLanguage(locale?: string | null): SupportedLanguage {
  if (!locale) {
    return DEFAULT_LANGUAGE;
  }

  const normalized = locale.trim().toLowerCase().replace(/_/g, '-');

  if (normalized.startsWith('zh')) {
    return 'zh-CN';
  }

  if (normalized.startsWith('fr')) {
    return 'fr';
  }

  return 'en';
}
