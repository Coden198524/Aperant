import type { TFunction } from 'i18next';

export function isGitHubAutomationModuleMissingError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return /GitHub automation module not installed|GitHub 自动化模块未安装/u.test(error);
}

export function localizeGitHubErrorMessage(
  t: TFunction,
  error: string | null | undefined
): string | null {
  if (!error) {
    return null;
  }

  const trimmedError = error.trim();

  if (trimmedError === 'Project not found') {
    return t('githubSetup.errors.projectNotFound', {
      ns: 'dialogs',
      defaultValue: 'Project not found'
    });
  }

  if (
    trimmedError === 'No GitHub token or repository configured' ||
    trimmedError === 'No GitHub configuration found' ||
    trimmedError === 'No GitHub configuration found for project'
  ) {
    return t('githubSetup.errors.noTokenOrRepo', {
      ns: 'dialogs',
      defaultValue: 'No GitHub token or repository configured'
    });
  }

  if (trimmedError === 'No GitHub token configured') {
    return t('githubSetup.errors.noToken', {
      ns: 'dialogs',
      defaultValue: 'No GitHub token configured'
    });
  }

  if (trimmedError === 'Invalid repository format. Use owner/repo or GitHub URL.') {
    return t('githubSetup.errors.invalidRepositoryFormat', {
      ns: 'dialogs',
      defaultValue: 'Invalid repository format. Use owner/repo or GitHub URL.'
    });
  }

  if (trimmedError === 'Failed to detect repository') {
    return t('githubSetup.errors.detectRepoFailed', {
      ns: 'dialogs',
      defaultValue: 'Failed to detect repository'
    });
  }

  if (trimmedError === 'Failed to load branches') {
    return t('githubSetup.errors.loadBranchesFailed', {
      ns: 'dialogs',
      defaultValue: 'Failed to load branches'
    });
  }

  if (trimmedError === 'Please enter a repository name') {
    return t('githubSetup.errors.repositoryNameRequired', {
      ns: 'dialogs',
      defaultValue: 'Please enter a repository name'
    });
  }

  if (trimmedError === 'Please select an owner for the repository') {
    return t('githubSetup.errors.ownerRequired', {
      ns: 'dialogs',
      defaultValue: 'Please select an owner for the repository'
    });
  }

  if (trimmedError === 'Failed to create repository') {
    return t('githubSetup.errors.createRepoFailed', {
      ns: 'dialogs',
      defaultValue: 'Failed to create repository'
    });
  }

  if (trimmedError === 'Please enter a repository name (owner/repo format)') {
    return t('githubSetup.errors.existingRepoRequired', {
      ns: 'dialogs',
      defaultValue: 'Please enter a repository name (owner/repo format)'
    });
  }

  if (trimmedError === 'Invalid format. Use owner/repo (e.g., username/my-project)') {
    return t('githubSetup.errors.invalidOwnerRepoFormat', {
      ns: 'dialogs',
      defaultValue: 'Invalid format. Use owner/repo (e.g., username/my-project)'
    });
  }

  if (trimmedError === 'Failed to add remote') {
    return t('githubSetup.errors.addRemoteFailed', {
      ns: 'dialogs',
      defaultValue: 'Failed to add remote'
    });
  }

  if (trimmedError === 'Failed to connect to GitHub') {
    return t('githubSetup.errors.connectGithubFailed', {
      ns: 'dialogs',
      defaultValue: 'Failed to connect to GitHub'
    });
  }

  if (trimmedError === 'Failed to analyze issues') {
    return t('githubSetup.errors.analyzeIssuesFailed', {
      ns: 'dialogs',
      defaultValue: 'Failed to analyze issues'
    });
  }

  if (isGitHubAutomationModuleMissingError(trimmedError)) {
    return t('githubSetup.errors.moduleNotInstalled', {
      ns: 'dialogs',
      defaultValue: 'GitHub automation module not installed'
    });
  }

  if (/GitHub CLI \(gh\) not found/i.test(trimmedError)) {
    return t('githubSetup.errors.ghCliMissing', {
      ns: 'dialogs',
      defaultValue: 'GitHub CLI (gh) not found. Please install it from https://cli.github.com/'
    });
  }

  const authExitCodeMatch = trimmedError.match(/^Authentication failed with exit code (\d+)$/u);
  if (authExitCodeMatch) {
    return t('githubSetup.errors.authFailedWithCode', {
      ns: 'dialogs',
      code: Number(authExitCodeMatch[1]),
      defaultValue: 'Authentication failed with exit code {{code}}'
    });
  }

  return error;
}
