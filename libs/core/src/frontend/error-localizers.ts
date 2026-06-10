export interface AutocodeLocalizedMessageDescriptor {
  key: string;
  ns: string;
  defaultValue: string;
  values?: Record<string, unknown>;
}

function descriptor(
  key: string,
  ns: string,
  defaultValue: string,
  values?: Record<string, unknown>
): AutocodeLocalizedMessageDescriptor {
  return { key, ns, defaultValue, ...(values ? { values } : {}) };
}

export function isAutocodeGitHubAutomationModuleMissingError(error: string | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return /GitHub automation module not installed|GitHub 自动化模块未安装/u.test(error);
}

export function resolveAutocodeGitHubErrorMessage(
  error: string | null | undefined
): AutocodeLocalizedMessageDescriptor | null {
  if (!error) {
    return null;
  }

  const trimmedError = error.trim();

  const exactMessages: Record<string, AutocodeLocalizedMessageDescriptor> = {
    'Project not found': descriptor('githubSetup.errors.projectNotFound', 'dialogs', 'Project not found'),
    'No GitHub token or repository configured': descriptor(
      'githubSetup.errors.noTokenOrRepo',
      'dialogs',
      'No GitHub token or repository configured'
    ),
    'No GitHub configuration found': descriptor(
      'githubSetup.errors.noTokenOrRepo',
      'dialogs',
      'No GitHub token or repository configured'
    ),
    'No GitHub configuration found for project': descriptor(
      'githubSetup.errors.noTokenOrRepo',
      'dialogs',
      'No GitHub token or repository configured'
    ),
    'No GitHub token configured': descriptor(
      'githubSetup.errors.noToken',
      'dialogs',
      'No GitHub token configured'
    ),
    'Invalid repository format. Use owner/repo or GitHub URL.': descriptor(
      'githubSetup.errors.invalidRepositoryFormat',
      'dialogs',
      'Invalid repository format. Use owner/repo or GitHub URL.'
    ),
    'Failed to detect repository': descriptor(
      'githubSetup.errors.detectRepoFailed',
      'dialogs',
      'Failed to detect repository'
    ),
    'Failed to load branches': descriptor(
      'githubSetup.errors.loadBranchesFailed',
      'dialogs',
      'Failed to load branches'
    ),
    'Please enter a repository name': descriptor(
      'githubSetup.errors.repositoryNameRequired',
      'dialogs',
      'Please enter a repository name'
    ),
    'Please select an owner for the repository': descriptor(
      'githubSetup.errors.ownerRequired',
      'dialogs',
      'Please select an owner for the repository'
    ),
    'Failed to create repository': descriptor(
      'githubSetup.errors.createRepoFailed',
      'dialogs',
      'Failed to create repository'
    ),
    'Please enter a repository name (owner/repo format)': descriptor(
      'githubSetup.errors.existingRepoRequired',
      'dialogs',
      'Please enter a repository name (owner/repo format)'
    ),
    'Invalid format. Use owner/repo (e.g., username/my-project)': descriptor(
      'githubSetup.errors.invalidOwnerRepoFormat',
      'dialogs',
      'Invalid format. Use owner/repo (e.g., username/my-project)'
    ),
    'Failed to add remote': descriptor(
      'githubSetup.errors.addRemoteFailed',
      'dialogs',
      'Failed to add remote'
    ),
    'Failed to connect to GitHub': descriptor(
      'githubSetup.errors.connectGithubFailed',
      'dialogs',
      'Failed to connect to GitHub'
    ),
    'Failed to analyze issues': descriptor(
      'githubSetup.errors.analyzeIssuesFailed',
      'dialogs',
      'Failed to analyze issues'
    ),
  };

  const exact = exactMessages[trimmedError];
  if (exact) {
    return exact;
  }

  if (isAutocodeGitHubAutomationModuleMissingError(trimmedError)) {
    return descriptor(
      'githubSetup.errors.moduleNotInstalled',
      'dialogs',
      'GitHub automation module not installed'
    );
  }

  if (/GitHub CLI \(gh\) not found/i.test(trimmedError)) {
    return descriptor(
      'githubSetup.errors.ghCliMissing',
      'dialogs',
      'GitHub CLI (gh) not found. Please install it from https://cli.github.com/'
    );
  }

  const authExitCodeMatch = trimmedError.match(/^Authentication failed with exit code (\d+)$/u);
  if (authExitCodeMatch) {
    return descriptor(
      'githubSetup.errors.authFailedWithCode',
      'dialogs',
      'Authentication failed with exit code {{code}}',
      { code: Number(authExitCodeMatch[1]) }
    );
  }

  return null;
}

export function resolveAutocodeLinearErrorMessage(
  error: string | null | undefined
): AutocodeLocalizedMessageDescriptor | null {
  if (!error) {
    return null;
  }

  const trimmedError = error.trim();

  const exactMessages: Record<string, AutocodeLocalizedMessageDescriptor> = {
    'No Linear API key configured': descriptor(
      'linearImport.errors.noApiKey',
      'common',
      'No Linear API key configured'
    ),
    'Failed to connect to Linear': descriptor(
      'linearImport.errors.connectFailed',
      'common',
      'Failed to connect to Linear'
    ),
    'Failed to load teams': descriptor(
      'linearImport.errors.loadTeamsFailed',
      'common',
      'Failed to load teams'
    ),
    'Failed to load projects': descriptor(
      'linearImport.errors.loadProjectsFailed',
      'common',
      'Failed to load projects'
    ),
    'Failed to load issues': descriptor(
      'linearImport.errors.loadIssuesFailed',
      'common',
      'Failed to load issues'
    ),
    'Failed to import issues': descriptor(
      'linearImport.errors.importFailed',
      'common',
      'Failed to import issues'
    ),
    'Unknown error': descriptor(
      'errors.unknownError',
      'common',
      'Unknown error'
    ),
  };

  const exact = exactMessages[trimmedError];
  if (exact) {
    return exact;
  }

  const linearApiErrorMatch = trimmedError.match(/^Linear API error:\s*(.+)$/u);
  if (linearApiErrorMatch) {
    return descriptor(
      'linearImport.errors.apiError',
      'common',
      'Linear API error: {{details}}',
      { details: linearApiErrorMatch[1] }
    );
  }

  return null;
}
