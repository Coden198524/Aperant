import { describe, expect, it } from 'vitest';

import {
  getAutocodeQaReportStatus,
  validateAutocodeCodingSummary,
  validateAutocodeDocumentationEvidenceIndex,
  validateAutocodeDocumentationMarkdown,
  validateAutocodeGameMmoDocumentationSupportContent,
  validateAutocodeQaReportQuality,
  validateAutocodeRuntimeReadinessSummary,
} from './agent-quality-integration.js';

const genericFiller = 'Additional source reading notes connect the observed flow to implementation behavior and risks. '.repeat(20);
const mmoFiller = 'Additional MMO engineering analysis traces gameplay, protocol, persistence, tooling, operations, and source evidence. '.repeat(24);

describe('agent documentation quality integration', () => {
  it('rejects generic documentation that mentions sources without concrete paths or architecture analysis', () => {
    const issues = validateAutocodeDocumentationMarkdown([
      '# Source Analysis',
      '',
      '## Overview',
      'This document summarizes source files and evidence notes, but it never names the concrete files that prove the claims.',
      '',
      '## Core Flow',
      'The flow starts with setup work, moves through processing, and ends with output rendering.',
      '',
      '## Risks',
      'Risk: these conclusions are unverified and should be checked against source evidence.',
      '',
      genericFiller,
    ].join('\n'), 'docs/analysis.md');

    expect(issues.join('\n')).toContain('should cite at least 3 concrete source/config file paths');
    expect(issues.join('\n')).toContain('should analyze concrete source architecture');
  });

  it('accepts source-backed documentation with paths, entry points, boundaries, and data flow', () => {
    const issues = validateAutocodeDocumentationMarkdown([
      '# Source Analysis',
      '',
      '## Overview',
      'This document is grounded in source evidence from `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/App.tsx`, and `package.json`.',
      '',
      '## Source Evidence Matrix',
      '| File | Claim | Confidence |',
      '| --- | --- | --- |',
      '| `apps/desktop/src/main/index.ts` | Main process entry point owns Electron startup and long-running runtime ownership. | high |',
      '| `apps/desktop/src/preload/index.ts` | Preload defines public interfaces across the process boundary. | high |',
      '| `apps/desktop/src/renderer/App.tsx` | Renderer owns UI state flow and presentation. | medium |',
      '| `package.json` | Configuration and validation commands are declared here. | high |',
      '',
      '## Architecture Boundaries And Data Flow',
      'The entry points split main, preload, and renderer responsibilities. Module boundaries keep IPC/public APIs between processes, while data flow moves from main-process services through the preload interface into renderer state.',
      '',
      '## Risks And Open Questions',
      'Risk: runtime behavior that depends on packaged configuration should be verified in an installed build.',
      '',
      genericFiller,
    ].join('\n'), 'docs/analysis.md');

    expect(issues).toEqual([]);
  });

  it('requires evidence indexes to cite concrete paths and distinguish proven from inferred claims', () => {
    const weakIssues = validateAutocodeDocumentationEvidenceIndex([
      '# Evidence Index',
      '',
      '## Files Read',
      '- source files',
      '',
      '## Claims',
      '- The project has architecture.',
      '',
      '## Open Questions',
      '- More investigation is needed.',
    ].join('\n'), 'evidence_index.md');

    expect(weakIssues.join('\n')).toContain('should cite at least 3 concrete source/config file paths');
    expect(weakIssues.join('\n')).toContain('should distinguish proven source-backed claims');

    const strongIssues = validateAutocodeDocumentationEvidenceIndex([
      '# Evidence Index',
      '',
      '## Files Read',
      '- apps/desktop/src/main/index.ts',
      '- apps/desktop/src/preload/index.ts',
      '- apps/desktop/src/renderer/App.tsx',
      '',
      '## Evidence-Backed Claims',
      '- Proven: `apps/desktop/src/main/index.ts` owns process startup. Confidence: high.',
      '- Proven: `apps/desktop/src/preload/index.ts` exposes the public bridge. Confidence: high.',
      '- Proven: `apps/desktop/src/renderer/App.tsx` owns renderer state. Confidence: medium.',
      '',
      '## Inferred / Unverified Risks And Open Questions',
      '- Inferred: packaged runtime configuration should be checked in a release build.',
    ].join('\n'), 'evidence_index.md');

    expect(strongIssues).toEqual([]);
  });

  it('requires MMO documentation evidence to cover concrete source/config paths across major systems', () => {
    const outline = [
      '# Documentation Outline',
      '',
      '## Document Type',
      'game-mmo-source',
      '',
      '## Audience',
      'engineers',
      '',
      '## Sections',
      '- System matrix',
      '- Cross-end protocol sequence',
      '- Data lifecycle and persistence config',
      '- Performance security liveops risks',
    ].join('\n');

    const weakEvidence = [
      '# Evidence Index',
      '',
      '## Files Read',
      '- server code',
      '- client code',
      '',
      '## Claims',
      '- Proven: client, server, network protocol, data config, persistence, and GM tooling exist. Confidence: low.',
      '',
      '## Open Questions',
      '- Inferred systems need source paths.',
    ].join('\n');

    expect(validateAutocodeDocumentationEvidenceIndex(weakEvidence, 'evidence_index.md', {
      isGameMmoDocumentation: true,
    }).join('\n')).toContain('should cite at least 6 concrete source/config file paths');
    expect(validateAutocodeGameMmoDocumentationSupportContent(outline, weakEvidence, 'docs/mmo.md').join('\n')).toContain('evidence index should cite concrete MMO source/config files');

    const strongEvidence = [
      '# Evidence Index',
      '',
      '## Files Read',
      '- server/combat/CombatService.cpp',
      '- client/combat/CombatView.cpp',
      '- engine/render/AnimationSystem.cpp',
      '- config/items/skills.xml',
      '- tools/gm/CombatInspector.cs',
      '- scripts/liveops/release.ts',
      '',
      '## Evidence-Backed Claims',
      '- Proven: server authority owns combat resolution in `server/combat/CombatService.cpp`. Confidence: high.',
      '- Proven: client rendering and engine animation evidence sits in `client/combat/CombatView.cpp` and `engine/render/AnimationSystem.cpp`. Confidence: high.',
      '- Proven: data/config persistence and GM tooling evidence sits in `config/items/skills.xml` and `tools/gm/CombatInspector.cs`. Confidence: medium.',
      '- Proven: liveops release workflow evidence sits in `scripts/liveops/release.ts`. Confidence: medium.',
      '',
      '## Inferred / Unverified Risks And Open Questions',
      '- Inferred: network replication tick rate still needs runtime confirmation.',
    ].join('\n');
    const strongMarkdown = [
      '# MMO Source Analysis',
      '',
      '## Overview',
      'This MMO source document cites `server/combat/CombatService.cpp`, `client/combat/CombatView.cpp`, `engine/render/AnimationSystem.cpp`, `config/items/skills.xml`, `tools/gm/CombatInspector.cs`, and `scripts/liveops/release.ts`.',
      '',
      '## System Matrix',
      '| System | Gameplay | Client/engine | Server authority | Data/config | Tools/liveops |',
      '| --- | --- | --- | --- | --- | --- |',
      '| Combat | Gameplay combat, progression rewards, skills, items, and quest triggers | Client runtime renders animation/assets and world streaming effects | Server authority validates damage and replication state | Config data drives skills/items and save persistence | GM editor tools and live operations release scripts inspect production state |',
      '| Economy | Economy and account inventory progression | Client UI presents inventory state | Server owns authoritative wallet and persistence | Config/content pipeline defines item values | Telemetry and liveops watch exploit risk |',
      '',
      '## Cross-End Protocol Sequence',
      'The network protocol sends client intent to server authority, sync/replication returns state, and client prediction/reconciliation updates presentation. Call flow and data flow stay server-authoritative for combat, account, save, and economy data.',
      '',
      '## Data Lifecycle And State Machine',
      'Config/content data enters from `config/items/skills.xml`, runtime state changes in `server/combat/CombatService.cpp`, client animation/assets update through `engine/render/AnimationSystem.cpp`, and GM tooling plus liveops release scripts provide production controls.',
      '',
      '## Performance Security Liveops Risks',
      'Performance risks include frame time, latency, bandwidth, and streaming pressure. Security and anti-cheat risks include trusting client state, protocol replay, and economy exploit paths. Telemetry, liveops, and release checks should verify these assumptions.',
      '',
      '## Risks And Open Questions',
      'Risk: exact replication tick, rollback, and persistence migration behavior are inferred and should be verified against runtime configuration.',
      '',
      mmoFiller,
    ].join('\n');

    expect(validateAutocodeDocumentationEvidenceIndex(strongEvidence, 'evidence_index.md', {
      isGameMmoDocumentation: true,
    })).toEqual([]);
    expect(validateAutocodeGameMmoDocumentationSupportContent(outline, strongEvidence, 'docs/mmo.md')).toEqual([]);
    expect(validateAutocodeDocumentationMarkdown(strongMarkdown, 'docs/mmo.md', {
      isGameMmoDocumentation: true,
    })).toEqual([]);
  });

  it('requires coding completion summaries to state implementation, files, verification, and risks', () => {
    const weakIssues = validateAutocodeCodingSummary(
      {
        description: 'Fix auth session persistence bug.',
        filesToModify: ['src/auth/session-store.ts'],
      },
      'Done.',
    );

    expect(weakIssues.join('\n')).toContain('concrete implementation change');
    expect(weakIssues.join('\n')).toContain('touched files or changed contracts');
    expect(weakIssues.join('\n')).toContain('verification run');
    expect(weakIssues.join('\n')).toContain('review notes');

    const strongIssues = validateAutocodeCodingSummary(
      {
        description: 'Fix auth session persistence bug.',
        filesToModify: ['src/auth/session-store.ts'],
      },
      [
        '| Item | Details |',
        '| --- | --- |',
        '| What changed | Fixed session persistence in `src/auth/session-store.ts` and preserved the storage contract. |',
        '| Verification | Ran `npm test -- session-store.test.ts`. |',
        '| Review notes | No residual risks; edge cases for missing storage keys are covered. |',
      ].join('\n'),
    );

    expect(strongIssues).toEqual([]);
  });

  it('requires runnable user-facing work to include real startup verification', () => {
    const subtask = {
      description: 'Implement a browser game page with canvas controls.',
      filesToCreate: ['src/index.html'],
      filesToModify: ['src/game.js'],
    };

    expect(validateAutocodeRuntimeReadinessSummary(
      subtask,
      [
        '| Item | Details |',
        '| --- | --- |',
        '| What changed | Updated `src/index.html` and `src/game.js`. |',
        '| Verification | Ran `node --check src/game.js` and static unit tests. |',
        '| Review notes | No residual syntax risks. |',
      ].join('\n'),
    ).join('\n')).toContain('actual launch/open/browser/CLI smoke check');

    expect(validateAutocodeRuntimeReadinessSummary(
      subtask,
      [
        '| Item | Details |',
        '| --- | --- |',
        '| What changed | Updated `src/index.html` and `src/game.js`. |',
        '| Verification | Opened the page in Chrome with a browser smoke test; canvas rendered and no console errors were observed. |',
        '| Review notes | No residual startup risks. |',
      ].join('\n'),
    )).toEqual([]);
  });

  it('rejects runnable completion summaries with browser runtime failures', () => {
    const issues = validateAutocodeCodingSummary(
      {
        description: 'Fix browser game startup.',
        filesToModify: ['src/index.html', 'src/game.js'],
      },
      [
        '| Item | Details |',
        '| --- | --- |',
        '| What changed | Updated `src/index.html` and `src/game.js`. |',
        '| Verification | Browser smoke failed: CORS policy blocked `file:///src/game.js`; Failed to load resource: net::ERR_FAILED. |',
        '| Review notes | Startup remains blocked. |',
      ].join('\n'),
    );

    expect(issues.join('\n')).toContain('failed runnable verification');
  });

  it('skips coding summary checks for documentation-only subtasks', () => {
    expect(validateAutocodeCodingSummary(
      {
        description: 'Write architecture documentation.',
        filesToCreate: ['docs/architecture.md'],
      },
      'Created docs.',
    )).toEqual([]);
  });

  it('rejects bare passed QA reports that lack review evidence', () => {
    const issues = validateAutocodeQaReportQuality('Status: PASSED', 'qa_report.md');

    expect(getAutocodeQaReportStatus('Status: PASSED')).toBe('passed');
    expect(issues.join('\n')).toContain('approval-grade QA report');
    expect(issues.join('\n')).toContain('scope reviewed');
    expect(issues.join('\n')).toContain('concrete changed source/config file path');
  });

  it('accepts approval-grade QA reports with contracts, acceptance, verification, findings, and risk notes', () => {
    const report = [
      '# QA Report',
      '',
      'Status: PASSED',
      '',
      '## Scope Reviewed',
      '- Reviewed `spec.md`, `tasks.md`, `implementation_plan.md`, and changed source file `src/runtime/session.ts`.',
      '',
      '## Changed Files And Contracts',
      '| File | Contract / Boundary | Result |',
      '| --- | --- | --- |',
      '| `src/runtime/session.ts` | Public API input/output shape, data flow, side effects, and error behavior remain compatible. | passed |',
      '',
      '## Acceptance Matrix',
      '| Requirement | Evidence | Verification | Result |',
      '| --- | --- | --- | --- |',
      '| Persist session state across restart. | `tasks.md` Evidence and `src/runtime/session.ts`. | `npm test -- session.test.ts`. | passed |',
      '',
      '## Verification',
      '- Ran `npm test -- session.test.ts` and inspected `src/runtime/session.ts` for contract impact.',
      '',
      '## Findings',
      '- No blocking issues remain.',
      '',
      '## Residual Risks',
      '- No residual risks beyond release packaging not covered by this targeted test.',
    ].join('\n');

    expect(validateAutocodeQaReportQuality(report, 'qa_report.md')).toEqual([]);
  });

  it('requires passed QA reports for runnable changes to include startup evidence', () => {
    const weakReport = [
      '# QA Report',
      '',
      'Status: PASSED',
      '',
      '## Scope Reviewed',
      '- Reviewed `src/index.html`, `src/game.js`, and `tests/static-smoke.test.mjs`.',
      '',
      '## Changed Files And Contracts',
      '- Browser page entry and canvas rendering boundary were reviewed statically.',
      '',
      '## Acceptance Matrix',
      '- Requirement: game page loads. Evidence: `src/index.html` and `src/game.js`. Result: passed.',
      '',
      '## Verification',
      '- Ran `node --check src/game.js` and `node --test tests/static-smoke.test.mjs`.',
      '',
      '## Findings',
      '- No blocking issues remain.',
      '',
      '## Residual Risks',
      '- No residual risks.',
      '',
      genericFiller,
    ].join('\n');

    expect(validateAutocodeQaReportQuality(weakReport, 'qa_report.md').join('\n'))
      .toContain('without launch/open/browser/CLI smoke verification evidence');

    const strongReport = [
      '# QA Report',
      '',
      'Status: PASSED',
      '',
      '## Scope Reviewed',
      '- Reviewed `src/index.html`, `src/game.js`, and browser startup behavior.',
      '',
      '## Changed Files And Contracts',
      '- Browser page entry, canvas rendering, and startup contract were reviewed.',
      '',
      '## Acceptance Matrix',
      '- Requirement: game page loads. Evidence: `src/index.html` and `src/game.js`. Verification: browser smoke in Chrome. Result: passed.',
      '',
      '## Verification',
      '- Opened the page in Chrome via browser smoke; canvas rendered and no console errors were observed.',
      '',
      '## Findings',
      '- No blocking issues remain.',
      '',
      '## Residual Risks',
      '- No residual risks.',
      '',
      genericFiller,
    ].join('\n');

    expect(validateAutocodeQaReportQuality(strongReport, 'qa_report.md')).toEqual([]);
  });

  it('requires failed QA reports to include actionable fix and re-verification fields', () => {
    const weakIssues = validateAutocodeQaReportQuality([
      '# QA Report',
      '',
      'Status: FAILED',
      '',
      '## Scope Reviewed',
      '- Reviewed `src/runtime/session.ts`.',
      '',
      '## Changed Files And Contracts',
      '- Contract impact exists.',
      '',
      '## Acceptance Matrix',
      '- Requirement failed.',
      '',
      '## Verification',
      '- Test failed.',
      '',
      '## Findings',
      '- Something is broken.',
      '',
      '## Residual Risks',
      '- Risk remains.',
    ].join('\n'), 'qa_report.md');

    expect(weakIssues.join('\n')).toContain('issue location');
    expect(weakIssues.join('\n')).toContain('required fix');
    expect(weakIssues.join('\n')).toContain('re-verification');

    const strongIssues = validateAutocodeQaReportQuality([
      '# QA Report',
      '',
      'Status: FAILED',
      '',
      '## Scope Reviewed',
      '- Reviewed `spec.md`, `tasks.md`, `implementation_plan.md`, and `src/runtime/session.ts`.',
      '',
      '## Changed Files And Contracts',
      '- `src/runtime/session.ts` changed the session persistence contract and currently drops the restart data flow.',
      '',
      '## Acceptance Matrix',
      '- Requirement: persist session state. Evidence: `tasks.md` and `src/runtime/session.ts`. Result: failed.',
      '',
      '## Verification',
      '- `npm test -- session.test.ts` failed on restart persistence.',
      '',
      '## Findings',
      '### Restart session is lost',
      '- **Severity**: high',
      '- **Location**: `src/runtime/session.ts:42`',
      '- **Evidence**: observed failing restart assertion.',
      '- **Impacted requirement/contract**: session persistence requirement and storage contract.',
      '- **Required fix**: restore persisted session load before renderer state initialization.',
      '- **Re-verification**: rerun `npm test -- session.test.ts`.',
      '',
      '## Residual Risks',
      '- Risk remains until the storage migration path is re-verified.',
    ].join('\n'), 'qa_report.md');

    expect(strongIssues).toEqual([]);
  });

  it('requires MMO QA reports to cover domain matrix and high-risk MMO boundaries', () => {
    const weakIssues = validateAutocodeQaReportQuality([
      '# QA Report',
      '',
      'Status: PASSED',
      '',
      '## Scope Reviewed',
      '- Reviewed `server/combat/CombatService.cpp`, `client/combat/CombatView.cpp`, and `config/items/skills.xml`.',
      '',
      '## Changed Files And Contracts',
      '- Contracts look compatible.',
      '',
      '## Acceptance Matrix',
      '- Combat requirement passed.',
      '',
      '## Verification',
      '- Ran a targeted combat check.',
      '',
      '## Findings',
      '- No blocking issues remain.',
      '',
      '## Residual Risks',
      '- No residual risks.',
      '',
      mmoFiller,
    ].join('\n'), 'qa_report.md', { isGameMmo: true });

    expect(weakIssues.join('\n')).toContain('MMO domain matrix');
    expect(weakIssues.join('\n')).toContain('server authority');
    expect(weakIssues.join('\n')).toContain('security/anti-cheat');

    const strongIssues = validateAutocodeQaReportQuality([
      '# QA Report',
      '',
      'Status: PASSED',
      '',
      '## Scope Reviewed',
      '- Reviewed `server/combat/CombatService.cpp`, `client/combat/CombatView.cpp`, `config/items/skills.xml`, and `tools/gm/CombatInspector.cs`.',
      '',
      '## MMO Domain Matrix',
      '| Domain | Source/config paths | Authority / contract | Result |',
      '| --- | --- | --- | --- |',
      '| Server authority | `server/combat/CombatService.cpp` | Server authoritative damage validation and trust boundary preserved. | passed |',
      '| Network sync/protocol | `client/combat/CombatView.cpp` | Replication, prediction, and reconciliation assumptions unchanged. | passed |',
      '| Persistence/data/config | `config/items/skills.xml` | Skill config and save data contract remain compatible. | passed |',
      '| Tools/content/liveops/release | `tools/gm/CombatInspector.cs` | GM tooling, telemetry, rollout, and release inspection remain compatible. | passed |',
      '',
      '## Changed Files And Contracts',
      '- Gameplay/client presentation, server authority, protocol, data/config, tooling, performance, security/anti-cheat, and liveops contracts were checked.',
      '',
      '## Acceptance Matrix',
      '- Requirement: combat skill update. Evidence: MMO source paths above. Verification: targeted combat smoke check. Result: passed.',
      '',
      '## Verification',
      '- Ran targeted combat smoke check; manually inspected frame/latency/performance, security exploit path, anti-cheat validation, telemetry, and release risk notes.',
      '',
      '## Findings',
      '- No blocking issues remain.',
      '',
      '## Residual Risks',
      '- No residual risks beyond production bandwidth budgets not exercised by the local check.',
      '',
      mmoFiller,
    ].join('\n'), 'qa_report.md', { isGameMmo: true });

    expect(strongIssues).toEqual([]);
  });
});
