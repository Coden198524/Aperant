/**
 * Shared log message translations for agent orchestration.
 */

export type AutocodeKnownLogLanguage = 'en' | 'fr' | 'zh-CN';
export type AutocodeLogLanguage = AutocodeKnownLogLanguage | string | undefined;
export type AutocodeLogTranslationSet = Record<AutocodeKnownLogLanguage, string>;

export const AUTOCODE_LOG_MESSAGES: Record<string, AutocodeLogTranslationSet> = {
  'Starting implementation': {
    en: 'Starting implementation',
    fr: 'Démarrage de l\'implémentation',
    'zh-CN': '开始实现',
  },
  'Running pre-QA quality checks...': {
    en: 'Running pre-QA quality checks...',
    fr: 'Exécution des vérifications de qualité pré-QA...',
    'zh-CN': '正在运行 QA 前质量检查...',
  },
  'Creating implementation plan': {
    en: 'Creating implementation plan',
    fr: 'Création du plan d\'implémentation',
    'zh-CN': '创建实现计划',
  },
  'Build complete': {
    en: 'Build complete',
    fr: 'Construction terminée',
    'zh-CN': '构建完成',
  },
  'Build already complete': {
    en: 'Build already complete',
    fr: 'Construction déjà terminée',
    'zh-CN': '构建已完成',
  },
  'Detected incomplete subtasks after coding phase - continuing coding': {
    en: 'Detected incomplete subtasks after coding phase - continuing coding',
    fr: 'Sous-tâches incomplètes détectées après la phase de codage - poursuite du codage',
    'zh-CN': '编码阶段后检测到未完成的子任务，继续编码',
  },
  'Wrote implementation plan from structured output (schema-guaranteed)': {
    en: 'Wrote implementation plan from structured output (schema-guaranteed)',
    fr: 'Plan d\'implémentation écrit à partir de la sortie structurée (garanti par schéma)',
    'zh-CN': '已从结构化输出写入实现计划（Schema 保证）',
  },
  'Lightweight repair succeeded': {
    en: 'Lightweight repair succeeded',
    fr: 'Réparation légère réussie',
    'zh-CN': '轻量级修复成功',
  },
  'Pre-coding plan validation failed': {
    en: 'Pre-coding plan validation failed',
    fr: 'Échec de la validation du plan pré-codage',
    'zh-CN': '编码前计划验证失败',
  },
  'Plan validation failed': {
    en: 'Plan validation failed',
    fr: 'Échec de la validation du plan',
    'zh-CN': '计划验证失败',
  },
  'Attempting lightweight repair...': {
    en: 'Attempting lightweight repair...',
    fr: 'Tentative de réparation légère...',
    'zh-CN': '正在尝试轻量级修复...',
  },
  'Lightweight repair failed': {
    en: 'Lightweight repair failed',
    fr: 'Échec de la réparation légère',
    'zh-CN': '轻量级修复失败',
  },
  'Falling back to full re-plan': {
    en: 'Falling back to full re-plan',
    fr: 'Retour à une replanification complète',
    'zh-CN': '回退到完整重新规划',
  },
  'Pre-implementation checklist shows critical risk for': {
    en: 'Pre-implementation checklist shows critical risk for',
    fr: 'La liste de contrôle pré-implémentation montre un risque critique pour',
    'zh-CN': '实现前检查清单显示关键风险：',
  },
  'Working on': {
    en: 'Working on',
    fr: 'Travail sur',
    'zh-CN': '正在处理',
  },
  attempt: {
    en: 'attempt',
    fr: 'tentative',
    'zh-CN': '尝试',
  },
  stuck: {
    en: 'stuck',
    fr: 'bloqué',
    'zh-CN': '卡住',
  },
};

export function translateAutocodeLogMessage(message: string, language?: AutocodeLogLanguage): string {
  if (!language || language === 'en') {
    return message;
  }

  const exact = AUTOCODE_LOG_MESSAGES[message];
  if (exact) {
    return resolveAutocodeTranslation(exact, language) ?? message;
  }

  for (const [key, translations] of Object.entries(AUTOCODE_LOG_MESSAGES)) {
    if (message.startsWith(key)) {
      const translated = resolveAutocodeTranslation(translations, language) ?? key;
      return translated + message.slice(key.length);
    }
  }

  return message;
}

export function translateAutocodePhaseMessage(
  phase: string,
  message: string,
  language?: AutocodeLogLanguage,
): string {
  void phase;
  return translateAutocodeLogMessage(message, language);
}

function resolveAutocodeTranslation(
  translations: AutocodeLogTranslationSet,
  language: AutocodeLogLanguage,
): string | undefined {
  if (language === 'en' || language === 'fr' || language === 'zh-CN') {
    return translations[language];
  }

  return undefined;
}
