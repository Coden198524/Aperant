import { describe, expect, it } from 'vitest';

import {
  AUTOCODE_SESSION_CODEBASE_MAP_FILE_NAME,
  AUTOCODE_SESSION_GOTCHAS_FILE_NAME,
  AUTOCODE_SESSION_PATTERNS_FILE_NAME,
} from '../memory/session-memory.js';
import { AUTOCODE_TASK_ARTIFACTS } from '../tasks/artifacts.js';
import {
  AUTOCODE_COMPETITOR_ANALYSIS_FILE_NAME,
  AUTOCODE_GENERATION_PROGRESS_FILE_NAME,
  AUTOCODE_IDEATION_CONTEXT_FILE_NAME,
  AUTOCODE_IDEATION_FILE_NAME,
  AUTOCODE_INSIGHTS_CURRENT_SESSION_FILE_NAME,
  AUTOCODE_INSIGHTS_LEGACY_SESSION_FILE_NAME,
  AUTOCODE_MANUAL_COMPETITORS_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_EVIDENCE_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_OUTLINE_FILE_NAME,
  AUTOCODE_PROJECT_INDEX_FILE_NAME,
  AUTOCODE_PROJECT_PROMPT_PROFILE_FILE_NAME,
  AUTOCODE_ROADMAP_DISCOVERY_FILE_NAME,
  AUTOCODE_ROADMAP_FILE_NAME,
  getAutocodeIdeationTypeIdeasPath,
} from './data-paths.js';

describe('Autocode data path file formats', () => {
  it('keeps program-owned configuration, state, and structured data artifacts as JSON', () => {
    const programOwnedJsonFiles = [
      AUTOCODE_PROJECT_INDEX_FILE_NAME,
      AUTOCODE_GENERATION_PROGRESS_FILE_NAME,
      AUTOCODE_PROJECT_PROMPT_PROFILE_FILE_NAME,
      AUTOCODE_ROADMAP_FILE_NAME,
      AUTOCODE_ROADMAP_DISCOVERY_FILE_NAME,
      AUTOCODE_COMPETITOR_ANALYSIS_FILE_NAME,
      AUTOCODE_MANUAL_COMPETITORS_FILE_NAME,
      AUTOCODE_IDEATION_FILE_NAME,
      AUTOCODE_INSIGHTS_CURRENT_SESSION_FILE_NAME,
      AUTOCODE_INSIGHTS_LEGACY_SESSION_FILE_NAME,
      AUTOCODE_SESSION_CODEBASE_MAP_FILE_NAME,
      AUTOCODE_TASK_ARTIFACTS.taskMetadata,
      AUTOCODE_TASK_ARTIFACTS.taskLogs,
      AUTOCODE_TASK_ARTIFACTS.directSession,
      AUTOCODE_TASK_ARTIFACTS.runResult,
    ];

    expect(programOwnedJsonFiles).toEqual(
      expect.arrayContaining([
        'project_index.json',
        'prompt_profile.json',
        'roadmap.json',
        'roadmap_discovery.json',
        'ideation.json',
        'task_metadata.json',
        'codebase_map.json',
      ]),
    );
    for (const fileName of programOwnedJsonFiles) {
      expect(fileName).toMatch(/\.jsonl?$/);
    }
  });

  it('keeps model-produced structured results as JSON when the app parses them', () => {
    expect(AUTOCODE_ROADMAP_DISCOVERY_FILE_NAME).toBe('roadmap_discovery.json');
    expect(AUTOCODE_COMPETITOR_ANALYSIS_FILE_NAME).toBe('competitor_analysis.json');
    expect(AUTOCODE_MANUAL_COMPETITORS_FILE_NAME).toBe('manual_competitors.json');
    expect(AUTOCODE_IDEATION_FILE_NAME).toBe('ideation.json');
    expect(getAutocodeIdeationTypeIdeasPath('C:/project', 'security').replace(/\\/g, '/'))
      .toBe('C:/project/.autocode/ideation/security_ideas.json');
  });

  it('uses Markdown for model-readable documentation context artifacts', () => {
    expect(AUTOCODE_PROJECT_DOCS_OUTLINE_FILE_NAME).toBe('doc_outline.md');
    expect(AUTOCODE_PROJECT_DOCS_EVIDENCE_FILE_NAME).toBe('evidence_index.md');
    expect(AUTOCODE_IDEATION_CONTEXT_FILE_NAME).toBe('ideation_context.md');
    expect(AUTOCODE_TASK_ARTIFACTS.context).toBe('context.md');
    expect(AUTOCODE_TASK_ARTIFACTS.research).toBe('research.md');
    expect(AUTOCODE_TASK_ARTIFACTS.requirements).toBe('requirements.md');
    expect(AUTOCODE_TASK_ARTIFACTS.tasks).toBe('tasks.md');
    expect(AUTOCODE_TASK_ARTIFACTS.implementationPlan).toBe('implementation_plan.md');
    expect(AUTOCODE_SESSION_GOTCHAS_FILE_NAME).toBe('gotchas.md');
    expect(AUTOCODE_SESSION_PATTERNS_FILE_NAME).toBe('patterns.md');
  });
});
