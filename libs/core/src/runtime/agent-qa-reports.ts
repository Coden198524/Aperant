/**
 * Pure QA report generation helpers shared by all agent hosts.
 */

export const AUTOCODE_QA_RECURRING_ISSUE_THRESHOLD = 3;
export const AUTOCODE_QA_ISSUE_SIMILARITY_THRESHOLD = 0.8;
export const AUTOCODE_QA_MAX_ITERATIONS = 50;

export interface AutocodeQAIssue {
  title: string;
  description?: string;
  location?: string;
  fix_required?: string;
  type?: string;
}

export interface AutocodeQAIterationRecord {
  iteration: number;
  status: 'approved' | 'rejected' | 'error' | string;
  issues: AutocodeQAIssue[];
  durationMs: number;
  timestamp: string;
}

export type AutocodeQAFinalStatus = 'approved' | 'escalated' | 'max_iterations';

export interface AutocodeManualTestPlanInput {
  specName: string;
  specContent?: string;
  noTest: boolean;
  generatedAt?: string;
}

export function autocodeQaIssuesSimilar(
  a: AutocodeQAIssue,
  b: AutocodeQAIssue,
  threshold = AUTOCODE_QA_ISSUE_SIMILARITY_THRESHOLD,
): boolean {
  const keyA = normalizeAutocodeIssueKey(a);
  const keyB = normalizeAutocodeIssueKey(b);
  const textA = `${keyA} ${(a.description ?? '').toLowerCase().trim()}`;
  const textB = `${keyB} ${(b.description ?? '').toLowerCase().trim()}`;

  return autocodeTokenOverlap(textA, textB) >= threshold;
}

export function generateAutocodeQAReport(
  iterations: readonly AutocodeQAIterationRecord[],
  finalStatus: AutocodeQAFinalStatus,
  generatedAt = new Date().toISOString(),
): string {
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

**Generated**: ${generatedAt}
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
    report += `## Outcome\n\nQA reached the maximum of ${AUTOCODE_QA_MAX_ITERATIONS} iterations without approval. Manual review is required.\n`;
  } else {
    report += '## Outcome\n\nRecurring issues caused QA to escalate to manual review. See QA_ESCALATION.md for details.\n';
  }

  return report;
}

export function generateAutocodeQAEscalationReport(
  iterations: readonly AutocodeQAIterationRecord[],
  recurringIssues: readonly AutocodeQAIssue[],
  generatedAt = new Date().toISOString(),
): string {
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

**Generated**: ${generatedAt}
**Iterations**: ${totalIterations}/${AUTOCODE_QA_MAX_ITERATIONS}
**Reason**: Recurring issues were detected ${AUTOCODE_QA_RECURRING_ISSUE_THRESHOLD}+ times.

## Summary

- **Total QA iterations**: ${totalIterations}
- **Total issues found**: ${totalIssues}
- **Unique issue titles**: ${uniqueIssueTitles}
- **Fix success rate**: ${fixSuccessRate}%

## Recurring Issues

These issues have recurred ${AUTOCODE_QA_RECURRING_ISSUE_THRESHOLD}+ times and still need attention.

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

export function extractAutocodeAcceptanceCriteria(specContent: string): string[] {
  const acceptanceCriteria: string[] = [];

  if (!specContent.includes('## Acceptance Criteria')) {
    return acceptanceCriteria;
  }

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

  return acceptanceCriteria;
}

export function generateAutocodeManualTestPlan(input: AutocodeManualTestPlanInput): string {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const acceptanceCriteria = extractAutocodeAcceptanceCriteria(input.specContent ?? '');

  let plan = `# Manual Test Plan - ${input.specName}

**Generated**: ${generatedAt}
**Reason**: ${input.noTest ? 'No automated test infrastructure detected' : 'Supplemental manual verification'}

## Overview

${input.noTest
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

function normalizeAutocodeIssueKey(issue: AutocodeQAIssue): string {
  let title = (issue.title ?? '').toLowerCase().trim();
  const location = (issue.location ?? '').toLowerCase().trim();

  for (const prefix of ['error:', 'issue:', 'bug:', 'fix:']) {
    if (title.startsWith(prefix)) {
      title = title.slice(prefix.length).trim();
    }
  }

  return `${title}|${location}`;
}

function autocodeTokenOverlap(a: string, b: string): number {
  const setA = tokenizeAutocodeText(a);
  const setB = tokenizeAutocodeText(b);

  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection++;
    }
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenizeAutocodeText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((token) => token.length > 0),
  );
}
