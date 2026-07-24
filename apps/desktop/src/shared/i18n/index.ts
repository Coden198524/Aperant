import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LANGUAGE, resolveSupportedLanguage } from '../constants/i18n';

// Import English translation resources
import enCommon from './locales/en/common.json';
import enNavigation from './locales/en/navigation.json';
import enSettings from './locales/en/settings.json';
import enTasks from './locales/en/tasks.json';
import enWelcome from './locales/en/welcome.json';
import enOnboarding from './locales/en/onboarding.json';
import enDialogs from './locales/en/dialogs.json';
import enGitlab from './locales/en/gitlab.json';
import enTaskReview from './locales/en/taskReview.json';
import enTerminal from './locales/en/terminal.json';
import enErrors from './locales/en/errors.json';
import enChangelog from './locales/en/changelog.json';

// Import French translation resources
import frCommon from './locales/fr/common.json';
import frNavigation from './locales/fr/navigation.json';
import frSettings from './locales/fr/settings.json';
import frTasks from './locales/fr/tasks.json';
import frWelcome from './locales/fr/welcome.json';
import frOnboarding from './locales/fr/onboarding.json';
import frDialogs from './locales/fr/dialogs.json';
import frGitlab from './locales/fr/gitlab.json';
import frTaskReview from './locales/fr/taskReview.json';
import frTerminal from './locales/fr/terminal.json';
import frErrors from './locales/fr/errors.json';
import frChangelog from './locales/fr/changelog.json';

// Import Chinese translation resources
import zhCNCommon from './locales/zh-CN/common.json';
import zhCNNavigation from './locales/zh-CN/navigation.json';
import zhCNSettings from './locales/zh-CN/settings.json';
import zhCNTasks from './locales/zh-CN/tasks.json';
import zhCNWelcome from './locales/zh-CN/welcome.json';
import zhCNOnboarding from './locales/zh-CN/onboarding.json';
import zhCNDialogs from './locales/zh-CN/dialogs.json';
import zhCNGitlab from './locales/zh-CN/gitlab.json';
import zhCNTaskReview from './locales/zh-CN/taskReview.json';
import zhCNTerminal from './locales/zh-CN/terminal.json';
import zhCNErrors from './locales/zh-CN/errors.json';
import zhCNChangelog from './locales/zh-CN/changelog.json';
import { zhCNContextWorkspaceOverrides } from './locales/zh-CN/contextWorkspaceOverrides';
import { zhCNDialogsOverrides } from './locales/zh-CN/dialogsOverrides';
import { zhCNIdeationRoadmapOverrides } from './locales/zh-CN/ideationRoadmapOverrides';
import { zhCNInsightsAttachmentOverrides } from './locales/zh-CN/insightsAttachmentOverrides';
import { zhCNInsightsUiOverrides } from './locales/zh-CN/insightsUiOverrides';
import { zhCNIssuesOverrides } from './locales/zh-CN/issuesOverrides';
import { zhCNOnboardingGraphitiOverrides } from './locales/zh-CN/onboardingGraphitiOverrides';
import { zhCNOnboardingOllamaOverrides } from './locales/zh-CN/onboardingOllamaOverrides';
import { zhCNOnboardingSharedOverrides } from './locales/zh-CN/onboardingSharedOverrides';
import { zhCNSettingsDisplayOverrides } from './locales/zh-CN/settingsDisplayOverrides';
import { zhCNSettingsAgentProfileOverrides } from './locales/zh-CN/settingsAgentProfileOverrides';
import { zhCNSettingsGeneralOverrides } from './locales/zh-CN/settingsGeneralOverrides';
import { zhCNSettingsGitHubOverrides } from './locales/zh-CN/settingsGitHubOverrides';
import { zhCNSettingsLinearOverrides } from './locales/zh-CN/settingsLinearOverrides';
import { zhCNSettingsMemoryOverrides } from './locales/zh-CN/settingsMemoryOverrides';
import { zhCNSettingsTerminalFontsOverrides } from './locales/zh-CN/settingsTerminalFontsOverrides';
import { zhCNTasksTaskDetailOverrides } from './locales/zh-CN/tasksTaskDetailOverrides';
import {
  zhCNCommonOverrides,
  zhCNSettingsOverrides,
  zhCNTasksOverrides,
  zhCNTaskReviewOverrides,
  zhCNOnboardingOverrides
} from './locales/zh-CN/overrides';

