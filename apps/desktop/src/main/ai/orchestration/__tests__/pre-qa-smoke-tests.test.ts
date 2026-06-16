import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveAutocodeImplementationPlan,
  type MutableAutocodePlan,
} from '@autocode/core';

import {
  PRE_QA_SMOKE_OUTPUT_MAX_CHARS,
  compactSmokeOutput,
  runPreQASmokeTests,
} from '../pre-qa-smoke-tests';
import {
  QUALITY_SESSION_SUMMARY_MAX_CHARS,
  compactQualitySessionSummary,
  runPreQAQualityChecks,
  validateSubtaskQuality,
} from '../quality-integration';
import type { SessionResult } from '../../session/types';

async function writeImplementationPlan(specDir: string, plan: Record<string, unknown>): Promise<void> {
  await saveAutocodeImplementationPlan(specDir, plan as MutableAutocodePlan);
}

function documentationOutlineMarkdown(sections: string[]): string {
  return [
    '# Documentation Outline',
    '',
    '## Document Type',
    'source-analysis',
    '',
    '## Audience',
    'developer',
    '',
    '## Sections',
    ...sections.map((section) => `- ${section}`),
    '',
  ].join('\n');
}

function evidenceIndexMarkdown(files: string[], claims: string[], openQuestions: string[]): string {
  return [
    '# Evidence Index',
    '',
    '## Files Read',
    ...files.map((file) => `- ${file}`),
    '',
    '## Evidence-Backed Claims',
    ...claims.map((claim) => `- ${claim}`),
    '',
    '## Confidence And Inference Notes',
    '- Confidence: medium unless a claim states otherwise.',
    '- Inferred or unverified items are listed under open questions.',
    '',
    '## Open Questions',
    ...openQuestions.map((question) => `- ${question}`),
    '',
  ].join('\n');
}

