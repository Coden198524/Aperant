/**
 * Pure self-critique scoring for generated agent code.
 */

export interface AutocodeSelfCritiqueInput {
  generatedFiles: AutocodeGeneratedFile[];
  subtask: {
    id: string;
    description: string;
    filesToModify?: string[];
    patternFiles?: string[];
  };
  patternContents?: string[];
  minScore?: number;
}

export interface AutocodeGeneratedFile {
  path: string;
  content: string;
  isNew: boolean;
}

export interface AutocodeCritiqueResult {
  score: number;
  passed: boolean;
  checks: AutocodeCritiqueCheck[];
  feedback: string;
  improvements: string[];
}

export interface AutocodeCritiqueCheck {
  name: string;
  category: 'pattern' | 'error_handling' | 'security' | 'test_coverage' | 'performance' | 'quality';
  weight: number;
  score: number;
  passed: boolean;
  issues: string[];
  suggestions: string[];
}

export function runAutocodeSelfCritique(input: AutocodeSelfCritiqueInput): AutocodeCritiqueResult {
  const minScore = input.minScore ?? 0.8;
  const checks = [
    checkAutocodePatternAdherence(input),
    checkAutocodeErrorHandling(input.generatedFiles),
    checkAutocodeSecurity(input.generatedFiles),
    checkAutocodeTestCoverage(input),
    checkAutocodePerformance(input.generatedFiles),
  ];

  const score = checks.reduce((sum, check) => sum + check.score * check.weight, 0);
  const passed = score >= minScore;

  return {
    score,
    passed,
    checks,
    feedback: generateAutocodeCritiqueFeedback(checks, score, minScore),
    improvements: generateAutocodeCritiqueImprovements(checks),
  };
}

