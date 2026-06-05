/**
 * Shared validation and smoke-test feedback helpers.
 */

export interface AutocodeValidationFailure {
  type: 'syntax' | 'type' | 'security' | 'pattern' | 'test';
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export interface AutocodeValidationCheck {
  name: string;
  type: AutocodeValidationFailure['type'];
  passed: boolean;
  durationMs: number;
  output?: string;
}

export interface AutocodeIncrementalValidationResult {
  passed: boolean;
  failures: AutocodeValidationFailure[];
  durationMs: number;
  checks: AutocodeValidationCheck[];
}

export interface AutocodeSmokeTestIssue {
  type: 'syntax' | 'type' | 'security' | 'build' | 'test';
  check: string;
  severity: 'critical' | 'warning';
  output: string;
  suggestion?: string;
}

export interface AutocodeSmokeCheckResult {
  name: string;
  passed: boolean;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface AutocodeSmokeTestResult {
  passed: boolean;
  shouldReturnToCoding: boolean;
  issues: AutocodeSmokeTestIssue[];
  durationMs: number;
  checks: AutocodeSmokeCheckResult[];
}

export interface AutocodeSmokeCheckDescriptor {
  name: string;
  type: AutocodeSmokeTestIssue['type'];
  severity: AutocodeSmokeTestIssue['severity'];
  required: boolean;
}

export interface AutocodeCommandSpec {
  command: string;
  args: string[];
  acceptsFileArgs: boolean;
}

export function parseAutocodeSyntaxErrors(output: string): AutocodeValidationFailure[] {
  const failures: AutocodeValidationFailure[] = [];

  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+)$/);
    if (match) {
      failures.push({
        type: 'syntax',
        severity: match[4] === 'error' ? 'error' : 'warning',
        message: match[5],
        file: match[1],
        line: Number.parseInt(match[2], 10),
        suggestion: 'Fix syntax error or run auto-fix if available',
      });
    }
  }

  if (failures.length === 0 && output.trim()) {
    failures.push({
      type: 'syntax',
      severity: 'error',
      message: output.split('\n')[0],
      suggestion: 'Review linter output and fix issues',
    });
  }

  return failures;
}

export function parseAutocodeTypeErrors(output: string): AutocodeValidationFailure[] {
  const failures: AutocodeValidationFailure[] = [];

  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)$/);
    if (match) {
      failures.push({
        type: 'type',
        severity: 'error',
        message: match[4],
        file: match[1],
        line: Number.parseInt(match[2], 10),
        suggestion: 'Fix type error or add proper type annotations',
      });
    }
  }

  if (failures.length === 0 && output.trim()) {
    failures.push({
      type: 'type',
      severity: 'error',
      message: output.split('\n')[0],
      suggestion: 'Review TypeScript errors and fix type issues',
    });
  }

  return failures;
}

export function parseAutocodeSecurityIssues(output: string): AutocodeValidationFailure[] {
  const failures: AutocodeValidationFailure[] = [];

  for (const line of output.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }

    failures.push({
      type: 'security',
      severity: 'error',
      message: line.slice(separator + 1).trim(),
      file: line.slice(0, separator).trim(),
      suggestion: 'Move secrets to environment variables or fix security vulnerability',
    });
  }

  return failures;
}

