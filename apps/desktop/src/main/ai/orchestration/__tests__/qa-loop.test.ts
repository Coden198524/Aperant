import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockUnlink = vi.fn();
const mockLoadAutocodeImplementationPlan = vi.fn();
const mockUpdateAutocodeImplementationPlan = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

vi.mock('@autocode/core', () => ({
  loadAutocodeImplementationPlan: (...args: unknown[]) => mockLoadAutocodeImplementationPlan(...args),
  updateAutocodeImplementationPlan: (...args: unknown[]) => mockUpdateAutocodeImplementationPlan(...args),
}));

vi.mock('../../utils/json-repair', () => ({
  safeParseJson: (raw: string) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
}));

vi.mock('../qa-reports', () => ({
  generateQAReport: vi.fn(() => '# QA Report'),
  generateEscalationReport: vi.fn(() => '# Escalation Report'),
  generateManualTestPlan: vi.fn().mockResolvedValue('# Manual Test Plan'),
}));

// qa-loop.ts imports from '../schema' (relative to orchestration/)
// which resolves to src/main/ai/schema/index.ts
vi.mock('../../schema', () => ({
  QASignoffSchema: {},
  validateStructuredOutput: vi.fn((_data: unknown, _schema: unknown) => ({
    valid: true,
    data: _data,
  })),
}));

import { QALoop } from '../qa-loop';
import type { QAIssue, QALoopConfig, QASessionRunConfig } from '../qa-loop';
import type { SessionResult } from '../../session/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SPEC_DIR = '/project/.autocode/specs/001-feature';
const PROJECT_DIR = '/project';

function completedPlan(qaStatus?: 'approved' | 'rejected' | 'unknown') {
  const plan: Record<string, unknown> = {
    phases: [
      { subtasks: [{ status: 'completed' }, { status: 'completed' }] },
    ],
  };

  if (qaStatus === 'approved') {
    plan.qa_signoff = { status: 'approved', issues_found: [] };
  } else if (qaStatus === 'rejected') {
    plan.qa_signoff = { status: 'rejected', issues_found: [{ title: 'Test failure', type: 'critical' }] };
  }
  // qaStatus === 'unknown' 鈫?no qa_signoff key

  return plan;
}

function makeSessionResult(outcome: SessionResult['outcome']): SessionResult {
  return {
    outcome,
    error: outcome === 'error' ? new Error('session error') : undefined,
    totalSteps: 1,
    lastMessage: '',
  } as unknown as SessionResult;
}

