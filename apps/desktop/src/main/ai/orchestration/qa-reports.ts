/**
 * QA Report Generation
 * ====================
 *
 * See apps/desktop/src/main/ai/orchestration/qa-reports.ts for the TypeScript implementation.
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

  // Combine key and description for richer comparison
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
  const approvedIterations = iterations.filter((r) => r.status === 'approved').length;
  const rejectedIterations = iterations.filter((r) => r.status === 'rejected').length;
  const errorIterations = iterations.filter((r) => r.status === 'error').length;
  const totalIssues = iterations.reduce((sum, r) => sum + r.issues.length, 0);

  const totalDurationMs = iterations.reduce((sum, r) => sum + r.durationMs, 0);
  const totalDurationSec = (totalDurationMs / 1000).toFixed(1);

  const statusLabel =
    finalStatus === 'approved'
      ? 'APPROVED'
      : finalStatus === 'escalated'
        ? 'ESCALATED'
        : 'MAX ITERATIONS REACHED';

  const statusEmoji = finalStatus === 'approved' ? 'PASSED' : 'FAILED';

  let report = `# QA 报告

**生成时间**: ${now}
**最终状态**: ${statusLabel}
**结果**: ${statusEmoji}

## 摘要

| 指标 | 值 |
|--------|-------|
| 总迭代次数 | ${totalIterations} |
| 通过迭代次数 | ${approvedIterations} |
| 拒绝迭代次数 | ${rejectedIterations} |
| 错误迭代次数 | ${errorIterations} |
| 发现的问题总数 | ${totalIssues} |
| 总耗时 | ${totalDurationSec}s |

`;

  if (iterations.length === 0) {
    report += `## 未记录迭代。\n`;
    return report;
  }

  report += `## 迭代历史\n\n`;

  for (const record of iterations) {
    const durationSec = (record.durationMs / 1000).toFixed(1);
    const statusIcon = record.status === 'approved' ? '通过' : record.status === 'rejected' ? '失败' : '错误';

    report += `### 迭代 ${record.iteration} — ${statusIcon}\n\n`;
    report += `- **状态**: ${record.status}\n`;
    report += `- **耗时**: ${durationSec}s\n`;
    report += `- **时间戳**: ${record.timestamp}\n`;
    report += `- **发现的问题**: ${record.issues.length}\n`;

    if (record.issues.length > 0) {
      report += `\n#### 问题\n\n`;
      for (const issue of record.issues) {
        const typeTag = issue.type ? ` \`[${issue.type.toUpperCase()}]\`` : '';
        report += `- **${issue.title}**${typeTag}\n`;
        if (issue.location) {
          report += `  - 位置: \`${issue.location}\`\n`;
        }
        if (issue.description) {
          report += `  - ${issue.description}\n`;
        }
        if (issue.fix_required) {
          report += `  - 需要修复: ${issue.fix_required}\n`;
        }
      }
    }

    report += `\n`;
  }

  if (finalStatus === 'approved') {
    report += `## 结果\n\nQA 验证成功通过。实现满足所有验收标准。\n`;
  } else if (finalStatus === 'max_iterations') {
    report += `## 结果\n\nQA 验证达到最大 ${MAX_QA_ITERATIONS} 次迭代但未通过。需要人工审核。\n`;
  } else {
    report += `## 结果\n\n由于反复出现问题，QA 验证已升级至人工审核。详情请参阅 QA_ESCALATION.md。\n`;
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
  const totalIssues = iterations.reduce((sum, r) => sum + r.issues.length, 0);
  const uniqueIssueTitles = new Set(
    iterations.flatMap((r) => r.issues.map((i) => i.title.toLowerCase())),
  ).size;
  const approvedCount = iterations.filter((r) => r.status === 'approved').length;
  const fixSuccessRate = totalIterations > 0 ? (approvedCount / totalIterations).toFixed(1) : '0';

  // Compute most common issues
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

  let report = `# QA 升级 — 需要人工干预

**生成时间**: ${now}
**迭代**: ${totalIterations}/${MAX_QA_ITERATIONS}
**原因**: 检测到反复出现的问题（${RECURRING_ISSUE_THRESHOLD}+ 次）

## 摘要

- **QA 总迭代次数**: ${totalIterations}
- **发现的问题总数**: ${totalIssues}
- **唯一问题数**: ${uniqueIssueTitles}
- **修复成功率**: ${fixSuccessRate}%

## 反复出现的问题

这些问题已出现 ${RECURRING_ISSUE_THRESHOLD}+ 次但未解决：

`;

  for (let i = 0; i < recurringIssues.length; i++) {
    const issue = recurringIssues[i];
    report += `### ${i + 1}. ${issue.title}\n\n`;
    report += `- **位置**: ${issue.location ?? '无'}\n`;
    report += `- **类型**: ${issue.type ?? '无'}\n`;
    if (issue.description) {
      report += `- **描述**: ${issue.description}\n`;
    }
    if (issue.fix_required) {
      report += `- **需要修复**: ${issue.fix_required}\n`;
    }
    report += `\n`;
  }

  if (topIssues.length > 0) {
    report += `## 最常见的问题（全部）\n\n`;
    for (const [title, count] of topIssues) {
      report += `- **${title}** (${count} 次)\n`;
    }
    report += `\n`;
  }

  report += `## 建议的操作

1. 手动审查反复出现的问题
2. 检查问题是否源于：
   - 规范不清晰
   - 复杂的边缘情况
   - 基础设施/环境问题
   - 测试框架限制
3. 如需要，更新规范或验收标准
4. 在 \`QA_FIX_REQUEST.md\` 中创建修复请求并重新运行 QA

## 相关文件

- \`QA_FIX_REQUEST.md\` — 在此编写人工修复说明
- \`qa_report.md\` — 最新的 QA 报告
- \`implementation_plan.json\` — 完整的迭代历史
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
  const specName = specDir.split('/').pop() ?? specDir;

  // Read spec.md for acceptance criteria if available
  let specContent = '';
  try {
    specContent = await readFile(join(specDir, 'spec.md'), 'utf-8');
  } catch {
    // spec.md not available — proceed without it
  }

  // Extract acceptance criteria from spec content
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

  // Detect if this is a no-test project
  const noTest = isNoTestProject(specDir, projectDir);

  let plan = `# 手动测试计划 — ${specName}

**生成时间**: ${now}
**原因**: ${noTest ? '未检测到自动化测试框架' : '补充手动验证清单'}

## 概述

${
    noTest
      ? '此项目没有自动化测试基础设施。请使用下面的清单手动验证实现。'
      : '使用此清单作为自动化测试的补充，以进行完整验证。'
  }

## 测试前准备

1. [ ] 确保所有依赖项已安装
2. [ ] 启动所有必需的服务
3. [ ] 设置测试环境变量

## 验收标准验证

`;

  if (acceptanceCriteria.length > 0) {
    for (let i = 0; i < acceptanceCriteria.length; i++) {
      plan += `${i + 1}. [ ] ${acceptanceCriteria[i]}\n`;
    }
  } else {
    plan += `1. [ ] 核心功能按预期工作
2. [ ] 边缘情况得到处理
3. [ ] 错误状态得到妥善处理
4. [ ] UI/UX 符合要求（如适用）
`;
  }

  plan += `

## 功能测试

### 正常路径
- [ ] 主要用例正常工作
- [ ] 生成预期的输出
- [ ] 无控制台错误

### 边缘情况
- [ ] 空输入处理
- [ ] 无效输入处理
- [ ] 边界条件

### 错误处理
- [ ] 错误显示适当的消息
- [ ] 系统从错误中优雅恢复
- [ ] 失败时无数据丢失

## 非功能测试

### 性能
- [ ] 响应时间可接受
- [ ] 未观察到内存泄漏
- [ ] 无过度资源使用

### 安全性
- [ ] 输入已正确清理
- [ ] 无敏感数据暴露
- [ ] 身份验证正常工作（如适用）

## 浏览器/环境测试（如适用）

- [ ] Chrome
- [ ] Firefox
- [ ] Safari
- [ ] 移动视口

## 签署

**测试人员**: _______________
**日期**: _______________
**结果**: [ ] 通过  [ ] 失败

### 备注
_添加测试期间发现的任何观察或问题_

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
  // Check for test config files
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

  // Check for test directories with test files
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
      // Can't read directory — skip
    }
  }

  return true;
}