describe('pre-QA smoke tests', () => {
  let projectDir: string;
  let specDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'pre-qa-project-'));
    specDir = await mkdtemp(join(tmpdir(), 'pre-qa-spec-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(specDir, { recursive: true, force: true });
  });

  it('compacts oversized smoke check output with head and tail context', () => {
    const output = [
      'SMOKE_OUTPUT_HEAD',
      'x'.repeat(PRE_QA_SMOKE_OUTPUT_MAX_CHARS * 2),
      'SMOKE_OUTPUT_TAIL',
    ].join('\n');

    const compacted = compactSmokeOutput(output);

    expect(compacted.length).toBeLessThanOrEqual(PRE_QA_SMOKE_OUTPUT_MAX_CHARS);
    expect(compacted).toContain('SMOKE_OUTPUT_HEAD');
    expect(compacted).toContain('SMOKE_OUTPUT_TAIL');
    expect(compacted).toContain('smoke output truncated');
  });

  it('compacts quality session summaries with tail context for downstream quality gates', () => {
    const compacted = compactQualitySessionSummary([{
      role: 'assistant',
      content: [
        'QUALITY_SESSION_HEAD',
        'x'.repeat(QUALITY_SESSION_SUMMARY_MAX_CHARS * 2),
        'Verification: ran targeted combat replication smoke check.',
        'Server authority, network sync, security, and performance risks reviewed.',
        'QUALITY_SESSION_TAIL',
      ].join('\n'),
    }]);

    expect(compacted.length).toBeLessThanOrEqual(QUALITY_SESSION_SUMMARY_MAX_CHARS);
    expect(compacted).toContain('QUALITY_SESSION_HEAD');
    expect(compacted).toContain('QUALITY_SESSION_TAIL');
    expect(compacted).toContain('quality summary truncated');
  });

  it('passes secret scanning in a non-git project without shell grep', async () => {
    await writeFile(join(projectDir, 'index.html'), '<!doctype html><title>ok</title>\n', 'utf-8');

    const result = await runPreQASmokeTests(projectDir, specDir);

    expect(result.passed).toBe(true);
    expect(result.shouldReturnToCoding).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.checks.find((check) => check.name === 'secrets')?.passed).toBe(true);
  });

  it('ignores generated autocode task files during fallback scanning', async () => {
    await mkdir(join(projectDir, '.autocode', 'specs', '001-task'), { recursive: true });
    await writeFile(
      join(projectDir, '.autocode', 'specs', '001-task', 'task_logs.jsonl'),
      '{"api_key":"abcdefghijklmnopqrstuvwxyzABCDEFGH123456"}\n',
      'utf-8',
    );

    const result = await runPreQAQualityChecks(
      { enablePreQASmokeTests: true },
      projectDir,
      specDir,
    );

    expect(result.shouldProceedToQA).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('blocks QA when project files contain likely secrets', async () => {
    await writeFile(
      join(projectDir, 'app.js'),
      'const apiKey = "abcdefghijklmnopqrstuvwxyzABCDEFGH123456";\n',
      'utf-8',
    );

    const result = await runPreQAQualityChecks(
      { enablePreQASmokeTests: true },
      projectDir,
      specDir,
    );

    expect(result.shouldProceedToQA).toBe(false);
    expect(result.issues.join('\n')).toContain('secrets: Potential secrets detected');
  });

  it('blocks documentation workflows missing outline and evidence files', async () => {
    await writeImplementationPlan(specDir, {
      feature: 'Source documentation',
      workflow_type: 'documentation',
      document_outputs: {
        final_markdown: 'docs/analysis.md',
        outline: 'doc_outline.md',
        evidence_index: 'evidence_index.md',
      },
      phases: [{
        id: '1',
        name: 'Documentation',
        subtasks: [{
          id: '1.1',
          title: 'Write docs',
          description: 'Write documentation',
          status: 'completed',
          files_to_create: ['docs/analysis.md', 'doc_outline.md', 'evidence_index.md'],
        }],
      }],
    });
    await mkdir(join(specDir, 'docs'), { recursive: true });
    await writeFile(join(specDir, 'docs', 'analysis.md'), '# Analysis\n\nToo short.\n', 'utf-8');

    const result = await runPreQAQualityChecks({}, projectDir, specDir);

    expect(result.shouldProceedToQA).toBe(false);
    expect(result.issues.join('\n')).toContain('doc_outline.md');
    expect(result.issues.join('\n')).toContain('evidence_index.md');
  });

  it('passes documentation workflows with outline, evidence, and structured markdown', async () => {
    await writeImplementationPlan(specDir, {
      feature: 'Source documentation',
      workflow_type: 'documentation',
      document_outputs: {
        final_markdown: 'docs/analysis.md',
        outline: 'doc_outline.md',
        evidence_index: 'evidence_index.md',
      },
      phases: [{
        id: '1',
        name: 'Documentation',
        subtasks: [{
          id: '1.1',
          title: 'Write docs',
          description: 'Write documentation',
          status: 'completed',
          files_to_create: ['docs/analysis.md', 'doc_outline.md', 'evidence_index.md'],
        }],
      }],
    });
    await writeFile(join(specDir, 'doc_outline.md'), documentationOutlineMarkdown(['Overview', 'Core flow', 'Risks']), 'utf-8');
    await writeFile(join(specDir, 'evidence_index.md'), evidenceIndexMarkdown(
      ['src/main.ts', 'src/config.ts', 'src/state/store.ts'],
      [
        'Main flow starts in src/main.ts. Source: src/main.ts. Confidence: high.',
        'Runtime configuration is loaded from src/config.ts. Source: src/config.ts. Confidence: high.',
        'State transitions are stored in src/state/store.ts. Source: src/state/store.ts. Confidence: medium.',
      ],
      ['Runtime configuration needs confirmation'],
    ), 'utf-8');
    await mkdir(join(specDir, 'docs'), { recursive: true });
    await writeFile(join(specDir, 'docs', 'analysis.md'), [
      '# Source Analysis',
      '',
      '## Overview',
      'This document summarizes the source evidence from `src/main.ts`, `src/config.ts`, and `src/state/store.ts`.',
      '',
      '## Source Evidence Matrix',
      '| File | Role | Confidence |',
      '| --- | --- | --- |',
      '| `src/main.ts` | Entry point and source evidence for startup behavior. | high |',
      '| `src/config.ts` | Configuration source for runtime setup. | high |',
      '| `src/state/store.ts` | State owner and transition evidence. | medium |',
      '',
      '## Core Flow And Architecture Boundaries',
      'The main flow loads configuration, initializes state, and dispatches work. Module boundaries keep configuration, runtime state, and output rendering separate. The data flow moves from config to runtime state to output rendering.',
      '',
      '```mermaid',
      'flowchart TD',
      '  Config --> State --> Output',
      '```',
      '',
      '## Risks',
      'Risk: runtime configuration behavior is inferred from source and should be verified in a running environment.',
      '',
      '## Open Questions',
      '- Which deployment profile is authoritative?',
      '',
      'Additional detail '.repeat(80),
    ].join('\n'), 'utf-8');

    const result = await runPreQAQualityChecks({}, projectDir, specDir);

    expect(result.shouldProceedToQA).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('blocks MMO documentation that lacks game engineering dimensions', async () => {
    await writeImplementationPlan(specDir, {
      feature: 'MMO source documentation',
      workflow_type: 'documentation',
      project_type: 'game-mmo',
      documentation_profile: 'game-mmo-source',
      document_outputs: {
        final_markdown: 'docs/analysis.md',
        outline: 'doc_outline.md',
        evidence_index: 'evidence_index.md',
      },
      phases: [{
        id: '1',
        name: 'Documentation',
        subtasks: [{
          id: '1.1',
          title: 'Write MMO docs',
          description: 'Write documentation',
          status: 'completed',
          files_to_create: ['docs/analysis.md', 'doc_outline.md', 'evidence_index.md'],
        }],
      }],
    });
    await writeFile(join(specDir, 'doc_outline.md'), documentationOutlineMarkdown(['Overview', 'Core flow', 'Risks']), 'utf-8');
    await writeFile(join(specDir, 'evidence_index.md'), evidenceIndexMarkdown(
      ['src/main.cpp'],
      ['Startup flow exists. Source: src/main.cpp'],
      ['Runtime ownership needs confirmation'],
    ), 'utf-8');
    await mkdir(join(specDir, 'docs'), { recursive: true });
    await writeFile(join(specDir, 'docs', 'analysis.md'), [
      '# MMO Source Analysis',
      '',
      '## Overview',
      'This document cites source evidence from `src/main.cpp` and describes the main flow.',
      '',
      '## Core Flow',
      'The flow loads config, creates state, and runs update steps. Data flow and state flow are inferred from source evidence.',
      '',
      '```mermaid',
      'flowchart TD',
      '  Config --> State --> Update',
      '```',
      '',
      '## Risks',
      'Risk: runtime ownership and deployment behavior are open questions.',
      '',
      '## Open Questions',
      '- Which runtime process owns the update loop?',
      '',
      'Additional detail '.repeat(90),
    ].join('\n'), 'utf-8');

    const result = await runPreQAQualityChecks({}, projectDir, specDir);

    expect(result.shouldProceedToQA).toBe(false);
    expect(result.issues.join('\n')).toContain('MMO gameplay systems');
    expect(result.issues.join('\n')).toContain('server authority');
  });

  it('passes MMO documentation with professional game engineering coverage', async () => {
    await writeImplementationPlan(specDir, {
      feature: 'MMO source documentation',
      workflow_type: 'documentation',
      project_type: 'game-mmo',
      documentation_profile: 'game-mmo-source',
      document_outputs: {
        final_markdown: 'docs/analysis.md',
        outline: 'doc_outline.md',
        evidence_index: 'evidence_index.md',
      },
      phases: [{
        id: '1',
        name: 'Documentation',
        subtasks: [{
          id: '1.1',
          title: 'Write MMO docs',
          description: 'Write documentation',
          status: 'completed',
          files_to_create: ['docs/analysis.md', 'doc_outline.md', 'evidence_index.md'],
        }],
      }],
    });
    await writeFile(join(specDir, 'doc_outline.md'), documentationOutlineMarkdown(['System matrix', 'Cross-end sequence', 'Data lifecycle', 'Risks']), 'utf-8');
    await writeFile(join(specDir, 'evidence_index.md'), evidenceIndexMarkdown(
      [
        'Server/Combat.cpp',
        'Client/CombatView.cpp',
        'Engine/AnimationSystem.cpp',
        'Config/Items.xml',
        'Tools/GMTool.cs',
        'Scripts/LiveOpsRelease.ts',
      ],
      [
        'Server authority owns combat resolution. Source: Server/Combat.cpp. Confidence: high.',
        'Client rendering and engine animation present combat effects. Source: Client/CombatView.cpp, Engine/AnimationSystem.cpp. Confidence: high.',
        'Config data and tooling evidence are present. Source: Config/Items.xml, Tools/GMTool.cs. Confidence: medium.',
        'Live operations release evidence is present. Source: Scripts/LiveOpsRelease.ts. Confidence: medium.',
      ],
      ['Replication tick rate needs runtime confirmation'],
    ), 'utf-8');
    await mkdir(join(specDir, 'docs'), { recursive: true });
    await writeFile(join(specDir, 'docs', 'analysis.md'), [
      '# MMO Source Analysis',
      '',
      '## Overview',
      'This document cites evidence from `Server/Combat.cpp`, `Client/CombatView.cpp`, `Engine/AnimationSystem.cpp`, `Config/Items.xml`, `Tools/GMTool.cs`, and `Scripts/LiveOpsRelease.ts`.',
      '',
      '## System Matrix',
      '| System | Gameplay role | Client/engine | Server authority | Data/config | Tooling |',
      '| --- | --- | --- | --- | --- | --- |',
      '| Combat | Gameplay combat loop and progression rewards | Client engine renders animation and effects through `Client/CombatView.cpp` and `Engine/AnimationSystem.cpp` | Server authority resolves damage and validates state in `Server/Combat.cpp` | Config data drives skills and items from `Config/Items.xml` | GM editor/tooling can inspect account state through `Tools/GMTool.cs` and release scripts in `Scripts/LiveOpsRelease.ts` |',
      '| Economy | Economy and item progression | Client UI presents inventory | Server persists wallet and item state | Item config and content pipeline define values | Live operations tools adjust events |',
      '',
      '## Cross-End Sequence Flow',
      'The network protocol sends combat intent from client to server, server authority validates the action, replication/sync returns state, and client prediction/reconciliation updates presentation.',
      '',
      '```mermaid',
      'sequenceDiagram',
      '  participant Client',
      '  participant Server',
      '  participant DB',
      '  Client->>Server: combat intent protocol',
      '  Server->>Server: authoritative validation',
      '  Server->>DB: persist save/account/economy state',
      '  Server-->>Client: replication sync',
      '```',
      '',
      '## Data Lifecycle',
      'Config/content data is loaded by the server and client, save persistence records account and economy state, and GM/editor tooling provides production inspection. This lifecycle is backed by the files in the evidence index.',
      '',
      '## Performance And Security',
      'Performance risks include frame time, latency, and world streaming pressure. Security and anti-cheat risks include trusting client state, protocol replay, and economy exploit paths. Telemetry/liveops and release controls should verify these assumptions.',
      '',
      '## Risks',
      'Risk: exact replication tick and rollback behavior are inferred and should be checked in runtime configuration.',
      '',
      '## Open Questions',
      '- Which protocol version is authoritative for live operations?',
      '- Which telemetry stream confirms combat latency?',
      '',
      'Additional MMO engineering detail '.repeat(90),
    ].join('\n'), 'utf-8');

    const result = await runPreQAQualityChecks({}, projectDir, specDir);

    expect(result.shouldProceedToQA).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('blocks MMO documentation when outline and evidence index are too generic', async () => {
    await writeImplementationPlan(specDir, {
      feature: 'MMO source documentation',
      workflow_type: 'documentation',
      project_type: 'game-mmo',
      documentation_profile: 'game-mmo-source',
      document_outputs: {
        final_markdown: 'docs/analysis.md',
        outline: 'doc_outline.md',
        evidence_index: 'evidence_index.md',
      },
      phases: [{
        id: '1',
        name: 'Documentation',
        subtasks: [{
          id: '1.1',
          title: 'Write MMO docs',
          description: 'Write documentation',
          status: 'completed',
          files_to_create: ['docs/analysis.md', 'doc_outline.md', 'evidence_index.md'],
        }],
      }],
    });
    await writeFile(join(specDir, 'doc_outline.md'), documentationOutlineMarkdown(['Overview', 'Files', 'Risks']), 'utf-8');
    await writeFile(join(specDir, 'evidence_index.md'), evidenceIndexMarkdown(
      ['README.md'],
      ['Project has source files. Source: README.md'],
      ['Need details'],
    ), 'utf-8');
    await mkdir(join(specDir, 'docs'), { recursive: true });
    await writeFile(join(specDir, 'docs', 'analysis.md'), [
      '# MMO Source Analysis',
      '',
      '## Overview',
      'This document cites evidence from `Server/Combat.cpp`, `Client/CombatView.cpp`, `Config/Items.xml`, and `Tools/GMTool.cs`.',
      '',
      '## System Matrix',
      '| System | Gameplay role | Client/engine | Server authority | Data/config | Tooling |',
      '| --- | --- | --- | --- | --- | --- |',
      '| Combat | Gameplay combat loop and progression rewards | Client engine renders animation and effects | Server authority resolves damage and validates state | Config data drives skills and items | GM editor/tooling can inspect account state |',
      '',
      '## Cross-End Sequence Flow',
      'The network protocol sends combat intent from client to server, server authority validates the action, replication/sync returns state, and client prediction/reconciliation updates presentation.',
      '',
      '## Data Lifecycle',
      'Config/content data is loaded by the server and client, save persistence records account and economy state, and GM/editor tooling provides production inspection.',
      '',
      '## Performance And Security',
      'Performance risks include frame time, latency, world streaming pressure, security, anti-cheat, telemetry/liveops, and release controls.',
      '',
      '## Risks',
      'Risk: exact replication tick and rollback behavior are inferred and should be checked in runtime configuration.',
      '',
      '## Open Questions',
      '- Which protocol version is authoritative for live operations?',
      '',
      'Additional MMO engineering detail '.repeat(90),
    ].join('\n'), 'utf-8');

    const result = await runPreQAQualityChecks({}, projectDir, specDir);

    expect(result.shouldProceedToQA).toBe(false);
    expect(result.issues.join('\n')).toContain('outline should include MMO');
    expect(result.issues.join('\n')).toContain('evidence index should include MMO');
  });

  it('requires MMO coding completion summaries to include verification and risk review', async () => {
    const baseResult: SessionResult = {
      outcome: 'completed',
      stepsExecuted: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: 'Implemented combat replication changes.' }],
      durationMs: 1,
      toolCallCount: 1,
    };

    const failed = await validateSubtaskQuality(
      {
        id: '2-1',
        description: 'Update server combat replication and client reconciliation.',
        filesToModify: ['Server/Combat.cpp', 'Client/CombatPrediction.cpp'],
        status: 'pending',
      },
      baseResult,
      {
        projectType: 'game-mmo',
        enableIncrementalValidation: false,
      },
      projectDir,
      specDir,
    );

    expect(failed.passed).toBe(false);
    expect(failed.issues.join('\n')).toContain('completion summary should state verification');
    expect(failed.issues.join('\n')).toContain('MMO risk review');

    const passed = await validateSubtaskQuality(
      {
        id: '2-1',
        description: 'Update server combat replication and client reconciliation.',
        filesToModify: ['Server/Combat.cpp', 'Client/CombatPrediction.cpp'],
        status: 'pending',
      },
      {
        ...baseResult,
        messages: [{
          role: 'assistant',
          content: [
            'What changed: updated Server/Combat.cpp and Client/CombatPrediction.cpp for combat replication.',
            'Verification: ran targeted combat replication smoke check.',
            'Server authority remains on the server; client only sends intent.',
            'Network sync/protocol compatibility and reconciliation were reviewed.',
            'Residual MMO risks: persistence/data n/a, performance latency budget unchanged, security anti-cheat trust boundary preserved, tools/content pipeline n/a, liveops/release n/a.',
          ].join('\n'),
        }],
      },
      {
        projectType: 'game-mmo',
        enableIncrementalValidation: false,
      },
      projectDir,
      specDir,
    );

    expect(passed.passed).toBe(true);
    expect(passed.issues).toEqual([]);
  });

  it('requires coding completion summaries to include changed files, verification, and review notes', async () => {
    const baseResult: SessionResult = {
      outcome: 'completed',
      stepsExecuted: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{ role: 'assistant', content: 'Done.' }],
      durationMs: 1,
      toolCallCount: 1,
    };

    const failed = await validateSubtaskQuality(
      {
        id: '1-1',
        description: 'Fix auth session persistence.',
        filesToModify: ['src/auth/session-store.ts'],
        status: 'pending',
      },
      baseResult,
      { enableIncrementalValidation: false },
      projectDir,
      specDir,
    );

    expect(failed.passed).toBe(false);
    expect(failed.issues.join('\n')).toContain('concrete implementation change');
    expect(failed.issues.join('\n')).toContain('touched files or changed contracts');
    expect(failed.issues.join('\n')).toContain('verification run');
    expect(failed.issues.join('\n')).toContain('review notes');

    const passed = await validateSubtaskQuality(
      {
        id: '1-1',
        description: 'Fix auth session persistence.',
        filesToModify: ['src/auth/session-store.ts'],
        status: 'pending',
      },
      {
        ...baseResult,
        messages: [{
          role: 'assistant',
          content: [
            '| Item | Details |',
            '| --- | --- |',
            '| What changed | Fixed session persistence in `src/auth/session-store.ts` while preserving the storage contract. |',
            '| Verification | Ran `npm test -- session-store.test.ts`. |',
            '| Review notes | No residual risks; missing storage key edge case is covered. |',
          ].join('\n'),
        }],
      },
      { enableIncrementalValidation: false },
      projectDir,
      specDir,
    );

    expect(passed.passed).toBe(true);
    expect(passed.issues).toEqual([]);
  });

  it('keeps MMO completion checks accurate when useful summary appears after long logs', async () => {
    const result: SessionResult = {
      outcome: 'completed',
      stepsExecuted: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      messages: [{
        role: 'assistant',
        content: [
          'Verbose command output follows.',
          'x'.repeat(QUALITY_SESSION_SUMMARY_MAX_CHARS * 2),
          'What changed: updated Server/Combat.cpp and Client/CombatPrediction.cpp for combat replication.',
          'Verification: ran targeted combat replication smoke check.',
          'Server authority remains on the server; client only sends intent.',
          'Network sync/protocol compatibility and reconciliation were reviewed.',
          'Residual MMO risks: persistence/data n/a, performance latency budget unchanged, security anti-cheat trust boundary preserved, tools/content pipeline n/a, liveops/release n/a.',
        ].join('\n'),
      }],
      durationMs: 1,
      toolCallCount: 1,
    };

    const validation = await validateSubtaskQuality(
      {
        id: '2-1',
        description: 'Update server combat replication and client reconciliation.',
        filesToModify: ['Server/Combat.cpp', 'Client/CombatPrediction.cpp'],
        status: 'pending',
      },
      result,
      {
        projectType: 'game-mmo',
        enableIncrementalValidation: false,
      },
      projectDir,
      specDir,
    );

    expect(validation.passed).toBe(true);
    expect(validation.issues).toEqual([]);
  });
});