export function scanAutocodeSecurityIssuesInContent(file: string, content: string): string[] {
  const issues: string[] = [];
  const secretPatterns = [
    /api[_-]?key\s*=\s*['"][^'"]{8,}['"]/i,
    /secret\s*=\s*['"][^'"]{8,}['"]/i,
    /password\s*=\s*['"][^'"]{8,}['"]/i,
    /token\s*=\s*['"][^'"]{8,}['"]/i,
  ];

  for (const pattern of secretPatterns) {
    if (pattern.test(content)) {
      issues.push(`${file}: Potential hardcoded secret detected`);
    }
  }

  if (/\$\{.*\}/.test(content) && /SELECT|INSERT|UPDATE|DELETE/i.test(content)) {
    issues.push(`${file}: Potential SQL injection vulnerability (string interpolation in SQL)`);
  }

  if (/\beval\s*\(/.test(content)) {
    issues.push(`${file}: Dangerous eval() usage detected`);
  }

  if (/dangerouslySetInnerHTML/.test(content)) {
    issues.push(`${file}: XSS risk - dangerouslySetInnerHTML usage`);
  }

  return issues;
}

export function checkAutocodePatternComplianceContent(
  modifiedFile: string,
  modifiedContent: string,
  patternContent: string,
): string[] {
  const issues: string[] = [];
  const patternImportStyle = /^import .* from ['"]/.test(patternContent) ? 'es6' : 'commonjs';
  const modifiedImportStyle = /^import .* from ['"]/.test(modifiedContent) ? 'es6' : 'commonjs';

  if (patternImportStyle !== modifiedImportStyle) {
    issues.push(`${modifiedFile}: Import style does not match pattern (expected ${patternImportStyle})`);
  }

  if (/try\s*\{/.test(patternContent) && !/try\s*\{/.test(modifiedContent)) {
    issues.push(`${modifiedFile}: Missing try-catch error handling (pattern uses it)`);
  }

  return issues;
}

export function resolveAutocodeProjectTestCommand(script: string | undefined): string {
  const value = script ?? '';
  if (/\bvitest\s+run\b/i.test(value)) {
    return 'npm test';
  }
  if (/\bvitest\b/i.test(value)) {
    return 'npm test -- --run';
  }
  if (/\bjest\b/i.test(value)) {
    return 'npm test -- --passWithNoTests';
  }
  return 'npm test';
}

export function detectAutocodeLintCommandFromPackageJson(packageJson: Record<string, unknown>): AutocodeCommandSpec | null {
  const scripts = packageJson.scripts && typeof packageJson.scripts === 'object'
    ? packageJson.scripts as Record<string, unknown>
    : {};
  const devDependencies = packageJson.devDependencies && typeof packageJson.devDependencies === 'object'
    ? packageJson.devDependencies as Record<string, unknown>
    : {};
  const dependencies = packageJson.dependencies && typeof packageJson.dependencies === 'object'
    ? packageJson.dependencies as Record<string, unknown>
    : {};

  if (scripts.lint) {
    return { command: 'npm', args: ['run', 'lint'], acceptsFileArgs: false };
  }
  if (devDependencies.eslint || dependencies.eslint) {
    return { command: 'npx', args: ['eslint'], acceptsFileArgs: true };
  }
  if (devDependencies['@biomejs/biome']) {
    return { command: 'npx', args: ['biome', 'check'], acceptsFileArgs: true };
  }
  return null;
}

export function detectAutocodeTypecheckCommandFromPackageJson(packageJson: Record<string, unknown>): AutocodeCommandSpec {
  const scripts = packageJson.scripts && typeof packageJson.scripts === 'object'
    ? packageJson.scripts as Record<string, unknown>
    : {};

  if (scripts.typecheck) {
    return { command: 'npm', args: ['run', 'typecheck'], acceptsFileArgs: false };
  }
  return { command: 'npx', args: ['tsc', '--noEmit'], acceptsFileArgs: false };
}

export function detectAutocodeTestCommandFromPackageJson(packageJson: Record<string, unknown>): AutocodeCommandSpec | null {
  const scripts = packageJson.scripts && typeof packageJson.scripts === 'object'
    ? packageJson.scripts as Record<string, unknown>
    : {};

  if (scripts.test) {
    return { command: 'npm', args: ['test', '--'], acceptsFileArgs: true };
  }
  return null;
}

export function generateAutocodeSmokeSuggestion(
  check: Pick<AutocodeSmokeCheckDescriptor, 'type'>,
  result: Pick<AutocodeSmokeCheckResult, 'stderr'>,
): string | undefined {
  switch (check.type) {
    case 'syntax':
      if (result.stderr?.includes('Parsing error')) {
        return 'Fix syntax errors before proceeding. Run `npm run lint:fix` to auto-fix.';
      }
      return 'Run `npm run lint:fix` to automatically fix linting issues.';
    case 'type':
      if (result.stderr?.includes('TS2304')) {
        return 'Missing type definitions. Check imports and installed @types packages.';
      }
      if (result.stderr?.includes('TS2345')) {
        return 'Type mismatch detected. Review function signatures and arguments.';
      }
      return 'Fix TypeScript errors. Review the error output for specific issues.';
    case 'security':
      return 'Potential secrets detected in code. Move sensitive values to environment variables.';
    case 'test':
      if (result.stderr?.includes('FAIL')) {
        return 'Unit tests failing. Fix test failures before QA review.';
      }
      return 'Tests not passing. Review test output and fix failures.';
    case 'build':
      if (result.stderr?.includes('Module not found')) {
        return 'Missing dependencies. Run `npm install` to install missing packages.';
      }
      return 'Build failed. Review build output for specific errors.';
  }
}

export function shouldAutocodeReturnToCoding(
  issues: readonly AutocodeSmokeTestIssue[],
  checks: readonly AutocodeSmokeCheckDescriptor[],
): boolean {
  return issues.some((issue) => (
    issue.severity === 'critical' &&
    checks.find((check) => check.name === issue.check)?.required
  ));
}

export function formatAutocodeSmokeTestResults(result: AutocodeSmokeTestResult): string {
  const lines: string[] = [];

  lines.push('=== Pre-QA Smoke Tests ===\n');
  lines.push(`Status: ${result.passed ? 'PASSED' : 'FAILED'}`);
  lines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push(`Checks run: ${result.checks.length}\n`);

  if (result.issues.length > 0) {
    lines.push('Issues found:\n');
    for (const issue of result.issues) {
      const severity = issue.severity === 'critical' ? 'CRITICAL' : 'WARNING';
      lines.push(`${severity} [${issue.type}] ${issue.check}`);
      lines.push(`  ${issue.output.split('\n')[0]}`);
      if (issue.suggestion) {
        lines.push(`  Suggestion: ${issue.suggestion}`);
      }
      lines.push('');
    }
  }

  if (result.shouldReturnToCoding) {
    lines.push('Critical issues found - returning to coding phase for fixes.\n');
  }

  return lines.join('\n');
}

export function formatAutocodeValidationResults(result: AutocodeIncrementalValidationResult): string {
  const lines: string[] = [];

  lines.push('=== Incremental Validation ===\n');
  lines.push(`Status: ${result.passed ? 'PASSED' : 'FAILED'}`);
  lines.push(`Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
  lines.push(`Checks: ${result.checks.filter((check) => check.passed).length}/${result.checks.length} passed\n`);

  if (result.failures.length > 0) {
    lines.push('Issues found:\n');
    for (const failure of result.failures) {
      const severity = failure.severity === 'error' ? 'ERROR' : 'WARNING';
      const location = failure.file ? ` (${failure.file}${failure.line ? `:${failure.line}` : ''})` : '';
      lines.push(`${severity} [${failure.type}] ${failure.message}${location}`);
      if (failure.suggestion) {
        lines.push(`  Suggestion: ${failure.suggestion}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
