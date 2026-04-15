/**
 * Log Messages Translation
 * =========================
 *
 * Provides translated log messages for the build orchestrator.
 * Since the main process doesn't have access to react-i18next,
 * we use a simple translation map.
 */

import type { SupportedLanguage } from '../../../shared/constants/i18n';

// Translation map for log messages
const LOG_MESSAGES = {
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
    'zh-CN': '编码阶段后检测到未完成的子任务 - 继续编码',
  },
  'Batch execution enabled - analyzing parallel opportunities': {
    en: 'Batch execution enabled - analyzing parallel opportunities',
    fr: 'Exécution par lots activée - analyse des opportunités parallèles',
    'zh-CN': '已启用批量执行 - 分析并行机会',
  },
  'Wrote implementation plan from structured output (schema-guaranteed)': {
    en: 'Wrote implementation plan from structured output (schema-guaranteed)',
    fr: 'Plan d\'implémentation écrit à partir de la sortie structurée (garanti par schéma)',
    'zh-CN': '从结构化输出写入实现计划（模式保证）',
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
    'zh-CN': '尝试轻量级修复...',
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
    'zh-CN': '实现前检查清单显示关键风险',
  },
  'Starting batch': {
    en: 'Starting batch',
    fr: 'Démarrage du lot',
    'zh-CN': '开始批次',
  },
  'subtasks': {
    en: 'subtasks',
    fr: 'sous-tâches',
    'zh-CN': '个子任务',
  },
  'Batch completed': {
    en: 'Batch completed',
    fr: 'Lot terminé',
    'zh-CN': '批次完成',
  },
  'subtasks succeeded': {
    en: 'subtasks succeeded',
    fr: 'sous-tâches réussies',
    'zh-CN': '个子任务成功',
  },
  'Batch execution completed successfully': {
    en: 'Batch execution completed successfully',
    fr: 'Exécution par lots terminée avec succès',
    'zh-CN': '批量执行成功完成',
  },
  'Working on': {
    en: 'Working on',
    fr: 'Travail sur',
    'zh-CN': '正在处理',
  },
  'attempt': {
    en: 'attempt',
    fr: 'tentative',
    'zh-CN': '尝试',
  },
  'stuck': {
    en: 'stuck',
    fr: 'bloqué',
    'zh-CN': '卡住',
  },
} as const;

/**
 * Translate a log message to the specified language.
 * Falls back to English if translation not found.
 */
export function translateLogMessage(message: string, language?: SupportedLanguage): string {
  if (!language || language === 'en') {
    return message;
  }

  // Check if we have a translation for this exact message
  if (message in LOG_MESSAGES) {
    const translations = LOG_MESSAGES[message as keyof typeof LOG_MESSAGES];
    return translations[language] || message;
  }

  // Check for messages with dynamic parts (e.g., "Working on subtask-1: ...")
  for (const [key, translations] of Object.entries(LOG_MESSAGES)) {
    if (message.startsWith(key)) {
      const translated = translations[language] || key;
      const suffix = message.slice(key.length);
      return translated + suffix;
    }
  }

  // Return original message if no translation found
  return message;
}

/**
 * Translate phase transition message.
 */
export function translatePhaseMessage(phase: string, message: string, language?: SupportedLanguage): string {
  return translateLogMessage(message, language);
}