export function checkAutocodePatternAdherence(input: AutocodeSelfCritiqueInput): AutocodeCritiqueCheck {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let score = 1.0;
  const patterns = input.patternContents ?? [];

  if (!input.subtask.patternFiles || input.subtask.patternFiles.length === 0) {
    return {
      name: 'Pattern Adherence',
      category: 'pattern',
      weight: 0.3,
      score: 1.0,
      passed: true,
      issues: [],
      suggestions: ['No pattern files provided - skipping pattern check'],
    };
  }

  if (patterns.length === 0) {
    return {
      name: 'Pattern Adherence',
      category: 'pattern',
      weight: 0.3,
      score: 0.5,
      passed: false,
      issues: ['Failed to load pattern files'],
      suggestions: ['Verify pattern file paths and retry the critique'],
    };
  }

  for (const file of input.generatedFiles) {
    const hasEsImports = /^import .* from ['"]/.test(file.content);
    const patternHasEsImports = patterns.some((pattern) => /^import .* from ['"]/.test(pattern));

    if (patternHasEsImports && !hasEsImports) {
      issues.push(`${file.path}: Import style does not match pattern (expected ES module imports)`);
      suggestions.push('Use ES module import syntax: import { x } from "module"');
      score -= 0.2;
    }

    const hasTryCatch = /try\s*\{[\s\S]*\}\s*catch/.test(file.content);
    const patternHasTryCatch = patterns.some((pattern) => /try\s*\{[\s\S]*\}\s*catch/.test(pattern));

    if (patternHasTryCatch && !hasTryCatch && /async|await|Promise/.test(file.content)) {
      issues.push(`${file.path}: Missing try-catch error handling (pattern uses it)`);
      suggestions.push('Add try-catch blocks for async operations');
      score -= 0.15;
    }

    const patternFunctionStyle = patterns.some((pattern) => /function\s+[a-z][a-zA-Z]*/.test(pattern))
      ? 'camelCase'
      : 'unknown';
    const hasSnakeCaseFunctions = /function\s+[a-z]+_[a-z]+/.test(file.content);

    if (patternFunctionStyle === 'camelCase' && hasSnakeCaseFunctions) {
      issues.push(`${file.path}: Function naming does not match pattern (expected camelCase)`);
      suggestions.push('Use camelCase for function names');
      score -= 0.1;
    }
  }

  return {
    name: 'Pattern Adherence',
    category: 'pattern',
    weight: 0.3,
    score: Math.max(0, score),
    passed: score >= 0.7,
    issues,
    suggestions,
  };
}

export function checkAutocodeErrorHandling(files: readonly AutocodeGeneratedFile[]): AutocodeCritiqueCheck {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let score = 1.0;

  for (const file of files) {
    const hasAsync = /async|await|Promise/.test(file.content);
    const hasTryCatch = /try\s*\{[\s\S]*\}\s*catch/.test(file.content);
    const hasCatch = /\.catch\(/.test(file.content);

    if (hasAsync && !hasTryCatch && !hasCatch) {
      issues.push(`${file.path}: Async operations without error handling`);
      suggestions.push('Wrap async operations in try-catch or use .catch()');
      score -= 0.3;
    }

    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(file.content)) {
      issues.push(`${file.path}: Empty catch block - errors are silently swallowed`);
      suggestions.push('Log errors or handle them appropriately');
      score -= 0.2;
    }

    if (/throw new Error\(['"]error['"]\)/.test(file.content)) {
      issues.push(`${file.path}: Generic error message "error"`);
      suggestions.push('Use descriptive error messages');
      score -= 0.1;
    }
  }

  return {
    name: 'Error Handling',
    category: 'error_handling',
    weight: 0.2,
    score: Math.max(0, score),
    passed: score >= 0.7,
    issues,
    suggestions,
  };
}

export function checkAutocodeSecurity(files: readonly AutocodeGeneratedFile[]): AutocodeCritiqueCheck {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let score = 1.0;

  for (const file of files) {
    const secretPatterns = [
      { pattern: /api[_-]?key\s*=\s*['"][^'"]{8,}['"]/i, message: 'Hardcoded API key' },
      { pattern: /password\s*=\s*['"][^'"]{4,}['"]/i, message: 'Hardcoded password' },
      { pattern: /secret\s*=\s*['"][^'"]{8,}['"]/i, message: 'Hardcoded secret' },
      { pattern: /token\s*=\s*['"][^'"]{8,}['"]/i, message: 'Hardcoded token' },
    ];

    for (const { pattern, message } of secretPatterns) {
      if (pattern.test(file.content)) {
        issues.push(`${file.path}: ${message} detected`);
        suggestions.push('Move secrets to environment variables');
        score -= 0.4;
      }
    }

    if (hasInterpolatedSqlTemplate(file.content)) {
      issues.push(`${file.path}: Potential SQL injection (string interpolation in SQL)`);
      suggestions.push('Use parameterized queries or prepared statements');
      score -= 0.5;
    }

    if (/\beval\s*\(/.test(file.content)) {
      issues.push(`${file.path}: Dangerous eval() usage`);
      suggestions.push('Remove eval() - it executes arbitrary code');
      score -= 0.4;
    }

    if (/dangerouslySetInnerHTML/.test(file.content)) {
      issues.push(`${file.path}: XSS risk - dangerouslySetInnerHTML usage`);
      suggestions.push('Sanitize HTML or use safe alternatives');
      score -= 0.3;
    }

    if (/req\.(body|query|params)/.test(file.content) && !/validate|schema|zod/.test(file.content)) {
      issues.push(`${file.path}: Missing input validation on user data`);
      suggestions.push('Validate all user inputs with Zod or similar');
      score -= 0.2;
    }
  }

  return {
    name: 'Security',
    category: 'security',
    weight: 0.25,
    score: Math.max(0, score),
    passed: score >= 0.8,
    issues,
    suggestions,
  };
}

function hasInterpolatedSqlTemplate(content: string): boolean {
  const templatePattern = /`(?:\\.|[^`\\])*`/gs;
  for (const match of content.matchAll(templatePattern)) {
    const template = match[0];
    if (!template.includes('${')) {
      continue;
    }
    if (/\bselect\b[\s\S]*\bfrom\b/i.test(template)) {
      return true;
    }
    if (/\binsert\s+into\b/i.test(template)) {
      return true;
    }
    if (/\bupdate\s+[`"[\]\w.]+\s+set\b/i.test(template)) {
      return true;
    }
    if (/\bdelete\s+from\b/i.test(template)) {
      return true;
    }
  }
  return false;
}

export function checkAutocodeTestCoverage(input: Pick<AutocodeSelfCritiqueInput, 'generatedFiles'>): AutocodeCritiqueCheck {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let score = 1.0;

  const testFiles = input.generatedFiles.filter((file) => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file.path));
  const codeFiles = input.generatedFiles.filter((file) => !/\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file.path));

  if (codeFiles.length > 0 && testFiles.length === 0) {
    issues.push('No test files generated');
    suggestions.push('Add unit tests for new functionality');
    score -= 0.5;
  }

  for (const testFile of testFiles) {
    if (!/expect\(|assert\(|should/.test(testFile.content)) {
      issues.push(`${testFile.path}: No assertions found in test file`);
      suggestions.push('Add expect() assertions to verify behavior');
      score -= 0.3;
    }

    if (!/it\(['"]|test\(['"]/.test(testFile.content)) {
      issues.push(`${testFile.path}: No test cases defined`);
      suggestions.push('Add test cases with descriptive names');
      score -= 0.2;
    }
  }

  return {
    name: 'Test Coverage',
    category: 'test_coverage',
    weight: 0.15,
    score: Math.max(0, score),
    passed: score >= 0.6,
    issues,
    suggestions,
  };
}

export function checkAutocodePerformance(files: readonly AutocodeGeneratedFile[]): AutocodeCritiqueCheck {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let score = 1.0;

  for (const file of files) {
    if (/for\s*\([^)]*\)\s*\{[\s\S]*for\s*\([^)]*\)/.test(file.content)) {
      issues.push(`${file.path}: Nested loops detected - potential O(n^2) complexity`);
      suggestions.push('Consider using Map/Set for O(1) lookups');
      score -= 0.2;
    }

    if (/export (default )?function [A-Z]/.test(file.content) && !/React\.memo|memo\(/.test(file.content)) {
      if (file.content.length > 500) {
        issues.push(`${file.path}: Large component without React.memo`);
        suggestions.push('Wrap expensive components with React.memo');
        score -= 0.15;
      }
    }

    if (/readFileSync|writeFileSync/.test(file.content)) {
      issues.push(`${file.path}: Synchronous file operations block event loop`);
      suggestions.push('Use async file operations (readFile, writeFile)');
      score -= 0.2;
    }

    if (/findAll|find\(\)/.test(file.content) && !/limit|take|paginate/.test(file.content)) {
      issues.push(`${file.path}: Database query without pagination`);
      suggestions.push('Add pagination to prevent loading too much data');
      score -= 0.15;
    }
  }

  return {
    name: 'Performance',
    category: 'performance',
    weight: 0.1,
    score: Math.max(0, score),
    passed: score >= 0.7,
    issues,
    suggestions,
  };
}

export function generateAutocodeCritiqueFeedback(
  checks: readonly AutocodeCritiqueCheck[],
  score: number,
  minScore: number,
): string {
  const lines: string[] = [];

  lines.push('## Self-Critique Results\n');
  lines.push(`**Overall Score**: ${(score * 100).toFixed(1)}% (minimum: ${(minScore * 100).toFixed(0)}%)`);
  lines.push(`**Status**: ${score >= minScore ? 'PASSED' : 'FAILED'}\n`);

  if (score < minScore) {
    lines.push('**Your code does not meet quality standards. Please address the issues below.**\n');
  }

  const failedChecks = checks.filter((check) => !check.passed);
  if (failedChecks.length > 0) {
    lines.push('### Failed Checks:\n');
    for (const check of failedChecks) {
      lines.push(`**${check.name}**: ${(check.score * 100).toFixed(0)}%`);
      if (check.issues.length > 0) {
        lines.push('Issues:');
        for (const issue of check.issues) {
          lines.push(`- ${issue}`);
        }
      }
      if (check.suggestions.length > 0) {
        lines.push('Suggestions:');
        for (const suggestion of check.suggestions) {
          lines.push(`- ${suggestion}`);
        }
      }
      lines.push('');
    }
  }

  lines.push('### All Checks:\n');
  for (const check of checks) {
    const status = check.passed ? 'PASS' : 'FAIL';
    lines.push(`${status} **${check.name}**: ${(check.score * 100).toFixed(0)}% (weight: ${(check.weight * 100).toFixed(0)}%)`);
  }

  return lines.join('\n');
}

export function generateAutocodeCritiqueImprovements(checks: readonly AutocodeCritiqueCheck[]): string[] {
  const weighted = checks
    .filter((check) => !check.passed)
    .flatMap((check) => check.suggestions.map((suggestion) => ({ suggestion, weight: check.weight })));

  weighted.sort((a, b) => b.weight - a.weight);

  const seen = new Set<string>();
  const improvements: string[] = [];
  for (const item of weighted) {
    if (!seen.has(item.suggestion)) {
      seen.add(item.suggestion);
      improvements.push(item.suggestion);
    }
  }

  return improvements;
}

export function formatAutocodeCritiqueSummary(result: AutocodeCritiqueResult): string {
  const failedCount = result.checks.filter((check) => !check.passed).length;
  return `Self-Critique: ${(result.score * 100).toFixed(1)}% (${result.passed ? 'PASSED' : 'FAILED'}) - ${failedCount}/${result.checks.length} checks failed`;
}
