/**
 * QA report desktop adapter.
 *
 * Pure report generation lives in @autocode/core; this file keeps local
 * filesystem discovery beside the desktop orchestrator.
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  autocodeQaIssuesSimilar,
  generateAutocodeManualTestPlan,
  generateAutocodeQAEscalationReport,
  generateAutocodeQAReport,
} from '@autocode/core/runtime/agent-qa-reports';

import type { QAIssue, QAIterationRecord } from './qa-loop';

export function issuesSimilar(a: QAIssue, b: QAIssue, threshold?: number): boolean {
  return autocodeQaIssuesSimilar(a, b, threshold);
}

export function generateQAReport(
  iterations: QAIterationRecord[],
  finalStatus: 'approved' | 'escalated' | 'max_iterations',
): string {
  return generateAutocodeQAReport(iterations, finalStatus);
}

export function generateEscalationReport(
  iterations: QAIterationRecord[],
  recurringIssues: QAIssue[],
): string {
  return generateAutocodeQAEscalationReport(iterations, recurringIssues);
}

export async function generateManualTestPlan(specDir: string, projectDir: string): Promise<string> {
  const specName = specDir.split(/[\\/]/).pop() ?? specDir;

  let specContent = '';
  try {
    specContent = await readFile(join(specDir, 'spec.md'), 'utf-8');
  } catch {
    // spec.md is optional.
  }

  return generateAutocodeManualTestPlan({
    specName,
    specContent,
    noTest: isNoTestProject(specDir, projectDir),
  });
}

export function isNoTestProject(specDir: string, projectDir: string): boolean {
  void specDir;

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
    if (!existsSync(testDirPath)) {
      continue;
    }

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
