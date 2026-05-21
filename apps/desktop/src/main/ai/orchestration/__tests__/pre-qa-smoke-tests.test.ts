import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runPreQASmokeTests } from '../pre-qa-smoke-tests';
import { runPreQAQualityChecks, validateSubtaskQuality } from '../quality-integration';
import type { SessionResult } from '../../session/types';

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
      join(projectDir, '.autocode', 'specs', '001-task', 'task_logs.json'),
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
    await writeFile(join(specDir, 'implementation_plan.json'), JSON.stringify({
      feature: 'Source documentation',
      workflow_type: 'documentation',
      document_outputs: {
        final_markdown: 'docs/analysis.md',
        outline: 'doc_outline.json',
        evidence_index: 'evidence_index.json',
      },
      phases: [{
        id: '1',
        name: 'Documentation',
        subtasks: [{
          id: '1-1',
          title: 'Write docs',
          description: 'Write documentation',
          status: 'completed',
          files_to_create: ['docs/analysis.md', 'doc_outline.json', 'evidence_index.json'],
        }],
      }],
    }), 'utf-8');
    await mkdir(join(specDir, 'docs'), { recursive: true });
    await writeFile(join(specDir, 'docs', 'analysis.md'), '# Analysis\n\nToo short.\n', 'utf-8');

    const result = await runPreQAQualityChecks({}, projectDir, specDir);

    expect(result.shouldProceedToQA).toBe(false);
    expect(result.issues.join('\n')).toContain('doc_outline.json');
    expect(result.issues.join('\n')).toContain('evidence_index.json');
  });

  it('passes documentation workflows with outline, evidence, and structured markdown', async () => {
    await writeFile(join(specDir, 'implementation_plan.json'), JSON.stringify({
      feature: 'Source documentation',
      workflow_type: 'documentation',
      document_outputs: {
        final_markdown: 'docs/analysis.md',
        outline: 'doc_outline.json',
        evidence_index: 'evidence_index.json',
      },
      phases: [{
        id: '1',
        name: 'Documentation',
        subtasks: [{
          id: '1-1',
          title: 'Write docs',
          description: 'Write documentation',
          status: 'completed',
          files_to_create: ['docs/analysis.md', 'doc_outline.json', 'evidence_index.json'],
        }],
      }],
    }), 'utf-8');
    await writeFile(join(specDir, 'doc_outline.json'), JSON.stringify({
      document_type: 'source-analysis',
      audience: 'developer',
      sections: ['Overview', 'Core flow', 'Risks'],
    }), 'utf-8');
    await writeFile(join(specDir, 'evidence_index.json'), JSON.stringify({
      files_read: ['src/main.ts'],
      evidence_backed_claims: [{ claim: 'Main flow starts in src/main.ts', files: ['src/main.ts'] }],
      open_questions: ['Runtime configuration needs confirmation'],
    }), 'utf-8');
    await mkdir(join(specDir, 'docs'), { recursive: true });
    await writeFile(join(specDir, 'docs', 'analysis.md'), [
      '# Source Analysis',
      '',
      '## Overview',
      'This document summarizes the source evidence from `src/main.ts` and related files.',
      '',
      '## Key Files',
      '| File | Role |',
      '| --- | --- |',
      '| `src/main.ts` | Entry point and source evidence for startup behavior. |',
      '',
      '## Core Flow',
      'The main flow loads configuration, initializes state, and dispatches work. The data flow moves from config to runtime state to output rendering.',
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
    await writeFile(join(specDir, 'implementation_plan.json'), JSON.stringify({
      feature: 'MMO source documentation',
      workflow_type: 'documentation',
      project_type: 'game-mmo',
      documentation_profile: 'game-mmo-source',
      document_outputs: {
        final_markdown: 'docs/analysis.md',
        outline: 'doc_outline.json',
        evidence_index: 'evidence_index.json',
      },
      phases: [{
        id: '1',
        name: 'Documentation',
        subtasks: [{
          id: '1-1',
          title: 'Write MMO docs',
          description: 'Write documentation',
          status: 'completed',
          files_to_create: ['docs/analysis.md', 'doc_outline.json', 'evidence_index.json'],
        }],
      }],
    }), 'utf-8');
    await writeFile(join(specDir, 'doc_outline.json'), JSON.stringify({
      document_type: 'source-analysis',
      audience: 'game engineer',
      sections: ['Overview', 'Core flow', 'Risks'],
    }), 'utf-8');
    await writeFile(join(specDir, 'evidence_index.json'), JSON.stringify({
      files_read: ['src/main.cpp'],
      evidence_backed_claims: [{ claim: 'Startup flow exists', files: ['src/main.cpp'] }],
      open_questions: ['Runtime ownership needs confirmation'],
    }), 'utf-8');
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
    await writeFile(join(specDir, 'implementation_plan.json'), JSON.stringify({
      feature: 'MMO source documentation',
      workflow_type: 'documentation',
      project_type: 'game-mmo',
      documentation_profile: 'game-mmo-source',
      document_outputs: {
        final_markdown: 'docs/analysis.md',
        outline: 'doc_outline.json',
        evidence_index: 'evidence_index.json',
      },
      phases: [{
        id: '1',
        name: 'Documentation',
        subtasks: [{
          id: '1-1',
          title: 'Write MMO docs',
          description: 'Write documentation',
          status: 'completed',
          files_to_create: ['docs/analysis.md', 'doc_outline.json', 'evidence_index.json'],
        }],
      }],
    }), 'utf-8');
    await writeFile(join(specDir, 'doc_outline.json'), JSON.stringify({
      document_type: 'mmo-source-analysis',
      audience: 'game engineer',
      sections: ['System matrix', 'Cross-end sequence', 'Data lifecycle', 'Risks'],
    }), 'utf-8');
    await writeFile(join(specDir, 'evidence_index.json'), JSON.stringify({
      files_read: ['Server/Combat.cpp', 'Client/CombatView.cpp', 'Config/Items.xml', 'Tools/GMTool.cs'],
      evidence_backed_claims: [
        { claim: 'Server authority owns combat resolution', files: ['Server/Combat.cpp'] },
        { claim: 'Client rendering presents combat effects', files: ['Client/CombatView.cpp'] },
      ],
      open_questions: ['Replication tick rate needs runtime confirmation'],
    }), 'utf-8');
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
    await writeFile(join(specDir, 'implementation_plan.json'), JSON.stringify({
      feature: 'MMO source documentation',
      workflow_type: 'documentation',
      project_type: 'game-mmo',
      documentation_profile: 'game-mmo-source',
      document_outputs: {
        final_markdown: 'docs/analysis.md',
        outline: 'doc_outline.json',
        evidence_index: 'evidence_index.json',
      },
      phases: [{
        id: '1',
        name: 'Documentation',
        subtasks: [{
          id: '1-1',
          title: 'Write MMO docs',
          description: 'Write documentation',
          status: 'completed',
          files_to_create: ['docs/analysis.md', 'doc_outline.json', 'evidence_index.json'],
        }],
      }],
    }), 'utf-8');
    await writeFile(join(specDir, 'doc_outline.json'), JSON.stringify({
      document_type: 'mmo-source-analysis',
      audience: 'game engineer',
      sections: ['Overview', 'Files', 'Risks'],
    }), 'utf-8');
    await writeFile(join(specDir, 'evidence_index.json'), JSON.stringify({
      files_read: ['README.md'],
      evidence_backed_claims: [{ claim: 'Project has source files', files: ['README.md'] }],
      open_questions: ['Need details'],
    }), 'utf-8');
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
});
