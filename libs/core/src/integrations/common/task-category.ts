import { labelMatchesWholeWord } from './label-utils.js';

export type AutocodeIntegrationTaskCategory =
  | 'feature'
  | 'bug_fix'
  | 'refactoring'
  | 'documentation'
  | 'security'
  | 'performance'
  | 'ui_ux'
  | 'infrastructure'
  | 'testing';

export function determineAutocodeTaskCategoryFromLabels(labels: readonly string[]): AutocodeIntegrationTaskCategory {
  const lowerLabels = labels.map(label => label.toLowerCase());

  if (lowerLabels.some(label => label.includes('bug') || label.includes('defect') || label.includes('error') || label.includes('fix'))) {
    return 'bug_fix';
  }
  if (lowerLabels.some(label => label.includes('security') || label.includes('vulnerability') || label.includes('cve'))) {
    return 'security';
  }
  if (lowerLabels.some(label => label.includes('performance') || label.includes('optimization') || label.includes('speed'))) {
    return 'performance';
  }
  if (lowerLabels.some(label => label.includes('ui') || label.includes('ux') || label.includes('design') || label.includes('styling'))) {
    return 'ui_ux';
  }
  if (lowerLabels.some(label =>
    label.includes('infrastructure') ||
    label.includes('devops') ||
    label.includes('deployment') ||
    labelMatchesWholeWord(label, 'ci') ||
    labelMatchesWholeWord(label, 'cd')
  )) {
    return 'infrastructure';
  }
  if (lowerLabels.some(label => label.includes('test') || label.includes('testing') || label.includes('qa'))) {
    return 'testing';
  }
  if (lowerLabels.some(label =>
    label.includes('refactor') ||
    label.includes('cleanup') ||
    label.includes('maintenance') ||
    label.includes('chore') ||
    label.includes('tech-debt') ||
    label.includes('technical debt')
  )) {
    return 'refactoring';
  }
  if (lowerLabels.some(label => label.includes('documentation') || label.includes('docs'))) {
    return 'documentation';
  }

  return 'feature';
}