export const defaultNS = 'common';

function mergeLocale<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      result[key] = mergeLocale(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

export const resources = {
  en: {
    common: enCommon,
    navigation: enNavigation,
    settings: enSettings,
    tasks: enTasks,
    welcome: enWelcome,
    onboarding: enOnboarding,
    dialogs: enDialogs,
    gitlab: enGitlab,
    taskReview: enTaskReview,
    terminal: enTerminal,
    errors: enErrors,
    changelog: enChangelog
  },
  fr: {
    common: frCommon,
    navigation: frNavigation,
    settings: frSettings,
    tasks: frTasks,
    welcome: frWelcome,
    onboarding: frOnboarding,
    dialogs: frDialogs,
    gitlab: frGitlab,
    taskReview: frTaskReview,
    terminal: frTerminal,
    errors: frErrors,
    changelog: frChangelog
  },
  'zh-CN': {
    common: mergeLocale(
      mergeLocale(
        mergeLocale(
          mergeLocale(zhCNCommon, zhCNCommonOverrides),
          zhCNContextWorkspaceOverrides
        ),
        mergeLocale(
          mergeLocale(zhCNIdeationRoadmapOverrides, zhCNInsightsUiOverrides),
          zhCNInsightsAttachmentOverrides
        )
      ),
      zhCNIssuesOverrides
    ),
    navigation: zhCNNavigation,
    settings: mergeLocale(
      mergeLocale(
        mergeLocale(
          mergeLocale(zhCNSettings, zhCNSettingsOverrides),
          zhCNSettingsLinearOverrides
        ),
        mergeLocale(
          mergeLocale(zhCNSettingsGitHubOverrides, zhCNSettingsGeneralOverrides),
          zhCNSettingsMemoryOverrides
        )
      ),
      mergeLocale(
        zhCNSettingsDisplayOverrides,
        mergeLocale(zhCNSettingsAgentProfileOverrides, zhCNSettingsTerminalFontsOverrides)
      )
    ),
    tasks: mergeLocale(mergeLocale(zhCNTasks, zhCNTasksOverrides), zhCNTasksTaskDetailOverrides),
    welcome: zhCNWelcome,
    onboarding: mergeLocale(
      mergeLocale(
        mergeLocale(
          mergeLocale(zhCNOnboarding, zhCNOnboardingOverrides),
          zhCNOnboardingOllamaOverrides
        ),
        zhCNOnboardingGraphitiOverrides
      ),
      zhCNOnboardingSharedOverrides
    ),
    dialogs: mergeLocale(zhCNDialogs, zhCNDialogsOverrides),
    gitlab: zhCNGitlab,
    taskReview: mergeLocale(zhCNTaskReview, zhCNTaskReviewOverrides),
    terminal: zhCNTerminal,
    errors: zhCNErrors,
    changelog: zhCNChangelog
  }
} as const;

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: resolveSupportedLanguage(typeof navigator !== 'undefined' ? navigator.language : DEFAULT_LANGUAGE),
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: ['en', 'fr', 'zh-CN'],
    defaultNS,
    ns: ['common', 'navigation', 'settings', 'tasks', 'welcome', 'onboarding', 'dialogs', 'gitlab', 'taskReview', 'terminal', 'errors', 'changelog'],
    interpolation: {
      escapeValue: false // React already escapes values
    },
    react: {
      useSuspense: false // Disable suspense for Electron compatibility
    }
  });

export default i18n;