function makeConfig(overrides: Partial<QALoopConfig> = {}): QALoopConfig {
  return {
    specDir: SPEC_DIR,
    projectDir: PROJECT_DIR,
    maxIterations: 5,
    generatePrompt: vi.fn().mockResolvedValue('system prompt'),
    runSession: vi.fn().mockResolvedValue(makeSessionResult('completed')),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QALoop', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockUnlink.mockReset().mockResolvedValue(undefined);
    mockLoadAutocodeImplementationPlan.mockReset();
    mockUpdateAutocodeImplementationPlan.mockReset().mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Build completeness guard
  // -------------------------------------------------------------------------

  it('returns error outcome when build is not complete', async () => {
    // Plan with a non-completed subtask
    const plan = {
      phases: [{ subtasks: [{ status: 'pending' }] }],
    };

    // No QA_FIX_REQUEST.md either
    mockLoadAutocodeImplementationPlan.mockResolvedValue(plan);
    mockReadFile.mockImplementation((_path: string) => {
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig();
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('error');
  });

  // -------------------------------------------------------------------------
  // Already approved
  // -------------------------------------------------------------------------

  it('returns approved immediately when QA signoff is already "approved"', async () => {
    const plan = completedPlan('approved');

    mockLoadAutocodeImplementationPlan.mockResolvedValue(plan);
    mockReadFile.mockImplementation((_path: string) => {
      // QA_FIX_REQUEST.md does not exist
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig();
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(true);
    expect(outcome.totalIterations).toBe(0);
    // runSession should NOT have been called (short-circuit)
    expect(config.runSession).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // QA approved on first iteration
  // -------------------------------------------------------------------------

  it('approves on the first iteration when reviewer returns approved', async () => {
    // Let the reviewer run session set the approved state, then all subsequent reads return approved
    let sessionCallCount = 0;
    let _planReadCount = 0;

    const runSession = vi.fn().mockImplementation(async () => {
      sessionCallCount++;
      return makeSessionResult('completed');
    });

    mockLoadAutocodeImplementationPlan.mockImplementation(() => {
      _planReadCount++;
      // Before the reviewer has run, return no signoff (build complete, no qa yet)
      if (sessionCallCount === 0) return Promise.resolve(completedPlan());
      // After the reviewer ran, return approved
      return Promise.resolve(completedPlan('approved'));
    });
    mockReadFile.mockImplementation((_path: string) => {
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig({ runSession, maxIterations: 5 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(true);
    // Should have approved within the first few iterations
    expect(outcome.totalIterations).toBeGreaterThanOrEqual(1);
    // Only the reviewer should have been called (no fixer needed)
    const calls = runSession.mock.calls as Array<[QASessionRunConfig]>;
    expect(calls.every((c) => c[0].agentType === 'qa_reviewer')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Rejected then approved on retry
  // -------------------------------------------------------------------------

  it('runs fixer then approves on second iteration', async () => {
    // Track how many times runSession has been called so we know which "phase" we're in
    let sessionCallCount = 0;
    let planReadCount = 0;

    const runSession = vi.fn().mockImplementation(async () => {
      sessionCallCount++;
      return makeSessionResult('completed');
    });

    mockLoadAutocodeImplementationPlan.mockImplementation(() => {
      planReadCount++;
      if (planReadCount === 1) return Promise.resolve(completedPlan()); // isBuildComplete
      // Reviewer on iteration 1 ran when sessionCallCount >= 1
      // Serve rejected until fixer has run (sessionCallCount >= 2), then approved
      if (sessionCallCount < 2) {
        return Promise.resolve(completedPlan('rejected'));
      }
      return Promise.resolve(completedPlan('approved'));
    });
    mockReadFile.mockImplementation((_path: string) => {
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig({ runSession, maxIterations: 5 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(true);
    // At minimum: reviewer (iter 1) + fixer + reviewer (iter 2) = 3
    expect(sessionCallCount).toBeGreaterThanOrEqual(3);
    const calls = runSession.mock.calls as Array<[QASessionRunConfig]>;
    const agentTypes = calls.map((c) => c[0].agentType);
    expect(agentTypes).toContain('qa_reviewer');
    expect(agentTypes).toContain('qa_fixer');
  });

  // -------------------------------------------------------------------------
  // Max iterations reached
  // -------------------------------------------------------------------------

  it('returns max_iterations when approval is never reached', async () => {
    // Always return "rejected" status with a unique issue each time
    // so recurring_issues threshold is never reached within maxIterations=2
    let planReadCount = 0;

    mockLoadAutocodeImplementationPlan.mockImplementation(() => {
      planReadCount++;
      if (planReadCount === 1) return Promise.resolve(completedPlan()); // build complete check

      // Return distinct issues each time to avoid recurring_issues escalation
      return Promise.resolve({
        phases: [{ subtasks: [{ status: 'completed' }] }],
        qa_signoff: {
          status: 'rejected',
          issues_found: [{ title: `Unique issue ${planReadCount}`, type: 'warning' }],
        },
      });
    });
    mockReadFile.mockImplementation((_path: string) => {
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig({ maxIterations: 2 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('max_iterations');
  });

  // -------------------------------------------------------------------------
  // Consecutive error escalation
  // -------------------------------------------------------------------------

  it('escalates after MAX_CONSECUTIVE_ERRORS (3) consecutive unknown status responses', async () => {
    let planReadCount = 0;

    mockLoadAutocodeImplementationPlan.mockImplementation(() => {
      planReadCount++;
      if (planReadCount === 1) return Promise.resolve(completedPlan()); // build complete
      // Return a plan with no qa_signoff -> "unknown" status
      return Promise.resolve({
        phases: [{ subtasks: [{ status: 'completed' }] }],
      });
    });
    mockReadFile.mockImplementation((_path: string) => {
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig({ maxIterations: 10 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('consecutive_errors');
  });

  // -------------------------------------------------------------------------
  // Recurring issue detection
  // -------------------------------------------------------------------------

  it('escalates when the same issue recurs 3 or more times', async () => {
    const recurringIssue = { title: 'Null pointer exception', type: 'critical' as const };
    const rejectedPlan = {
      phases: [{ subtasks: [{ status: 'completed' }] }],
      qa_signoff: { status: 'rejected', issues_found: [recurringIssue] },
    };

    let planReadCount = 0;

    mockLoadAutocodeImplementationPlan.mockImplementation(() => {
      planReadCount++;
      if (planReadCount === 1) return Promise.resolve(completedPlan()); // build complete
      return Promise.resolve(rejectedPlan);
    });
    mockReadFile.mockImplementation((_path: string) => {
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig({ maxIterations: 10 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('recurring_issues');
  });

  // -------------------------------------------------------------------------
  // Cancellation via AbortSignal
  // -------------------------------------------------------------------------

  it('returns cancelled outcome when aborted before first iteration runs', async () => {
    const controller = new AbortController();

    mockLoadAutocodeImplementationPlan.mockResolvedValue(completedPlan());
    mockReadFile.mockImplementation((_path: string) => {
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig({ abortSignal: controller.signal, maxIterations: 5 });
    const loop = new QALoop(config);

    // Abort after construction so the event listener fires
    controller.abort();

    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('cancelled');
  });

  // -------------------------------------------------------------------------
  // Fixer error handling
  // -------------------------------------------------------------------------

  it('returns error outcome when fixer session fails', async () => {
    let planReadCount = 0;

    mockLoadAutocodeImplementationPlan.mockImplementation(() => {
      planReadCount++;
      if (planReadCount === 1) return Promise.resolve(completedPlan());
      return Promise.resolve(completedPlan('rejected'));
    });
    mockReadFile.mockImplementation((_path: string) => {
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn()
      .mockResolvedValueOnce(makeSessionResult('completed')) // reviewer iteration 1
      .mockResolvedValueOnce(makeSessionResult('error'));     // fixer fails

    const config = makeConfig({ runSession, maxIterations: 5 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('error');
  });

  // -------------------------------------------------------------------------
  // Reviewer cancelled mid-loop
  // -------------------------------------------------------------------------

  it('returns cancelled when reviewer session is cancelled', async () => {
    let planReadCount = 0;

    mockLoadAutocodeImplementationPlan.mockImplementation(() => {
      planReadCount++;
      if (planReadCount === 1) return Promise.resolve(completedPlan());
      return Promise.resolve(completedPlan());
    });
    mockReadFile.mockImplementation((_path: string) => {
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn().mockResolvedValueOnce(makeSessionResult('cancelled'));

    const config = makeConfig({ runSession, maxIterations: 5 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toBe('cancelled');
  });

  // -------------------------------------------------------------------------
  // Human feedback processing
  // -------------------------------------------------------------------------

  it('processes QA_FIX_REQUEST.md before running the review loop', async () => {
    // QA_FIX_REQUEST.md exists
    mockLoadAutocodeImplementationPlan.mockResolvedValue(completedPlan('approved'));
    mockReadFile.mockImplementation((path: string) => {
      if (path.endsWith('QA_FIX_REQUEST.md')) return Promise.resolve('Fix this please');
      return Promise.reject(new Error('ENOENT'));
    });

    const runSession = vi.fn().mockResolvedValue(makeSessionResult('completed'));
    const config = makeConfig({ runSession, maxIterations: 5 });
    const loop = new QALoop(config);
    const outcome = await loop.run();

    // Fixer should have been invoked for human feedback
    const calls = runSession.mock.calls as Array<[QASessionRunConfig]>;
    expect(calls.some((c) => c[0].agentType === 'qa_fixer')).toBe(true);
    // Fix request file should be deleted
    expect(mockUnlink).toHaveBeenCalledWith(path.join(SPEC_DIR, 'QA_FIX_REQUEST.md'));
    // Overall outcome should still reflect the QA result
    expect(outcome.approved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  it('emits qa-complete event with the final outcome', async () => {
    let planReadCount = 0;
    mockLoadAutocodeImplementationPlan.mockImplementation(() => {
      planReadCount++;
      if (planReadCount === 1) return Promise.resolve(completedPlan());
      return Promise.resolve(completedPlan('approved'));
    });
    mockReadFile.mockImplementation((_path: string) => {
      return Promise.reject(new Error('ENOENT'));
    });

    const config = makeConfig();
    const loop = new QALoop(config);

    const completedEvents: unknown[] = [];
    loop.on('qa-complete', (outcome) => completedEvents.push(outcome));

    await loop.run();

    expect(completedEvents).toHaveLength(1);
    expect((completedEvents[0] as { approved: boolean }).approved).toBe(true);
  });

  it('compacts QA iteration history persisted into the implementation plan', async () => {
    const longIssue = {
      title: `Rendering regression ${'title detail '.repeat(40)}TAIL_TITLE`,
      type: 'critical' as const,
      location: `src/renderer/App.tsx:${'location detail '.repeat(30)}TAIL_LOCATION`,
      description: `The QA reviewer copied verbose test output ${'stack trace line '.repeat(120)}TAIL_DESCRIPTION`,
      fix_required: `Apply a minimal fix ${'repair instruction '.repeat(120)}TAIL_FIX`,
    };
    const issues = [
      longIssue,
      ...Array.from({ length: 10 }, (_, index) => ({
        title: `Additional issue ${index}`,
        type: 'warning' as const,
        description: `extra issue ${index}`,
      })),
    ];
    const plan = {
      phases: [{ subtasks: [{ status: 'completed' }] }],
      qa_signoff: { status: 'rejected', issues_found: issues },
    };
    mockLoadAutocodeImplementationPlan.mockResolvedValue(plan);
    mockUpdateAutocodeImplementationPlan.mockImplementation(async (
      _specDir: string,
      updater: (currentPlan: typeof plan) => typeof plan,
    ) => updater(plan));

    const loop = new QALoop(makeConfig());
    const recordIteration = (loop as unknown as {
      recordIteration: (
        iteration: number,
        status: 'approved' | 'rejected' | 'error',
        issues: QAIssue[],
        durationMs: number,
      ) => Promise<void>;
    }).recordIteration.bind(loop);

    await recordIteration(1, 'rejected', issues, 1234);

    expect(mockUpdateAutocodeImplementationPlan).toHaveBeenCalledTimes(1);
    const savedPlan = plan as typeof plan & {
      qa_iteration_history: Array<{ issues: Array<Record<string, string>> }>;
      qa_signoff: { issues_found: Array<Record<string, string>> };
    };
    const savedHistoryIssueText = JSON.stringify(savedPlan.qa_iteration_history[0].issues);
    const savedSignoffIssueText = JSON.stringify(savedPlan.qa_signoff.issues_found);

    expect(savedPlan.qa_iteration_history[0].issues).toHaveLength(9);
    expect(savedPlan.qa_signoff.issues_found).toHaveLength(9);
    expect(savedHistoryIssueText).toContain('truncated');
    expect(savedHistoryIssueText).toContain('3 more QA issue(s) omitted');
    expect(savedHistoryIssueText).toContain('TAIL_TITLE');
    expect(savedHistoryIssueText).toContain('TAIL_LOCATION');
    expect(savedHistoryIssueText).toContain('TAIL_DESCRIPTION');
    expect(savedHistoryIssueText).toContain('TAIL_FIX');
    expect(savedSignoffIssueText).toContain('TAIL_DESCRIPTION');
    expect(savedSignoffIssueText).toContain('TAIL_FIX');
  });
});
