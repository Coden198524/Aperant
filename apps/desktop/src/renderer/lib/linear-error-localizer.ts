import type { TFunction } from 'i18next';

export function localizeLinearErrorMessage(
  t: TFunction,
  error: string | null | undefined
): string | null {
  if (!error) {
    return null;
  }

  const trimmedError = error.trim();

  if (trimmedError === 'No Linear API key configured') {
    return t('linearImport.errors.noApiKey', {
      ns: 'common',
      defaultValue: 'No Linear API key configured'
    });
  }

  if (trimmedError === 'Failed to connect to Linear') {
    return t('linearImport.errors.connectFailed', {
      ns: 'common',
      defaultValue: 'Failed to connect to Linear'
    });
  }

  if (trimmedError === 'Failed to load teams') {
    return t('linearImport.errors.loadTeamsFailed', {
      ns: 'common',
      defaultValue: 'Failed to load teams'
    });
  }

  if (trimmedError === 'Failed to load projects') {
    return t('linearImport.errors.loadProjectsFailed', {
      ns: 'common',
      defaultValue: 'Failed to load projects'
    });
  }

  if (trimmedError === 'Failed to load issues') {
    return t('linearImport.errors.loadIssuesFailed', {
      ns: 'common',
      defaultValue: 'Failed to load issues'
    });
  }

  if (trimmedError === 'Failed to import issues') {
    return t('linearImport.errors.importFailed', {
      ns: 'common',
      defaultValue: 'Failed to import issues'
    });
  }

  if (trimmedError === 'Unknown error') {
    return t('errors.unknownError', {
      ns: 'common',
      defaultValue: 'Unknown error'
    });
  }

  const linearApiErrorMatch = trimmedError.match(/^Linear API error:\s*(.+)$/u);
  if (linearApiErrorMatch) {
    return t('linearImport.errors.apiError', {
      ns: 'common',
      details: linearApiErrorMatch[1],
      defaultValue: 'Linear API error: {{details}}'
    });
  }

  return error;
}
