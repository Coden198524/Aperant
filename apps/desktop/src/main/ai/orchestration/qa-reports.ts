/**
 * QA Report Generation
 * ====================
 *
 * Handles:
 * - QA summary report (qa_report.md)
 * - Escalation report (QA_ESCALATION.md)
 * - Manual test plan (MANUAL_TEST_PLAN.md)
 * - Issue similarity detection
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { QAIssue, QAIterationRecord } from './qa-loop';

// =============================================================================
// Constants
// =============================================================================

const RECURRING_ISSUE_THRESHOLD = 3;
const ISSUE_SIMILARITY_THRESHOLD = 0.8;
const MAX_QA_ITERATIONS = 50;

// =============================================================================
// Issue Similarity
// =============================================================================

/**
 * Normalize an issue into a comparison key.
 * Strips common prefixes and lowercases.
 */
function normalizeIssueKey(issue: QAIssue): string {
  let title = (issue.title ?? '').toLowerCase().trim();
  const location = (issue.location ?? '').toLowerCase().trim();

  for (const prefix of ['error:', 'issue:', 'bug:', 'fix:']) {
    if (title.startsWith(prefix)) {
      title = title.slice(prefix.length).trim();
    }
  }

  return `${title}|${location}`;
}

/**
 * Tokenize a string into a set of words.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 0),
  );
}

/**
 * Calculate normalized token overlap (Jaccard similarity) between two strings.
 */
