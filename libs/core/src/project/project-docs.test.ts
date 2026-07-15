import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveAutocodeTaskRuntimeConcurrency } from '../runtime/concurrency.js';
import {
  validateAutocodePlanningSchedulingMetadata,
  type AutocodePlanningSchedulePlan,
} from '../runtime/agent-planning.js';
import { loadAutocodeImplementationPlanSync } from '../tasks/plan-store.js';
import {
  buildAutocodeProjectDocsReferencePrompt,
  createAutocodeProjectDocumentationTask,
} from './project-docs.js';

describe('project documentation tasks', () => {
  const mojibakePattern = /(?:浜у搧|鏂囨。|绱㈠紩|澶х翰|璇佹嵁|椤圭洰|鎶€鏈|杈撳嚭|鐢熸垚)/;

  it('seeds context and scheduling metadata so standard mode can skip replanning', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-docs-'));

    try {
      const result = createAutocodeProjectDocumentationTask({
        projectRoot,
        dataDirName: '.autocode',
        documentType: 'full',
        now: '2026-01-01T00:00:00.000Z',
      });

      const context = readFileSync(join(result.task.specsPath, 'context.md'), 'utf8');
      const requirements = readFileSync(join(result.task.specsPath, 'requirements.md'), 'utf8');
      const planText = readFileSync(join(result.task.specsPath, 'implementation_plan.md'), 'utf8');
      const persistedPlan = loadAutocodeImplementationPlanSync(result.task.specsPath);

      expect(context).toContain('# Project Context');
      expect(context).toContain('## Evidence Sources');
      expect(context).toContain('Documentation-only task');
      expect(context).toContain('concrete source/config file paths');
      expect(context).toContain('source evidence matrices');
      expect(requirements).toContain('## Evidence Sources');
      expect(planText).toContain('_Depends on: none_');
      expect(planText).toMatch(/_Evidence: .*spec\.md project documentation scope/);
      expect(planText).toContain('_Verification: ');
      expect(planText).toContain('do not stop at README/manifests');
      expect(planText).toContain('Write `evidence_index.md` as a source ledger');
      expect(planText).toContain('source evidence matrix');
      expect(planText).toContain('call/data/state flow');
      expect(
        validateAutocodePlanningSchedulingMetadata(persistedPlan as AutocodePlanningSchedulePlan | null, {
          runtimeConcurrency: resolveAutocodeTaskRuntimeConcurrency(result.task.metadata),
          requireEvidence: true,
        }),
      ).toEqual([]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('describes project documentation support artifacts as Markdown, not model-facing JSON', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-docs-format-'));

    try {
      const result = createAutocodeProjectDocumentationTask({
        projectRoot,
        dataDirName: '.autocode',
        documentType: 'full',
        language: 'zh-CN',
        now: '2026-01-01T00:00:00.000Z',
      });

      const spec = readFileSync(join(result.task.specsPath, 'spec.md'), 'utf8');
      const context = readFileSync(join(result.task.specsPath, 'context.md'), 'utf8');
      const planText = readFileSync(join(result.task.specsPath, 'implementation_plan.md'), 'utf8');
      const generatedText = `${result.plan.description}\n${spec}\n${context}\n${planText}`;

      expect(generatedText).toContain('doc_outline.md');
      expect(generatedText).toContain('evidence_index.md');
      expect(generatedText).toContain('Markdown 大纲');
      expect(generatedText).toContain('Markdown 证据索引');
      expect(generatedText).toContain('生成项目文档参考包');
      expect(generatedText).toContain('## 目标');
      expect(generatedText).toContain('## 输出');
      expect(generatedText).toContain('## 质量要求');
      expect(generatedText).toContain('生成的 Markdown 使用简体中文');
      expect(generatedText).not.toContain('JSON 大纲');
      expect(generatedText).not.toContain('JSON 证据索引');
      expect(generatedText).not.toContain('doc_outline.json');
      expect(generatedText).not.toContain('evidence_index.json');
      expect(generatedText).not.toMatch(mojibakePattern);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('compacts large project documentation references for agent kickoff prompts', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-docs-reference-'));

    try {
      const docsDir = join(projectRoot, '.autocode', 'project-docs');
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(
        join(docsDir, 'index.md'),
        '# Project Docs\n\n## Map\n\n- Architecture: architecture.md\n- Technical: technical.md\n',
        'utf8',
      );
      writeFileSync(
        join(docsDir, 'architecture.md'),
        [
          '# Architecture',
          '',
          '## Runtime Boundaries',
          '',
          '- Renderer owns all interactive screens and state hydration.',
          '- Main process owns IPC, provider credentials, and long-running agent orchestration.',
          '- Core package owns shared task, prompt, and project documentation contracts.',
          '',
          '## Data Flow',
          '',
          ...Array.from({ length: 80 }, (_, index) => (
            `- Deep implementation detail ${index}: ${'renderer/main/core boundary evidence '.repeat(6)}`
          )),
          '',
          'This paragraph sits near the end of a very long document and should not be copied wholesale into every kickoff prompt.',
        ].join('\n'),
        'utf8',
      );

      const prompt = buildAutocodeProjectDocsReferencePrompt({
        projectRoot,
        dataDirName: '.autocode',
        maxBytes: 2_200,
      });

      expect(prompt).toContain('Project Documentation Reference');
      expect(prompt).toContain('Compact excerpt');
      expect(prompt).toContain('Source: .autocode/project-docs/architecture.md');
      expect(prompt).toContain('Runtime Boundaries');
      expect(prompt).toContain('Renderer owns all interactive screens');
      expect(prompt).toContain('Deep implementation detail 0');
      expect(prompt).not.toContain('Deep implementation detail 79');
      expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(3_000);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps default project documentation references compact while listing available document paths', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-docs-default-reference-'));

    try {
      const docsDir = join(projectRoot, '.autocode', 'project-docs');
      mkdirSync(docsDir, { recursive: true });
      const files = [
        ['index.md', '# Project Docs\n\n- Architecture: architecture.md\n- Technical: technical.md\n- Product: product.md\n'],
        ['architecture.md', '# Architecture\n\n## Boundaries\n\n- Renderer owns UI state.\n'],
        ['technical.md', '# Technical\n\n## Commands\n\n- Typecheck with npm --workspace apps/desktop run typecheck.\n'],
        ['product.md', '# Product\n\n## Workflows\n\n- Users create specs, roadmaps, and build tasks.\n'],
      ] as const;
      for (const [fileName, header] of files) {
        writeFileSync(
          join(docsDir, fileName),
          [
            header,
            ...Array.from(
              { length: 160 },
              (_, index) => `- ${fileName} deep detail ${index}: ${'project docs evidence '.repeat(8)}`,
            ),
          ].join('\n'),
          'utf8',
        );
      }

      const prompt = buildAutocodeProjectDocsReferencePrompt({
        projectRoot,
        dataDirName: '.autocode',
      });

      expect(prompt).toContain('Available documents:');
      expect(prompt).toContain('- .autocode/project-docs/index.md');
      expect(prompt).toContain('- .autocode/project-docs/architecture.md');
      expect(prompt).toContain('- .autocode/project-docs/technical.md');
      expect(prompt).toContain('- .autocode/project-docs/product.md');
      expect(prompt).toContain('This is an index summary, not the full documentation.');
      expect(prompt).toContain('Renderer owns UI state');
      expect(prompt).toContain('product.md deep detail 0');
      expect(prompt).not.toContain('product.md deep detail 159');
      expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(6_000);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('builds readable Simplified Chinese project documentation references', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-project-docs-zh-reference-'));

    try {
      const docsDir = join(projectRoot, '.autocode', 'project-docs');
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(
        join(docsDir, 'index.md'),
        '# 项目文档\n\n## 文档地图\n\n- 架构：architecture.md\n- 技术：technical.md\n',
        'utf8',
      );
      writeFileSync(
        join(docsDir, 'architecture.md'),
        [
          '# 架构文档',
          '',
          '## 运行边界',
          '',
          '- 渲染进程负责交互界面和状态展示。',
          '- 主进程负责 IPC、凭据和长任务编排。',
          ...Array.from(
            { length: 120 },
            (_, index) => `- 深层细节 ${index}: ${'项目文档证据 '.repeat(10)}`,
          ),
        ].join('\n'),
        'utf8',
      );

      const prompt = buildAutocodeProjectDocsReferencePrompt({
        projectRoot,
        dataDirName: '.autocode',
        language: 'zh-CN',
      });

      expect(prompt).toContain('项目文档参考');
      expect(prompt).toContain('可用文档：');
      expect(prompt).toContain('- .autocode/project-docs/index.md');
      expect(prompt).toContain('紧凑摘录');
      expect(prompt).toContain('运行边界');
      expect(prompt).not.toMatch(mojibakePattern);
      expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(6_000);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
