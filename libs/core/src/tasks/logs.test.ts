import { describe, expect, it } from 'vitest';

import { parseAutocodeTaskLogs, serializeAutocodeTaskLogs, stripNoisyAutocodeTaskLogText } from './logs.js';

describe('Autocode task logs', () => {
  it('strips known Codex diagnostic noise from persisted text entries', () => {
    const logs = parseAutocodeTaskLogs(
      serializeAutocodeTaskLogs({
        spec_id: '001-task',
        created_at: '2026-06-11T03:43:24.179Z',
        updated_at: '2026-06-11T03:45:04.741Z',
        phases: {
          planning: {
            phase: 'planning',
            status: 'completed',
            started_at: '2026-06-11T03:43:24.179Z',
            completed_at: '2026-06-11T03:45:04.741Z',
            entries: [
              {
                timestamp: '2026-06-11T03:43:24.644Z',
                type: 'text',
                content:
                  '2026-06-11T03:43:24.644758Z  WARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell',
                phase: 'planning',
              },
              {
                timestamp: '2026-06-11T03:43:24.801Z',
                type: 'text',
                content: [
                  "2026-06-11T03:43:24.801820Z  WARN codex_core_skills::loader: ignoring interface.icon_small: icon path with '..' must resolve under plugin assets/",
                  "2026-06-11T03:43:24.801843Z  WARN codex_core_skills::loader: ignoring interface.icon_large: icon path with '..' must resolve under plugin assets/",
                ].join('\n'),
                phase: 'planning',
              },
              {
                timestamp: '2026-06-11T03:43:37.404Z',
                type: 'text',
                content: 'I鈥檒l read the Standard task spec files only.',
                phase: 'planning',
              },
            ],
          },
          coding: { phase: 'coding', status: 'pending', started_at: null, completed_at: null, entries: [] },
          validation: { phase: 'validation', status: 'pending', started_at: null, completed_at: null, entries: [] },
        },
      }),
      '001-task',
    );

    expect(logs.phases.planning.entries).toHaveLength(1);
    expect(logs.phases.planning.entries[0]?.content).toBe(
      'I’ll read the Standard task spec files only.',
    );
  });

  it('removes noisy lines without dropping useful neighboring output', () => {
    expect(
      stripNoisyAutocodeTaskLogText(
        [
          'before',
          '2026-06-11T03:43:24.729548Z  WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt[0]: prompt must be at most 128 characters path=C:\\Users\\LS\\.codex\\.tmp\\plugins\\plugins\\ngs-analysis\\.codex-plugin/plugin.json',
          'after',
        ].join('\n'),
      ),
    ).toBe('before\nafter');
  });

  it('treats tool output after a terminal phase record as renewed phase activity', () => {
    const logs = parseAutocodeTaskLogs(
      [
        {
          record_type: 'meta',
          spec_id: '001-task',
          created_at: '2026-06-17T03:52:55.409Z',
          updated_at: '2026-06-17T03:52:55.409Z',
        },
        {
          record_type: 'phase',
          timestamp: '2026-06-17T03:55:40.819Z',
          phase: 'coding',
          status: 'failed',
          started_at: '2026-06-17T03:54:40.287Z',
          completed_at: '2026-06-17T03:55:40.819Z',
        },
        {
          record_type: 'entry',
          entry: {
            timestamp: '2026-06-17T03:55:40.823Z',
            type: 'info',
            phase: 'coding',
            content: '[FileCache] Session Stats',
          },
        },
        {
          record_type: 'entry',
          entry: {
            timestamp: '2026-06-17T03:55:52.571Z',
            type: 'tool_start',
            phase: 'coding',
            content: '[Write] Z:/repo/.autocode/project-docs/doc_outline.md',
            tool_name: 'Write',
            tool_input: 'Z:/repo/.autocode/project-docs/doc_outline.md',
            subtask_id: '1.1',
          },
        },
      ].map((record) => JSON.stringify(record)).join('\n'),
      '001-task',
    );

    expect(logs.phases.coding.status).toBe('active');
    expect(logs.phases.coding.completed_at).toBeNull();
  });
});