function tokenOverlap(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Determine whether two QA issues are similar based on title + description overlap.
 *
 * @param a First issue
 * @param b Second issue
 * @param threshold Minimum overlap score (default: 0.8)
 */
export function issuesSimilar(a: QAIssue, b: QAIssue, threshold = ISSUE_SIMILARITY_THRESHOLD): boolean {
  const keyA = normalizeIssueKey(a);
  const keyB = normalizeIssueKey(b);

  const textA = `${keyA} ${(a.description ?? '').toLowerCase().trim()}`;
  const textB = `${keyB} ${(b.description ?? '').toLowerCase().trim()}`;

  return tokenOverlap(textA, textB) >= threshold;
}

// =============================================================================
// Report Generation
// =============================================================================

/**
 * Generate a QA summary report for display in the UI.
 * Written to specDir/qa_report.md.
 *
 * @param iterations Full iteration history
 * @param finalStatus Overall outcome
 */
export function generateQAReport(
  iterations: QAIterationRecord[],
  finalStatus: 'approved' | 'escalated' | 'max_iterations',
): string {
  const now = new Date().toISOString();
  const totalIterations = iterations.length;
  const approvedIterations = iterations.filter((record) => record.status === 'approved').length;
  const rejectedIterations = iterations.filter((record) => record.status === 'rejected').length;
  const errorIterations = iterations.filter((record) => record.status === 'error').length;
  const totalIssues = iterations.reduce((sum, record) => sum + record.issues.length, 0);
  const totalDurationMs = iterations.reduce((sum, record) => sum + record.durationMs, 0);
  const totalDurationSec = (totalDurationMs / 1000).toFixed(1);

  const statusLabel =
    finalStatus === 'approved'
      ? 'APPROVED'
      : finalStatus === 'escalated'
        ? 'ESCALATED'
        : 'MAX ITERATIONS REACHED';
  const resultLabel = finalStatus === 'approved' ? 'PASSED' : 'FAILED';

  let report = `# QA Report

**Generated**: ${now}
**Final status**: ${statusLabel}
**Result**: ${resultLabel}

## Summary

| Metric | Value |
| --- | --- |
| Total iterations | ${totalIterations} |
| Approved iterations | ${approvedIterations} |
| Rejected iterations | ${rejectedIterations} |
| Error iterations | ${errorIterations} |
| Total issues found | ${totalIssues} |
| Total duration | ${totalDurationSec}s |

`;

  if (iterations.length === 0) {
    report += '## Iteration History\n\nNo QA iterations were recorded.\n';
    return report;
  }

  report += '## Iteration History\n\n';

  for (const record of iterations) {
    const durationSec = (record.durationMs / 1000).toFixed(1);
    const statusText = record.status === 'approved' ? 'approved' : record.status === 'rejected' ? 'rejected' : 'error';

    report += `### Iteration ${record.iteration} - ${statusText}\n\n`;
    report += `- **Status**: ${record.status}\n`;
    report += `- **Duration**: ${durationSec}s\n`;
    report += `- **Timestamp**: ${record.timestamp}\n`;
    report += `- **Issues found**: ${record.issues.length}\n`;

    if (record.issues.length > 0) {
      report += '\n#### Issues\n\n';
      for (const issue of record.issues) {
        const typeTag = issue.type ? ` \`[${issue.type.toUpperCase()}]\`` : '';
        report += `- **${issue.title}**${typeTag}\n`;
        if (issue.location) {
          report += `  - Location: \`${issue.location}\`\n`;
        }
        if (issue.description) {
          report += `  - ${issue.description}\n`;
        }
        if (issue.fix_required) {
          report += `  - Required fix: ${issue.fix_required}\n`;
        }
      }
    }

    report += '\n';
  }

  if (finalStatus === 'approved') {
    report += '## Outcome\n\nQA verification passed. The implementation satisfies the acceptance criteria.\n';
  } else if (finalStatus === 'max_iterations') {
    report += `## Outcome\n\nQA reached the maximum of ${MAX_QA_ITERATIONS} iterations without approval. Manual review is required.\n`;
  } else {
    report += '## Outcome\n\nRecurring issues caused QA to escalate to manual review. See QA_ESCALATION.md for details.\n';
  }

  return report;
}

/**
 * Generate an escalation report for recurring QA issues.
 * Written to specDir/QA_ESCALATION.md.
 *
 * @param iterations Full iteration history
 * @param recurringIssues Issues that have recurred beyond the threshold
 */
export function generateEscalationReport(
  iterations: QAIterationRecord[],
  recurringIssues: QAIssue[],
): string {
  const now = new Date().toISOString();
  const totalIterations = iterations.length;
  const totalIssues = iterations.reduce((sum, record) => sum + record.issues.length, 0);
  const uniqueIssueTitles = new Set(
    iterations.flatMap((record) => record.issues.map((issue) => issue.title.toLowerCase())),
  ).size;
  const approvedCount = iterations.filter((record) => record.status === 'approved').length;
  const fixSuccessRate = totalIterations > 0 ? (approvedCount / totalIterations).toFixed(1) : '0';

  const titleCounts = new Map<string, number>();
  for (const record of iterations) {
    for (const issue of record.issues) {
      const key = issue.title.toLowerCase().trim();
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
  }
  const topIssues = [...titleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  let report = `# QA Escalation - Manual Review Required

**Generated**: ${now}
**Iterations**: ${totalIterations}/${MAX_QA_ITERATIONS}
**Reason**: Recurring issues were detected ${RECURRING_ISSUE_THRESHOLD}+ times.

## Summary

- **Total QA iterations**: ${totalIterations}
- **Total issues found**: ${totalIssues}
- **Unique issue titles**: ${uniqueIssueTitles}
- **Fix success rate**: ${fixSuccessRate}%

## Recurring Issues

These issues have recurred ${RECURRING_ISSUE_THRESHOLD}+ times and still need attention.

`;

  for (let i = 0; i < recurringIssues.length; i++) {
    const issue = recurringIssues[i];
    report += `### ${i + 1}. ${issue.title}\n\n`;
    report += `- **Location**: ${issue.location ?? 'none'}\n`;
    report += `- **Type**: ${issue.type ?? 'none'}\n`;
    if (issue.description) {
      report += `- **Description**: ${issue.description}\n`;
    }
    if (issue.fix_required) {
      report += `- **Required fix**: ${issue.fix_required}\n`;
    }
    report += '\n';
  }

  if (topIssues.length > 0) {
    report += '## Most Common Issues\n\n';
    for (const [title, count] of topIssues) {
      report += `- **${title}** (${count} times)\n`;
    }
    report += '\n';
  }

  report += `## Recommended Actions

1. Manually inspect the recurring issues.
2. Check whether the root cause is unclear requirements, complex edge cases, infrastructure problems, or test framework limitations.
3. Update the spec or acceptance criteria when needed.
4. Add human fix notes in \`QA_FIX_REQUEST.md\` and rerun QA.

## Related Files

- \`QA_FIX_REQUEST.md\` - manual fix instructions
- \`qa_report.md\` - latest QA summary
- \`implementation_plan.md\` - implementation and QA state
`;

  return report;
}

/**
 * Generate a manual test plan for projects with no automated test framework.
 * Written to specDir/MANUAL_TEST_PLAN.md.
 *
 * @param specDir Spec directory path
 * @param projectDir Project root directory path
 */
export async function generateManualTestPlan(specDir: string, projectDir: string): Promise<string> {
  const now = new Date().toISOString();
  const specName = specDir.split(/[\\/]/).pop() ?? specDir;

  let specContent = '';
  try {
    specContent = await readFile(join(specDir, 'spec.md'), 'utf-8');
  } catch {
    // spec.md is optional.
  }

  const acceptanceCriteria: string[] = [];
  if (specContent.includes('## Acceptance Criteria')) {
    let inCriteria = false;
    for (const line of specContent.split('\n')) {
      if (line.includes('## Acceptance Criteria')) {
        inCriteria = true;
        continue;
      }
      if (inCriteria && line.startsWith('## ')) {
        break;
      }
      if (inCriteria && line.trim().startsWith('- ')) {
        acceptanceCriteria.push(line.trim().slice(2));
      }
    }
  }

  const noTest = isNoTestProject(specDir, projectDir);

  let plan = `# Manual Test Plan - ${specName}

**Generated**: ${now}
**Reason**: ${noTest ? 'No automated test infrastructure detected' : 'Supplemental manual verification'}

## Overview

${noTest
  ? 'This project does not appear to have automated tests. Use this checklist for manual verification.'
  : 'Use this checklist to supplement automated test coverage.'}

## Before Testing

1. [ ] Install all dependencies.
2. [ ] Start required services.
3. [ ] Configure test environment variables.

## Acceptance Criteria Verification

`;

  if (acceptanceCriteria.length > 0) {
    for (let i = 0; i < acceptanceCriteria.length; i++) {
      plan += `${i + 1}. [ ] ${acceptanceCriteria[i]}\n`;
    }
  } else {
    plan += `1. [ ] Core functionality works as expected.
2. [ ] Edge cases are handled.
3. [ ] Error states are handled cleanly.
4. [ ] UI/UX meets requirements when applicable.
`;
  }

  plan += `

## Functional Tests

### Happy Path
- [ ] Primary use case works.
- [ ] Expected output is produced.
- [ ] No console errors are observed.

### Edge Cases
- [ ] Empty input is handled.
- [ ] Invalid input is handled.
- [ ] Boundary conditions are handled.

### Error Handling
- [ ] Errors display appropriate messages.
- [ ] The system recovers gracefully.
- [ ] Failed operations do not lose data.

## Non-Functional Tests

### Performance
- [ ] Response time is acceptable.
- [ ] No memory leak is observed.
- [ ] Resource usage is reasonable.

### Security
- [ ] Input is sanitized.
- [ ] No sensitive data is exposed.
- [ ] Authentication works when applicable.

## Browser / Environment Tests

- [ ] Chrome
- [ ] Firefox
- [ ] Safari
- [ ] Mobile viewport

## Sign-Off

**Tester**: _______________
**Date**: _______________
**Result**: [ ] Pass  [ ] Fail

### Notes
_Add observations or issues found during manual testing._

`;

  return plan;
}

// =============================================================================
// No-Test Project Detection
// =============================================================================

/**
 * Determine if the project has no automated test infrastructure.
 *
 * @param specDir Spec directory
 * @param projectDir Project root directory
 */
export function isNoTestProject(specDir: string, projectDir: string): boolean {
  const testConfigFiles = [
    'pytest.ini',
    'pyproject.toml',
    'setup.cfg',
    'jest.config.js',
    'jest.config.ts',
    'vitest.config.js',
    'vitest.config.ts',
    'karma.conf.js',
    'cypress.config.js',
    'playwright.config.ts',
    '.rspec',
    join('spec', 'spec_helper.rb'),
  ];

  for (const configFile of testConfigFiles) {
    if (existsSync(join(projectDir, configFile))) {
      return false;
    }
  }

  const testDirs = ['tests', 'test', '__tests__', 'spec'];
  const testFilePatterns = [
    /^test_.*\.(py|js|ts)$/,
    /.*_test\.(py|js|ts)$/,
    /.*\.spec\.(js|ts)$/,
    /.*\.test\.(js|ts)$/,
  ];

  for (const testDir of testDirs) {
    const testDirPath = join(projectDir, testDir);
    if (!existsSync(testDirPath)) continue;

    try {
      const entries = readdirSync(testDirPath);
      for (const entry of entries) {
        for (const pattern of testFilePatterns) {
          if (pattern.test(entry)) {
            return false;
          }
        }
      }
    } catch {
      // Ignore unreadable test directories.
    }
  }

  return true;
}
