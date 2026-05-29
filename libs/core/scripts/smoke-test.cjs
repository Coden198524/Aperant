const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, join } = require('node:path');

function normalizePath(value) {
  return value.replace(/\\/g, '/');
}

async function main() {
  const core = await import('../dist/index.js');
  const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-core-smoke-'));

  try {
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'sample-project',
        scripts: { build: 'tsc', test: 'vitest' },
        dependencies: { react: '^19.0.0' },
        devDependencies: {
          '@vitejs/plugin-react': '^5.0.0',
          typescript: '^5.0.0',
          vite: '^7.0.0',
          vitest: '^4.0.0',
        },
      }, null, 2),
    );
    writeFileSync(join(projectRoot, 'package-lock.json'), '{}');
    writeFileSync(join(projectRoot, 'tsconfig.json'), '{}');
    mkdirSync(join(projectRoot, 'src'));
    writeFileSync(join(projectRoot, 'src', 'main.tsx'), 'export const value = 1;\n');

    const summary = core.summarizeWorkspace(projectRoot);
    assert.equal(summary.name, 'sample-project');
    assert.equal(summary.packageManager, 'npm');
    assert.equal(summary.hasGit, false);
    assert.ok(summary.detectedFrameworks.includes('React'));
    assert.ok(summary.detectedLanguages.includes('TypeScript React'));
    assert.ok(summary.scripts.includes('build'));

    const stack = new core.StackDetector(projectRoot).detectAll();
    assert.ok(stack.languages.includes('typescript'));
    assert.ok(stack.packageManagers.includes('npm'));

    const frameworks = new core.FrameworkDetector(projectRoot).detectAll();
    assert.ok(frameworks.includes('react'));
    assert.ok(frameworks.includes('vite'));

    const projectIndex = core.buildProjectIndex(projectRoot);
    assert.equal(projectIndex.project_type, 'single');
    assert.equal(projectIndex.services.main.framework, 'React + Vite');
    assert.equal(projectIndex.services.main.type, 'frontend');
    assert.equal(projectIndex.services.main.package_manager, 'npm');
    assert.ok(projectIndex.source_summary.languages.includes('TypeScript'));
    assert.ok(projectIndex.source_summary.config_files.includes('tsconfig.json'));

    const projectIndexPath = core.getAutocodeProjectIndexPath(projectRoot);
    assert.equal(normalizePath(projectIndexPath), normalizePath(join(projectRoot, '.autocode', 'project_index.json')));
    assert.equal(core.getAutocodeProjectEnvRelativePath(), '.autocode/.env');
    assert.equal(core.getAutocodeProjectIndexRelativePath('.custom'), '.custom/project_index.json');
    assert.equal(core.getAutocodeProjectPromptsRelativeDir(), '.autocode/prompts');
    assert.equal(core.getAutocodeProjectPromptProfileRelativePath(), '.autocode/prompt_profile.json');
    assert.equal(core.getAutocodeProjectDocsRelativeDir(), '.autocode/project-docs');
    assert.equal(core.getAutocodeProjectDocsRelativePath(core.AUTOCODE_PROJECT_DOCS_PRODUCT_FILE_NAME), '.autocode/project-docs/product.md');
    assert.equal(
      normalizePath(core.getAutocodeProjectDocsDir(projectRoot)),
      normalizePath(join(projectRoot, '.autocode', 'project-docs')),
    );
    assert.equal(
      normalizePath(core.getAutocodeProjectDocsPath(projectRoot, core.AUTOCODE_PROJECT_DOCS_ARCHITECTURE_FILE_NAME)),
      normalizePath(join(projectRoot, '.autocode', 'project-docs', 'architecture.md')),
    );
    assert.equal(
      normalizePath(core.getAutocodeSpecNumberLockPath(projectRoot)),
      normalizePath(join(projectRoot, '.autocode', '.locks', 'spec-numbering.lock')),
    );
    assert.equal(
      normalizePath(core.getAutocodeToolOutputDir(projectRoot)),
      normalizePath(join(projectRoot, '.autocode', 'tool-output')),
    );
    assert.equal(
      normalizePath(core.getAutocodeDeepSeekSmartTerminalDir(projectRoot)),
      normalizePath(join(projectRoot, '.autocode', 'smart-terminal', 'deepseek')),
    );
    assert.equal(
      normalizePath(core.getAutocodeGithubDir(projectRoot)),
      normalizePath(join(projectRoot, '.autocode', 'github')),
    );
    assert.equal(
      normalizePath(core.getAutocodeGitlabDir(projectRoot)),
      normalizePath(join(projectRoot, '.autocode', 'gitlab')),
    );
    assert.equal(
      normalizePath(core.getAutocodeYunxiaoDir(projectRoot)),
      normalizePath(join(projectRoot, '.autocode', 'yunxiao')),
    );
    assert.equal(
      normalizePath(core.getAutocodeGithubTmpCommentBodyPath(projectRoot)),
      normalizePath(join(projectRoot, '.autocode', 'tmp_comment_body.txt')),
    );
    assert.equal(
      normalizePath(core.getAutocodeRoadmapFilePath(projectRoot)),
      normalizePath(join(projectRoot, '.autocode', 'roadmap', 'roadmap.json')),
    );
    assert.equal(
      normalizePath(core.getAutocodeIdeationFilePath(projectRoot, '.custom')),
      normalizePath(join(projectRoot, '.custom', 'ideation', 'ideation.json')),
    );
    assert.equal(
      normalizePath(core.getAutocodeInsightsSessionPath(projectRoot, 'session-1')),
      normalizePath(join(projectRoot, '.autocode', 'insights', 'sessions', 'session-1.json')),
    );
    assert.equal(
      normalizePath(core.getAutocodeSessionMemoryDir(join(projectRoot, '.autocode', 'specs', 'sample-task'))),
      normalizePath(join(projectRoot, '.autocode', 'specs', 'sample-task', 'memory')),
    );
    const codebaseMap = core.recordAutocodeSessionDiscovery(
      core.createEmptyAutocodeSessionCodebaseMap(),
      {
        filePath: 'src/main.tsx',
        description: 'Main React entry point',
        category: 'ui',
      },
      new Date('2026-01-02T03:04:00.000Z'),
    );
    assert.equal(codebaseMap.last_updated, '2026-01-02T03:04:00.000Z');
    assert.equal(
      core.parseAutocodeSessionCodebaseMap(core.stringifyAutocodeSessionCodebaseMap(codebaseMap)).discovered_files['src/main.tsx'].category,
      'ui',
    );
    assert.equal(
      core.formatAutocodeGotchaMarkdownEntry({ gotcha: 'Use Edit for small corrections.', context: 'tooling' }, new Date('2026-01-02T03:04:00.000Z')),
      '\n## [2026-01-02 03:04]\nUse Edit for small corrections.\n\n_Context: tooling_\n',
    );
    const sessionContext = core.buildAutocodeSessionContext({
      codebaseMap,
      gotchasMarkdown: '# Gotchas\n\nUse Edit for small corrections.',
    });
    assert.ok(sessionContext.includes('## Codebase Discoveries'));
    assert.ok(sessionContext.includes('`src/main.tsx`: Main React entry point'));
    assert.ok(sessionContext.includes('## Gotchas'));

    const rendererMemory = core.toAutocodeRendererMemory({
      id: 'mem-1',
      type: 'gotcha',
      content: 'Use Edit for small corrections.',
      confidence: 0.9,
      tags: ['tools'],
      relatedFiles: ['src/main.tsx'],
      relatedModules: ['main'],
      createdAt: '2026-01-02T03:04:00.000Z',
      lastAccessedAt: '2026-01-02T03:04:00.000Z',
      accessCount: 2,
      scope: 'global',
      source: 'agent_explicit',
      sessionId: 'session-1',
      provenanceSessionIds: [],
      projectId: 'project-1',
      pinned: true,
    });
    assert.equal(rendererMemory.pinned, true);
    assert.equal(core.toAutocodeContextSearchResult(rendererMemory).score, 0.9);
    const writtenProjectIndex = core.runProjectIndexer(projectRoot, projectIndexPath);
    assert.equal(writtenProjectIndex.services.main.framework, 'React + Vite');
    assert.ok(existsSync(projectIndexPath));

    const projectProfile = await core.analyzeProject(projectRoot, join(projectRoot, '.autocode'), true);
    assert.ok(projectProfile.detectedStack.languages.includes('typescript'));
    assert.ok(projectProfile.detectedStack.frameworks.includes('react'));
    assert.ok(projectProfile.customScripts.npmScripts.includes('build'));
    assert.ok(core.buildSecurityProfile(projectProfile).getAllAllowedCommands().has('npm'));

    const storageDir = join(projectRoot, '.test-client', 'tasks');
    const draft = core.createTaskDraft({
      projectRoot,
      title: 'Add workspace summary',
      description: 'Use core summary data in a frontend client.',
      storageDir,
    });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.title, 'Add workspace summary');

    const drafts = core.listTaskDrafts(projectRoot, { storageDir });
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].id, draft.id);

    const draftFile = JSON.parse(readFileSync(core.getTaskDraftsFilePath(projectRoot, { storageDir }), 'utf8'));
    assert.equal(draftFile.version, 1);
    assert.equal(draftFile.drafts.length, 1);

    const task = core.createAutocodeTask({
      projectRoot,
      dataDirName: '.autocode',
      title: 'Add provider settings',
      description: 'Create provider account settings shared by desktop and VS Code.',
      metadata: { category: 'feature', workflowMode: 'balanced' },
      requirements: {
        attached_images: [{ filename: 'settings.png', path: 'attachments/settings.png', description: '' }],
      },
    });
    assert.match(task.specId, /^001-add-provider-settings/);
    assert.equal(task.status, 'backlog');
    assert.ok(existsSync(join(task.specsPath, 'implementation_plan.md')));
    assert.ok(existsSync(join(task.specsPath, 'requirements.md')));
    const requirements = core.loadAutocodeTaskRequirementsSync(task.specsPath);
    assert.equal(requirements.task_description, 'Create provider account settings shared by desktop and VS Code.');
    assert.equal(requirements.workflow_type, 'feature');
    assert.deepEqual(requirements.attached_images, [
      { filename: 'settings.png', path: 'attachments/settings.png', description: '' },
    ]);

    const specRuntimePlan = core.createAutocodeAgentRuntimeStartPlan({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
    });
    assert.equal(specRuntimePlan.mode, 'spec');
    assert.equal(specRuntimePlan.processType, 'spec-creation');
    assert.equal(specRuntimePlan.planStatus, 'planning');
    assert.equal(specRuntimePlan.executionPhase, 'planning');
    assert.equal(specRuntimePlan.taskDescription, 'Create provider account settings shared by desktop and VS Code.');
    assert.equal(core.getAutocodeAgentRuntimeModeLabel(specRuntimePlan.mode), 'spec creation');

    const workspaceView = core.buildAutocodeWorkspaceSummaryViewModel(summary, projectIndex);
    assert.equal(workspaceView.name, 'sample-project');
    assert.equal(workspaceView.packageManagerLabel, 'npm');
    assert.equal(workspaceView.frameworksLabel.includes('React'), true);
    assert.ok(workspaceView.rows.some((row) => row.key === 'services' && row.value.includes('main')));

    const workspaceState = core.buildAutocodeWorkspaceState({ projectRoot, dataDirName: '.autocode' });
    assert.equal(workspaceState.projectRoot, projectRoot);
    assert.equal(workspaceState.tasks.length, 1);
    assert.equal(workspaceState.summary.name, 'sample-project');
    assert.equal(workspaceState.projectIndex.project_type, 'single');

    const tasks = core.listAutocodeTasks({ projectRoot, dataDirName: '.autocode' });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, task.id);
    assert.equal(tasks[0].description, 'Create provider account settings shared by desktop and VS Code.');

    const importedTask = core.createImportedAutocodeTask({
      projectRoot,
      dataDirName: '.autocode',
      title: 'Investigate imported GitHub issue',
      description: 'Imported issue body from GitHub.',
      metadata: {
        sourceType: 'github',
        githubIssueNumber: 42,
        githubUrl: 'https://example.com/issues/42',
        category: 'bug_fix',
      },
      requirements: {
        workflow_type: 'bug_fix',
      },
    });
    assert.match(importedTask.specId, /^002-investigate-imported-github-issue/);
    assert.equal(importedTask.metadata.sourceType, 'github');
    assert.equal(
      core.loadAutocodeTaskRequirementsSync(importedTask.specsPath).workflow_type,
      'bug_fix',
    );
    assert.throws(() => {
      core.createImportedAutocodeTask({
        projectRoot,
        dataDirName: '.autocode',
        specId: importedTask.specId,
        title: 'Duplicate import',
        description: 'Should not overwrite an existing imported task.',
        metadata: { sourceType: 'github' },
      });
    }, /already exists/);

    const projectDocsResult = core.createAutocodeProjectDocumentationTask({
      projectRoot,
      dataDirName: '.autocode',
      documentType: 'full',
      now: '2026-01-01T00:00:00.000Z',
    });
    assert.match(projectDocsResult.task.specId, /^003-/);
    assert.equal(projectDocsResult.task.metadata.sourceType, 'project_docs');
    assert.equal(projectDocsResult.task.metadata.projectDocumentType, 'full');
    assert.equal(projectDocsResult.plan.requirements.workflow_type, 'documentation');
    assert.equal(projectDocsResult.plan.requirements.project_documentation.document_type, 'full');
    assert.deepEqual(projectDocsResult.plan.requirements.project_documentation.future_usage, [
      'spec-phase-context',
      'coding-phase-context',
    ]);
    assert.equal(projectDocsResult.plan.implementationPlan.document_outputs.base, 'project');
    assert.equal(projectDocsResult.plan.implementationPlan.document_outputs.final_markdown, '.autocode/project-docs/index.md');
    assert.deepEqual(projectDocsResult.plan.outputs.map((output) => output.relativePath), [
      '.autocode/project-docs/index.md',
      '.autocode/project-docs/product.md',
      '.autocode/project-docs/architecture.md',
      '.autocode/project-docs/technical.md',
    ]);
    assert.ok(projectDocsResult.plan.implementationPlan.document_outputs.markdown_files.includes('.autocode/project-docs/product.md'));
    assert.equal(projectDocsResult.plan.implementationPlan.document_outputs.outline, '.autocode/project-docs/doc_outline.json');
    assert.equal(projectDocsResult.plan.implementationPlan.document_outputs.evidence_index, '.autocode/project-docs/evidence_index.json');
    const projectDocsPlanText = readFileSync(join(projectDocsResult.task.specsPath, 'implementation_plan.md'), 'utf8');
    assert.doesNotMatch(projectDocsPlanText, /spec-reference|coding-reference/i);
    assert.doesNotMatch(JSON.stringify(projectDocsResult.plan), /spec-reference|coding-reference/i);

    const projectDocsDir = core.getAutocodeProjectDocsDir(projectRoot, '.autocode');
    mkdirSync(projectDocsDir, { recursive: true });
    writeFileSync(
      join(projectDocsDir, 'index.md'),
      '# Project Docs\n\nUse product, architecture, and technical docs as project context.\n',
      'utf8',
    );
    writeFileSync(
      join(projectDocsDir, 'architecture.md'),
      '# Architecture\n\nSource evidence: src/main.tsx. Renderer owns UI; core owns shared protocols.\n',
      'utf8',
    );
    writeFileSync(
      join(projectDocsDir, 'technical.md'),
      '# Technical\n\nRun npm test for validation and keep TypeScript interfaces in core.\n',
      'utf8',
    );
    writeFileSync(
      join(projectDocsDir, 'product.md'),
      '# Product\n\nAutocode helps users turn project context into specs and implementation work.\n',
      'utf8',
    );

    const projectDocsReference = core.buildAutocodeProjectDocsReferencePrompt({ projectRoot, dataDirName: '.autocode' });
    assert.match(projectDocsReference, /Project Documentation Reference/);
    assert.match(projectDocsReference, /architecture\.md/);
    assert.match(projectDocsReference, /technical\.md/);
    assert.match(projectDocsReference, /product\.md/);
    assert.doesNotMatch(projectDocsReference, /spec-reference|coding-reference/i);
    const referencedDocs = core.collectAutocodeProjectDocsReferences({ projectRoot, dataDirName: '.autocode' });
    assert.deepEqual(referencedDocs.map((reference) => reference.relativePath), [
      '.autocode/project-docs/index.md',
      '.autocode/project-docs/architecture.md',
      '.autocode/project-docs/technical.md',
      '.autocode/project-docs/product.md',
    ]);

    const specPromptWithDocs = core.createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName: '.autocode',
      taskId: projectDocsResult.task.id,
      cli: 'codex',
      phase: 'spec',
    }).prompt;
    assert.match(specPromptWithDocs, /Project Documentation Reference/);
    const codingMessagesWithDocs = core.buildAutocodeTaskExecutionMessages({
      specDir: task.specsPath,
      specId: task.specId,
      projectRoot,
      dataDirName: '.autocode',
    });
    assert.match(codingMessagesWithDocs[0].content, /Project Documentation Reference/);
    assert.match(codingMessagesWithDocs[0].content, /```markdown/);
    const directMessagesWithDocs = core.buildAutocodeDirectTaskExecutionMessages({
      specDir: task.specsPath,
      specId: task.specId,
      projectRoot,
      dataDirName: '.autocode',
    });
    assert.match(directMessagesWithDocs[0].content, /Project Documentation Reference/);

    const mutablePlan = core.createMinimalAutocodePlan(
      {
        title: 'Plan utilities',
        description: 'Exercise shared plan-file helpers.',
        createdAt: '2024-01-01T00:00:00.000Z',
      },
      'backlog',
      '2024-01-01T00:00:00.000Z',
    );
    core.applyAutocodePlanStatusAndReason(mutablePlan, 'human_review', {
      reviewReason: 'completed',
      xstateState: 'human_review',
      executionPhase: 'complete',
      now: '2024-01-01T00:01:00.000Z',
    });
    assert.equal(mutablePlan.planStatus, 'review');
    assert.equal(mutablePlan.reviewReason, 'completed');
    core.applyAutocodePlanTokenUsage(mutablePlan, {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      stepsExecuted: 2,
      sessionId: 'a',
    }, '2024-01-01T00:02:00.000Z');
    core.applyAutocodePlanTokenUsage(mutablePlan, {
      promptTokens: 8,
      completionTokens: 7,
      totalTokens: 15,
      stepsExecuted: 3,
      sessionId: 'b',
    }, '2024-01-01T00:03:00.000Z');
    assert.equal(mutablePlan.tokenUsage.stepsExecuted, 3);
    assert.equal(mutablePlan.tokenUsage.completionTokens, 7);
    assert.equal(mutablePlan.tokenUsage.sessionId, 'b');

    const resetPlan = {
      phases: [{
        subtasks: [
          { id: '1', status: 'in_progress', started_at: 'now' },
          { id: '2', status: 'failed', completed_at: 'now' },
          { id: '3', status: 'completed' },
        ],
      }],
    };
    const resetResult = core.resetAutocodeStuckSubtasksInPlan(resetPlan);
    assert.equal(resetResult.resetCount, 2);
    assert.equal(core.countAutocodePlanSubtasks(resetPlan.phases), 3);
    assert.equal(core.canSyncAutocodePlanPhases(resetPlan.phases, []), false);

    const parsedCliArgs = core.parseAutocodeCommandArgs(['run', task.id, '--cli', 'codex', '--json']);
    assert.equal(parsedCliArgs.command, 'run');
    assert.equal(core.getAutocodeStringOption(parsedCliArgs, 'cli'), 'codex');
    assert.equal(core.hasAutocodeJsonOption(parsedCliArgs), true);
    assert.equal(core.isAutocodeCli('deepseek'), true);
    assert.equal(core.isAutocodeCli('unknown-cli'), false);
    assert.equal(core.buildAutocodeCliCommand({ cli: 'codex', bypassPermissions: true }), 'codex --dangerously-bypass-approvals-and-sandbox');
    assert.equal(core.buildAutocodeSpecId(7, '涓枃浠诲姟', 'yunxiao'), '007-yunxiao');
    assert.equal(core.AUTOCODE_TASK_ARTIFACTS.implementationPlan, 'implementation_plan.md');
    assert.equal(core.getAutocodeSpecsRelativeDir('.autocode'), '.autocode/specs');
    assert.equal(core.isAutocodeTaskArtifactFileName('qa_report.md'), true);
    assert.ok(core.AUTOCODE_TOOL_GENERATED_DIR_NAMES.includes('.codex'));
    assert.equal(core.shouldSkipAutocodeWorkspaceDir('node_modules'), true);
    assert.equal(core.shouldHideAutocodeTaskGitChangePath('.cursor/rules.json'), true);
    assert.equal(core.isAutocodeGeneratedPath('.autocode/tool-output/result.json'), true);
    assert.ok(core.formatAutocodeIgnoredDirNamesForPrompt().includes('.codex'));
    assert.equal(core.AUTOCODE_PROJECT_DEFAULT_BRANCH_MARKER, '__project_default__');
    assert.equal(core.normalizeAutocodeBaseBranch('origin/develop'), 'develop');
    assert.equal(core.normalizeAutocodeBaseBranch('__project_default__'), null);
    assert.equal(core.isAutocodeGitBranchName('feature/add-settings'), true);
    assert.equal(core.isAutocodeGitBranchName('-bad'), false);
    assert.equal(core.isAutocodeCommonBaseBranch('origin/trunk'), true);
    assert.equal(core.parseAutocodeOriginHeadBranch('refs/remotes/origin/main'), 'main');
    assert.equal(core.parseAutocodeOriginHeadBranch('origin/develop'), 'develop');
    assert.equal(core.buildAutocodeTaskBranchName('001-task'), 'autocode/001-task');
    assert.deepEqual(
      core.validateAutocodeWorktreeBranch('feature/main-project', 'autocode/001-task'),
      { branchToDelete: 'autocode/001-task', usedFallback: true, reason: 'invalid_pattern' },
    );
    assert.equal(core.getAutocodeTaskWorktreesRelativeDir('.autocode'), '.autocode/worktrees/tasks');
    assert.equal(core.getAutocodeTerminalWorktreesRelativeDir('.autocode'), '.autocode/worktrees/terminal');
    assert.equal(core.getAutocodePrWorktreesRelativeDir('.autocode'), '.autocode/worktrees/pr');
    assert.equal(core.getAutocodeLegacyGithubPrWorktreesRelativeDir('.autocode'), '.autocode/github/pr/worktrees');
    assert.equal(core.getAutocodeTerminalMetadataRelativeDir('.autocode'), '.autocode/terminal/metadata');
    assert.equal(core.isValidAutocodePathId('001-task'), true);
    assert.equal(core.isValidAutocodePathId('../bad'), false);
    assert.equal(core.isAutocodePathWithinBase(join(projectRoot, '.autocode', 'specs'), projectRoot), true);
    assert.equal(core.isAutocodePathWithinBase(join(projectRoot, '..', 'outside'), projectRoot), false);
    assert.equal(
      core.getAutocodeTaskWorktreeCandidatePaths(projectRoot, '001-task').length,
      4,
    );
    assert.deepEqual(
      core.detectAutocodeWorktreeIsolation(join(projectRoot, '.autocode', 'worktrees', 'tasks', '001-task')),
      [true, projectRoot],
    );
    assert.deepEqual(
      core.detectAutocodeWorktreeIsolation(join(projectRoot, '.autocode', 'github', 'pr', 'worktrees', '42')),
      [true, projectRoot],
    );
    assert.deepEqual(
      core.detectAutocodeWorktreeIsolation(join(projectRoot, '.worktrees', '001-task')),
      [true, projectRoot],
    );
    assert.equal(core.inferAutocodePinnedProviderFromModel('sonnet'), null);
    assert.equal(core.inferAutocodePinnedProviderFromModel('opus-4.7'), 'anthropic');
    assert.equal(core.inferAutocodePinnedProviderFromModel('gpt-5.5'), 'openai');
    assert.equal(core.resolveAutocodeCrossProviderModelRequest('claude-sonnet-4-6'), 'sonnet');
    assert.equal(core.resolveAutocodeTaskPhaseProvider({
      phaseProviders: { coding: 'google' },
      phaseModels: { coding: 'sonnet' },
    }, 'coding'), 'google');
    assert.equal(core.resolveAutocodeTaskWorkflowMode({ workflowMode: 'off' }), 'off');
    assert.equal(core.resolveAutocodeTaskEnableBatchExecution({ enableBatchExecution: true }), true);
    assert.equal(core.resolveAutocodeTaskPhaseModelId({
      metadata: {
        phaseModels: { coding: 'sonnet' },
        phaseProviders: { coding: 'google' },
      },
      phase: 'coding',
      resolveModelEquivalent: (model, provider) => provider === 'google' && model === 'sonnet'
        ? { modelId: 'gemini-2.5-flash' }
        : null,
    }), 'gemini-2.5-flash');
    const runtimeOptions = core.buildAutocodeSessionRuntimeOptions({
      workflowMode: 'balanced',
      agentType: 'build_orchestrator',
      env: {
        CONTEXT7_ENABLED: 'false',
        LINEAR_API_KEY: 'linear-key',
        GRAPHITI_MCP_URL: 'http://memory.local',
        ELECTRON_MCP_ENABLED: 'true',
        AGENT_MCP_build_orchestrator_ADD: 'playwright',
        CUSTOM_MCP_SERVERS: JSON.stringify([
          { id: 'docs', name: 'Docs', type: 'http', url: 'https://mcp.example.test' },
          { id: 'bad', name: 'Bad', type: 'command' },
        ]),
      },
    });
    assert.equal(runtimeOptions.maxSteps, core.AUTOCODE_DEFAULT_SESSION_MAX_STEPS);
    assert.equal(runtimeOptions.mcpOptions.context7Enabled, false);
    assert.equal(runtimeOptions.mcpOptions.linearEnabled, true);
    assert.equal(runtimeOptions.mcpOptions.memoryEnabled, true);
    assert.equal(runtimeOptions.mcpOptions.electronMcpEnabled, true);
    assert.equal(runtimeOptions.mcpOptions.agentMcpAdd, 'playwright');
    assert.equal(runtimeOptions.mcpOptions.customMcpServers.length, 1);
    const directRuntimeOptions = core.buildAutocodeSessionRuntimeOptions({
      workflowMode: 'off',
      agentType: 'direct_task',
      env: { CUSTOM_MCP_SERVERS: runtimeOptions.mcpOptions.mcpEnv.CUSTOM_MCP_SERVERS },
    });
    assert.equal(directRuntimeOptions.maxSteps, core.AUTOCODE_DIRECT_WORKFLOW_PHASE_STEP_BUDGETS.coding);
    assert.equal(directRuntimeOptions.mcpOptions.customMcpServers.length, 0);

    const specRunPlan = core.createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
      cli: 'claude-code',
    });
    assert.equal(specRunPlan.phase, 'spec');
    assert.equal(specRunPlan.command, 'claude');
    assert.ok(existsSync(specRunPlan.promptFilePath));
    assert.ok(existsSync(specRunPlan.runnerFilePath));
    assert.ok(core.buildAutocodeTaskRunnerShellCommand(specRunPlan).includes('autocode-runner.cjs'));
    const runnerScript = readFileSync(specRunPlan.runnerFilePath, 'utf8');
    assert.ok(runnerScript.includes('autocode-run-result.json'));
    assert.ok(runnerScript.includes("stdio: ['pipe', 'pipe', 'pipe']"));
    assert.ok(runnerScript.includes("appendTaskLogEntry(logPhase, 'text'"));
    assert.ok(runnerScript.includes('emitPhase(executionPhase, startMessage, 0)'));
    assert.ok(runnerScript.includes("upsertPlanMetadata(content, 'Execution Phase'"));
    assert.ok(runnerScript.includes('upsertPlanMachineMetadata(content'));
    assert.ok(runnerScript.includes("xstateState: phaseValue"));

    writeFileSync(join(task.specsPath, 'spec.md'), '# Add provider settings\n\n## Overview\nImplement settings.\n');
    const planningRunPlan = core.createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
      cli: 'codex',
      bypassPermissions: true,
      language: 'zh-CN',
    });
    assert.equal(planningRunPlan.phase, 'planning');
    assert.equal(planningRunPlan.command, 'codex');
    assert.ok(planningRunPlan.args.includes('--json'));
    assert.ok(planningRunPlan.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.match(planningRunPlan.prompt, /Simplified Chinese/);
    assert.match(planningRunPlan.prompt, /implementation_plan\.md/);
    const codexRunnerScript = readFileSync(planningRunPlan.runnerFilePath, 'utf8');
    assert.ok(codexRunnerScript.includes('processCodexJsonLine'));
    assert.ok(codexRunnerScript.includes('normalizeCodexTokenUsage'));
    assert.ok(codexRunnerScript.includes('__TASK_TOKEN_USAGE__'));
    const codingMessages = core.buildAutocodeTaskExecutionMessages({
      specDir: task.specsPath,
      specId: task.specId,
      projectRoot,
      language: 'zh-CN',
    });
    assert.equal(codingMessages[0].role, 'user');
    assert.ok(codingMessages[0].content.includes('implementation_plan.md'));
    assert.ok(codingMessages[0].content.includes('Simplified Chinese'));
    const planningRuntimePlan = core.createAutocodeAgentRuntimeStartPlan({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
    });
    assert.equal(planningRuntimePlan.mode, 'planning');
    assert.equal(planningRuntimePlan.processType, 'task-execution');
    assert.equal(planningRuntimePlan.planStatus, 'planning');
    const runningPlanningTask = core.updateAutocodeTaskPlanStatus({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
      planStatus: planningRunPlan.planStatus,
      executionPhase: planningRunPlan.executionPhase,
    });
    assert.equal(runningPlanningTask.status, 'in_progress');

    core.updateAutocodeTaskLogPhase({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
      phase: 'planning',
      status: 'active',
      message: 'Planning started.',
    });
    core.appendAutocodeTaskLogEntry({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
      phase: 'planning',
      type: 'info',
      content: 'Planning log entry.',
    });
    const taskLogs = core.readAutocodeTaskLogs({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
    });
    assert.equal(taskLogs.phases.planning.status, 'active');
    assert.equal(taskLogs.phases.planning.entries.length, 2);
    const taskLogsFromSpecDir = core.readAutocodeTaskLogsFromSpecDir(task.specsPath);
    assert.equal(taskLogsFromSpecDir.spec_id, task.id);
    core.saveAutocodeImplementationPlanSync(task.specsPath, {
      feature: task.title,
      status: 'in_progress',
      executionPhase: 'planning',
      xstateState: 'planning',
      phases: [{ id: '1', name: 'Implementation', subtasks: [{ id: '1.1', title: 'Build UI', description: 'Add UI', status: 'in_progress' }] }],
    });
    core.updateAutocodeTaskLogPhase({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
      phase: 'coding',
      status: 'active',
      message: 'Coding started.',
    });
    const stalePhaseLoadedTask = core.loadAutocodeProjectTasks({
      projectRoot,
      dataDirName: '.autocode',
      persistStaleStatusCorrections: false,
    }).find((candidate) => candidate.id === task.id);
    assert.equal(stalePhaseLoadedTask.executionProgress.phase, 'coding');
    const salvagedTaskLogs = core.parseAutocodeTaskLogs(
      '{"spec_id":"broken-task","phases":{"coding":{"started_at":"2026-01-01T00:00:00.000Z","entries":[{"timestamp":"2026-01-01T00:00:01.000Z","type":"info","content":"Recovered","phase":"coding"}]}}',
      'fallback-task',
    );
    assert.equal(salvagedTaskLogs.spec_id, 'broken-task');
    assert.equal(salvagedTaskLogs.phases.coding.status, 'active');
    assert.equal(salvagedTaskLogs.phases.coding.entries[0].content, 'Recovered');
    const worktreeTaskLogs = core.createEmptyAutocodeTaskLogs(task.id, '2026-01-01T00:00:00.000Z');
    worktreeTaskLogs.updated_at = '2026-01-01T00:01:00.000Z';
    worktreeTaskLogs.phases.coding.status = 'active';
    worktreeTaskLogs.phases.coding.entries.push({
      timestamp: '2026-01-01T00:01:00.000Z',
      type: 'info',
      phase: 'coding',
      content: 'Coding from worktree.',
    });
    const mergedTaskLogs = core.mergeAutocodeTaskLogs(taskLogs, worktreeTaskLogs);
    assert.equal(mergedTaskLogs.phases.planning.entries.length, 2);
    assert.equal(mergedTaskLogs.phases.coding.entries[0].content, 'Coding from worktree.');
    const taskView = core.buildAutocodeTaskCardViewModel(runningPlanningTask, taskLogs, {
      latestLogEntries: 1,
      logContentMaxLength: 80,
    });
    assert.equal(taskView.specId, task.specId);
    assert.equal(taskView.status, 'in_progress');
    assert.equal(taskView.logs.phaseStatusText, 'planning: active | coding: pending | validation: pending');
    assert.equal(taskView.logs.latestEntries.length, 1);
    assert.match(taskView.metaText, /subtasks/);

    core.saveAutocodeImplementationPlanSync(task.specsPath, {
      feature: task.title,
      status: 'pending',
      phases: [{ id: '1', name: 'Implementation', subtasks: [{ id: '1.1', title: 'Build UI', description: 'Add UI', status: 'pending' }] }],
    });
    const codingRunPlan = core.createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
      cli: 'gemini',
    });
    assert.equal(codingRunPlan.phase, 'coding');
    assert.equal(codingRunPlan.command, 'gemini');
    const codingRuntimePlan = core.createAutocodeAgentRuntimeStartPlan({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
    });
    assert.equal(codingRuntimePlan.mode, 'coding');
    assert.equal(codingRuntimePlan.processType, 'task-execution');
    assert.equal(codingRuntimePlan.planStatus, 'coding');
    assert.equal(codingRuntimePlan.executionPhase, 'coding');
    const worktreeSpecDir = join(projectRoot, '.autocode', 'worktrees', 'tasks', 'wt-1', '.autocode', 'specs', task.specId);
    mkdirSync(worktreeSpecDir, { recursive: true });
    core.saveAutocodeImplementationPlanSync(worktreeSpecDir, {
      feature: task.title,
      description: 'Worktree fallback description',
      status: 'human_review',
      reviewReason: 'completed',
      phases: [{ id: '1', name: 'Implementation', subtasks: [{ id: '1.1', title: 'Build UI', description: 'Add UI', status: 'completed' }] }],
    });
    const loadedProjectTasks = core.loadAutocodeProjectTasks({
      projectRoot,
      dataDirName: '.autocode',
      worktreesDir: join(projectRoot, '.autocode', 'worktrees', 'tasks'),
      persistStaleStatusCorrections: false,
    });
    const mergedProjectTask = loadedProjectTasks.find((candidate) => candidate.id === task.id);
    assert.equal(mergedProjectTask.status, 'backlog');
    assert.equal(mergedProjectTask.subtasks[0].status, 'completed');
    assert.equal(mergedProjectTask.location, 'main');

    const startedAgentRuntime = core.createStartedAutocodeAgentRuntime({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
      cli: 'codex',
    });
    assert.equal(startedAgentRuntime.runtimePlan.mode, 'coding');
    assert.equal(startedAgentRuntime.taskRunPlan.phase, 'coding');
    assert.equal(startedAgentRuntime.request.runner.phase, 'coding');
    assert.equal(startedAgentRuntime.request.runner.process.command, 'node');
    assert.equal(startedAgentRuntime.request.runner.terminal.name, `Autocode: ${task.specId}`);
    assert.ok(startedAgentRuntime.request.messages.prepared.includes('task coding'));

    let processStartOptions = null;
    const processResult = await core.startAutocodeAgentRuntime(startedAgentRuntime.request, core.createProcessAgentRuntimeAdapter({
      process: {
        startProcess(options) {
          processStartOptions = options;
          return { status: 'completed', exitCode: 0 };
        },
      },
    }));
    assert.equal(processResult.status, 'completed');
    assert.equal(processStartOptions.command, 'node');

    let terminalStartOptions = null;
    const terminalResult = await core.startAutocodeAgentRuntime(startedAgentRuntime.request, core.createTerminalAgentRuntimeAdapter({
      terminal: {
        async runCommand(options) {
          terminalStartOptions = options;
        },
      },
    }));
    assert.equal(terminalResult.status, 'started');
    assert.equal(terminalStartOptions.name, `Autocode: ${task.specId}`);

    const startedRuntimePlans = [];
    await core.startAutocodeAgentRuntime(codingRuntimePlan, {
      startRuntime(request) {
        startedRuntimePlans.push(request.plan);
      },
    });
    assert.equal(startedRuntimePlans[0].taskId, task.id);
    assert.deepEqual(
      core.resolveAutocodeTaskStartEvent({
        task: { status: 'human_review', reviewReason: 'plan_review' },
        currentState: 'plan_review',
        planHasSubtasks: true,
      }),
      { type: 'PLAN_APPROVED' },
    );
    assert.deepEqual(
      core.resolveAutocodeTaskStartEvent({
        task: { status: 'human_review', reviewReason: 'stopped' },
        currentState: 'human_review',
        planHasSubtasks: false,
      }),
      { type: 'PLANNING_STARTED' },
    );
    assert.deepEqual(
      core.resolveAutocodeTaskStartEvent({
        task: { status: 'human_review', reviewReason: 'completed' },
        currentState: 'human_review',
        planHasSubtasks: true,
      }),
      { type: 'USER_RESUMED' },
    );
    assert.deepEqual(
      core.resolveAutocodeTaskStartEvent({
        task: { status: 'in_progress' },
        currentState: 'planning',
        planHasSubtasks: true,
      }),
      {
        type: 'CODING_STARTED',
        subtaskId: 'implementation-plan',
        subtaskDescription: 'Implementation plan execution',
      },
    );
    assert.deepEqual(
      core.resolveAutocodeTaskStartEvent({
        task: { status: 'backlog' },
        currentState: null,
        planHasSubtasks: true,
      }),
      {
        type: 'CODING_STARTED',
        subtaskId: 'implementation-plan',
        subtaskDescription: 'Implementation plan execution',
      },
    );

    const fakeCliPath = writeFakeCustomCli(projectRoot);
    const fakeCustomCliCommand = `node "${normalizePath(fakeCliPath)}"`;
    const fakeFlowTask = core.createAutocodeTask({
      projectRoot,
      dataDirName: '.autocode',
      title: 'Run fake custom CLI flow',
      description: 'Exercise a complete custom CLI runner lifecycle.',
      metadata: { category: 'testing', workflowMode: 'balanced' },
    });
    const fakeSpecRuntime = core.createStartedAutocodeAgentRuntime({
      projectRoot,
      dataDirName: '.autocode',
      taskId: fakeFlowTask.id,
      cli: 'custom',
      customCommand: fakeCustomCliCommand,
    });
    assert.equal(fakeSpecRuntime.runtimePlan.mode, 'spec');
    assert.equal(fakeSpecRuntime.taskRunPlan.command, 'node');
    assert.deepEqual(fakeSpecRuntime.taskRunPlan.args, [normalizePath(fakeCliPath)]);

    const fakeSpecResult = await core.startAutocodeAgentRuntime(
      fakeSpecRuntime.request,
      core.createProcessAgentRuntimeAdapter({ process: createSmokeProcessAdapter() }),
    );
    assert.equal(fakeSpecResult.status, 'completed');
    assert.equal(JSON.parse(readFileSync(join(fakeFlowTask.specsPath, 'autocode-run-result.json'), 'utf8')).phase, 'spec');
    assert.ok(readFileSync(join(fakeFlowTask.specsPath, 'spec.md'), 'utf8').includes('Fake Custom CLI Spec'));
    const fakePlannedTask = core.listAutocodeTasks({ projectRoot, dataDirName: '.autocode' })
      .find((candidate) => candidate.id === fakeFlowTask.id);
    assert.equal(fakePlannedTask.status, 'human_review');
    assert.equal(fakePlannedTask.reviewReason, 'plan_review');
    assert.equal(fakePlannedTask.executionPhase, 'planning');
    assert.equal(fakePlannedTask.subtasks.length, 1);
    assert.equal(fakePlannedTask.subtasks[0].status, 'pending');

    const fakeCodingRuntime = core.createStartedAutocodeAgentRuntime({
      projectRoot,
      dataDirName: '.autocode',
      taskId: fakeFlowTask.id,
      cli: 'custom',
      customCommand: fakeCustomCliCommand,
    });
    assert.equal(fakeCodingRuntime.runtimePlan.mode, 'coding');
    assert.equal(fakeCodingRuntime.taskRunPlan.phase, 'coding');
    const fakeCodingResult = await core.startAutocodeAgentRuntime(
      fakeCodingRuntime.request,
      core.createProcessAgentRuntimeAdapter({ process: createSmokeProcessAdapter() }),
    );
    assert.equal(fakeCodingResult.status, 'completed');
    assert.ok(existsSync(join(fakeFlowTask.specsPath, 'direct_summary.md')));
    assert.equal(JSON.parse(readFileSync(join(fakeFlowTask.specsPath, 'autocode-run-result.json'), 'utf8')).phase, 'coding');
    const fakeImplementedTask = core.listAutocodeTasks({ projectRoot, dataDirName: '.autocode' })
      .find((candidate) => candidate.id === fakeFlowTask.id);
    assert.equal(fakeImplementedTask.status, 'human_review');
    assert.equal(fakeImplementedTask.reviewReason, 'completed');
    assert.equal(fakeImplementedTask.executionPhase, 'complete');
    assert.equal(fakeImplementedTask.subtasks[0].status, 'completed');
    const fakeLogs = core.readAutocodeTaskLogs({
      projectRoot,
      dataDirName: '.autocode',
      taskId: fakeFlowTask.id,
    });
    assert.equal(fakeLogs.phases.planning.status, 'completed');
    assert.equal(fakeLogs.phases.coding.status, 'completed');
    assert.ok(
      [
        ...fakeLogs.phases.planning.entries,
        ...fakeLogs.phases.coding.entries,
      ].some((entry) => entry.type === 'text' && entry.content.includes('Fake custom CLI')),
    );

    const fakeDoneTask = core.markAutocodeTaskDone({
      projectRoot,
      dataDirName: '.autocode',
      taskId: fakeFlowTask.id,
    });
    assert.equal(fakeDoneTask.status, 'done');
    assert.equal(fakeDoneTask.executionPhase, 'complete');

    const retryCliPath = writeRetryingPlanCli(projectRoot);
    const retryCliCommand = `node "${normalizePath(retryCliPath)}"`;
    const retryTask = core.createAutocodeTask({
      projectRoot,
      dataDirName: '.autocode',
      title: 'Retry missing subtasks',
      description: 'Exercise CLI planning retry when no executable subtasks are written.',
      metadata: { category: 'testing', workflowMode: 'balanced' },
    });
    writeFileSync(
      join(retryTask.specsPath, 'spec.md'),
      '# Retry Missing Subtasks Spec\n\nThe implementation plan must be repaired by the CLI runner.\n',
      'utf8',
    );
    const retryRuntime = core.createStartedAutocodeAgentRuntime({
      projectRoot,
      dataDirName: '.autocode',
      taskId: retryTask.id,
      cli: 'custom',
      customCommand: retryCliCommand,
    });
    assert.equal(retryRuntime.runtimePlan.mode, 'planning');
    const retryResult = await core.startAutocodeAgentRuntime(
      retryRuntime.request,
      core.createProcessAgentRuntimeAdapter({ process: createSmokeProcessAdapter() }),
    );
    assert.equal(retryResult.status, 'completed');
    const retryPlannedTask = core.listAutocodeTasks({ projectRoot, dataDirName: '.autocode' })
      .find((candidate) => candidate.id === retryTask.id);
    assert.equal(retryPlannedTask.status, 'human_review');
    assert.equal(retryPlannedTask.reviewReason, 'plan_review');
    assert.equal(retryPlannedTask.subtasks.length, 1);
    assert.equal(retryPlannedTask.subtasks[0].title, 'Repair plan on retry');
    const retryLogs = core.readAutocodeTaskLogs({
      projectRoot,
      dataDirName: '.autocode',
      taskId: retryTask.id,
    });
    assert.ok(
      retryLogs.phases.planning.entries.some((entry) =>
        entry.content.includes('CLI finished without creating implementation_plan.md subtasks') &&
        entry.content.includes('Retrying 1/2'),
      ),
    );

    const fakeCodexBinDir = writeFakeCodexCli(projectRoot);
    const codexUsageTask = core.createAutocodeTask({
      projectRoot,
      dataDirName: '.autocode',
      title: 'Track Codex CLI usage',
      description: 'Exercise Codex JSON usage accounting without a token_count event.',
      metadata: { category: 'testing', workflowMode: 'balanced' },
    });
    writeFileSync(
      join(codexUsageTask.specsPath, 'spec.md'),
      '# Track Codex CLI Usage Spec\n\nThe fake Codex CLI should generate a plan and usage data.\n',
      'utf8',
    );
    const codexUsageRuntime = core.createStartedAutocodeAgentRuntime({
      projectRoot,
      dataDirName: '.autocode',
      taskId: codexUsageTask.id,
      cli: 'codex',
      language: 'zh-CN',
    });
    assert.equal(codexUsageRuntime.runtimePlan.mode, 'planning');
    assert.ok(codexUsageRuntime.taskRunPlan.args.includes('--json'));
    const codexUsageResult = await core.startAutocodeAgentRuntime(
      codexUsageRuntime.request,
      core.createProcessAgentRuntimeAdapter({
        process: createSmokeProcessAdapter({
          env: {
            PATH: `${fakeCodexBinDir}${delimiter}${process.env.PATH || ''}`,
          },
        }),
      }),
    );
    assert.equal(codexUsageResult.status, 'completed');
    assert.ok(codexUsageResult.process.message.includes('__TASK_TOKEN_USAGE__'));
    const codexPlanContent = readFileSync(join(codexUsageTask.specsPath, 'implementation_plan.md'), 'utf8');
    const codexPlanMetadata = readPlanMachineMetadata(codexPlanContent);
    assert.deepEqual(codexPlanMetadata.tokenUsage, {
      promptTokens: 123,
      completionTokens: 45,
      totalTokens: 168,
      thinkingTokens: 12,
      cacheReadTokens: 7,
      stepsExecuted: 2,
      sessionId: 'codex-session-1',
    });
    const codexUsageLogs = core.readAutocodeTaskLogs({
      projectRoot,
      dataDirName: '.autocode',
      taskId: codexUsageTask.id,
    });
    assert.ok(
      codexUsageLogs.phases.planning.entries.some((entry) =>
        entry.content.includes('模型用量更新：请求 2 次') &&
        entry.content.includes('总计 168 tokens'),
      ),
    );

    const directTask = core.createAutocodeTask({
      projectRoot,
      dataDirName: '.autocode',
      title: 'Run direct cleanup',
      description: 'Apply a direct code cleanup without spec orchestration.',
      metadata: { category: 'refactoring', workflowMode: 'off' },
    });
    const directRuntimePlan = core.createAutocodeAgentRuntimeStartPlan({
      projectRoot,
      dataDirName: '.autocode',
      taskId: directTask.id,
    });
    assert.equal(directRuntimePlan.mode, 'direct');
    assert.equal(directRuntimePlan.processType, 'task-execution');
    const directStartedRuntime = core.createStartedAutocodeAgentRuntime({
      projectRoot,
      dataDirName: '.autocode',
      taskId: directTask.id,
      cli: 'codex',
      model: 'gpt-5.5',
    });
    assert.equal(directStartedRuntime.taskRunPlan.phase, 'direct');
    assert.deepEqual(directStartedRuntime.taskRunPlan.args, ['exec', '--json', '-m', 'gpt-5.5', '-']);
    assert.ok(readFileSync(directStartedRuntime.taskRunPlan.promptFilePath, 'utf8').includes('directly'));
    assert.deepEqual(
      core.resolveAutocodeTaskStartEvent({
        task: directTask,
        currentState: null,
        planHasSubtasks: false,
      }),
      {
        type: 'CODING_STARTED',
        subtaskId: 'direct-implementation',
        subtaskDescription: 'Direct model execution',
      },
    );
    assert.equal(core.calculateProgress([{ status: 'completed' }, { status: 'pending' }]), 50);
    assert.deepEqual(core.countSubtasksByStatus([{ status: 'completed' }, { status: 'failed' }]), {
      pending: 0,
      in_progress: 0,
      completed: 1,
      failed: 1,
    });
    assert.equal(core.isCompletedTask('human_review', 'completed'), true);
    assert.equal(core.wouldPhaseRegress('qa_review', 'coding'), true);
    assert.equal(core.isAllowedPhaseRegression('qa_review', 'coding'), true);
    assert.equal(core.isValidPhaseTransition('coding', 'qa_review', ['coding']), true);
    assert.equal(core.XSTATE_TO_PHASE.human_review, 'complete');
    assert.deepEqual(core.mapStateToLegacy('plan_review'), { status: 'human_review', reviewReason: 'plan_review' });

    assert.deepEqual(core.extractCommands('git status && npm test'), ['git', 'npm']);
    assert.equal(core.isCommandBlocked('sudo')[0], false);
    assert.equal(core.validateCommand('rm -rf /')[0], false);
    assert.equal(core.bashSecurityHook({
      toolName: 'Bash',
      toolInput: { command: 'echo safe' },
    }).hookSpecificOutput, undefined);
    assert.equal(core.bashSecurityHook({
      toolName: 'Bash',
      toolInput: { command: 'sudo whoami' },
    }).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(core.assertPathContained(join(projectRoot, 'src', 'main.tsx'), projectRoot).contained, true);
    assert.equal(core.isPathContained(join(projectRoot, '..', 'outside.txt'), projectRoot).contained, false);
    assert.equal(
      core.scanContent('const apiKey = "sk-ant-123456789012345678901234";', 'config.ts').length,
      1,
    );

    const coercedPlan = core.ImplementationPlanSchema.parse({
      title: 'Build profile settings',
      tasks: ['Add settings UI', 'Persist provider profiles'],
    });
    assert.equal(coercedPlan.feature, 'Build profile settings');
    assert.equal(coercedPlan.phases.length, 1);
    assert.equal(coercedPlan.phases[0].subtasks.length, 2);

    const qaSignoff = core.QASignoffSchema.parse({
      status: 'passed',
      issues: 'No blocking issues.',
    });
    assert.equal(qaSignoff.status, 'approved');
    assert.equal(qaSignoff.issues_found.length, 1);

    const languageErrors = core.validateImplementationPlanLanguage({
      feature: 'Build profile settings',
      phases: [{
        id: '1',
        name: 'Implementation',
        subtasks: [{
          id: '1-1',
          title: 'Add settings UI',
          description: 'Create React components for the provider settings panel.',
          status: 'pending',
        }],
      }],
    }, 'zh-CN');
    assert.ok(languageErrors.length > 0);
    assert.equal(core.getOutputSchemaForAgent('complexity_assessor'), core.ComplexityAssessmentOutputSchema);

    assert.equal(core.PROVIDER_ENV_VARS.openai, 'OPENAI_API_KEY');
    assert.equal(core.PROVIDER_SETTINGS_KEY.anthropic, 'globalAnthropicApiKey');
    assert.equal(core.PROVIDER_BASE_URL_ENV.azure, 'AZURE_OPENAI_ENDPOINT');
    assert.equal(core.toSupportedProvider('amazon-bedrock'), 'bedrock');
    assert.equal(core.detectProviderFromModel('claude-sonnet-4-5-20250929'), 'anthropic');
    assert.equal(core.detectProviderFromModel('gpt-5.4'), 'openai');
    assert.equal(core.detectProviderFromModel('deepseek-v4-flash'), 'deepseek');
    assert.equal(core.detectProviderFromModel('unknown-model'), undefined);
    assert.equal(core.isAnthropicOAuthToken('sk-ant-oa-test'), true);
    assert.equal(core.isAnthropicOAuthToken('sk-ant-api-test'), false);
    assert.equal(core.isOfficialAnthropicBaseUrl('https://api.anthropic.com'), true);
    assert.equal(core.isOfficialAnthropicBaseUrl('https://proxy.example.com'), false);
    assert.equal(core.normalizeAnthropicBaseUrl('https://proxy.example.com'), 'https://proxy.example.com/v1');
    assert.equal(core.isOfficialOpenAIBaseUrl('https://api.openai.com/v1'), true);
    assert.equal(core.isOfficialOpenAIBaseUrl('https://proxy.example.com'), false);
    assert.equal(core.normalizeOpenAICompatibleBaseUrl('https://proxy.example.com/api'), 'https://proxy.example.com/api/v1');
    assert.equal(core.normalizeOllamaBaseUrl('http://localhost:11434'), 'http://localhost:11434/v1');
    assert.equal(core.normalizeDeepSeekBaseUrl(undefined), core.DEFAULT_DEEPSEEK_BASE_URL);
    assert.equal(core.isCodexModel('gpt-5.3-codex'), true);
    assert.equal(core.isResponsesApiModel('gpt-5.4'), true);
    assert.equal(core.isResponsesApiModel('gpt-4o'), false);
    assert.equal(
      core.buildAlternateOpenAICompatibleUrl('https://proxy.example.com/v1/chat/completions'),
      'https://proxy.example.com/chat/completions',
    );
    assert.equal(
      core.shouldUseOpenAICompatibleChat({
        provider: 'openai',
        baseURL: 'https://proxy.example.com',
      }),
      true,
    );
    const anthropicPlan = core.buildProviderModelCreationPlan(
      { provider: 'anthropic', apiKey: 'sk-ant-oa-test' },
      'claude-sonnet-4-5-20250929',
    );
    assert.equal(anthropicPlan.instance.sdk, 'anthropic');
    assert.equal(anthropicPlan.instance.authToken, 'sk-ant-oa-test');
    assert.equal(anthropicPlan.invocation.method, 'call');
    assert.equal(anthropicPlan.invocation.supportsPromptCaching, true);

    const customOpenAIPlan = core.buildProviderModelCreationPlan(
      { provider: 'openai', apiKey: 'sk-openai', baseURL: 'https://proxy.example.com' },
      'gpt-5.4',
    );
    assert.equal(customOpenAIPlan.instance.sdk, 'openai-compatible');
    assert.equal(customOpenAIPlan.instance.fetchStrategy, 'openai-compatible-alternate');
    assert.equal(customOpenAIPlan.invocation.method, 'chatModel');

    const officialOpenAIPlan = core.buildProviderModelCreationPlan(
      { provider: 'openai', apiKey: 'sk-openai', baseURL: 'https://api.openai.com/v1' },
      'gpt-5.4',
    );
    assert.equal(officialOpenAIPlan.instance.sdk, 'openai');
    assert.equal(officialOpenAIPlan.invocation.method, 'responses');
    assert.equal(officialOpenAIPlan.invocation.supportsPromptCaching, true);

    const azurePlan = core.buildProviderModelCreationPlan(
      { provider: 'azure', apiKey: 'azure-key', deploymentName: 'prod-deployment' },
      'gpt-4o',
    );
    assert.equal(azurePlan.invocation.method, 'chat');
    assert.equal(azurePlan.invocation.modelId, 'prod-deployment');

    const ollamaPlan = core.buildProviderSdkInstancePlan({ provider: 'ollama' });
    assert.equal(ollamaPlan.sdk, 'openai-compatible');
    assert.equal(ollamaPlan.baseURL, 'http://localhost:11434/v1');

    assert.equal(core.isAdaptiveModel('claude-opus-4-6'), true);
    assert.deepEqual(core.getThinkingKwargsForModel('claude-opus-4-6', 'xhigh'), {
      maxThinkingTokens: 32768,
      effortLevel: 'xhigh',
    });
    assert.equal(
      core.transformThinkingConfig('deepseek', 'deepseek-v4-pro', 'xhigh').reasoningEffort,
      'max',
    );
    assert.equal(core.sanitizeThinkingLevel('xhigh'), 'xhigh');
    assert.equal(core.sanitizeThinkingLevel('ultrathink'), 'high');
    assert.equal(core.normalizeToolId('openai', 'a'.repeat(80)).length, 64);
    assert.equal(core.meetsCacheThreshold('anthropic', 'toolDefinitions', 1024), true);
    assert.deepEqual(core.getCacheBreakpoints('anthropic', [1000, 1100]), [1]);

    assert.deepEqual(core.BASE_READ_TOOLS, ['Read', 'Glob', 'Grep']);
    assert.equal(core.AGENT_CONFIGS.coder.tools.includes('Bash'), true);
    assert.equal(core.getDefaultThinkingLevel('direct_task'), 'xhigh');
    assert.equal(core.mapMcpServerName('GRAPHITI'), 'memory');
    assert.equal(
      core.getRequiredMcpServers('coder', { memoryEnabled: false }).includes('memory'),
      false,
    );
    assert.equal(
      core.getRequiredMcpServersFromConfig('qa_reviewer', {
        memoryEnabled: true,
        projectCapabilities: { is_electron: true },
        mcpConfig: { ELECTRON_MCP_ENABLED: 'true' },
      }).includes('electron'),
      true,
    );
    assert.equal(
      core.getRequiredMcpServersFromConfig('coder', {
        memoryEnabled: true,
        mcpConfig: { AGENT_MCP_coder_REMOVE: 'autocode,memory' },
      }).includes('memory'),
      false,
    );

    const dirtyToolInput = { file_path: 'src\\main.ts"}},' };
    core.sanitizeFilePathArg(dirtyToolInput);
    assert.equal(dirtyToolInput.file_path, 'src/main.ts');
    assert.equal(core.ToolPermission.ReadOnly, 'read_only');
    assert.equal(core.DEFAULT_EXECUTION_OPTIONS.timeoutMs, 120000);
    assert.equal(
      core.buildReadOnlyToolSignature(
        'Read',
        { file_path: join(projectRoot, 'src', 'main.tsx') },
        { projectDir: projectRoot },
      ),
      'Read:{"file_path":"src/main.tsx"}',
    );
    const usageContext = {
      projectDir: projectRoot,
      toolUsageState: core.createToolUsageState(),
      toolUsageLimits: { maxDuplicateReadOnlyCalls: 1 },
    };
    assert.equal(core.guardReadOnlyToolUsage('Read', { file_path: join(projectRoot, 'README.md') }, usageContext), null);
    assert.match(
      core.guardReadOnlyToolUsage('Read', { file_path: join(projectRoot, 'README.md') }, usageContext),
      /Repeated Read call skipped/,
    );
    assert.match(
      core.getToolWritePathDenial(
        'WriteLike',
        { file_path: join(projectRoot, 'outside.md') },
        [join(projectRoot, '.autocode', 'specs')],
      ),
      /Write denied: WriteLike/,
    );
    assert.equal(core.sanitizeToolOutputName('Tool.Name@v2'), 'Tool_Name_v2');
    const truncationPlan = core.planToolOutputTruncation('line\n'.repeat(2100), 'Glob');
    assert.equal(truncationPlan.wasTruncated, true);
    assert.equal(truncationPlan.displayedLineCount, core.TOOL_OUTPUT_MAX_LINES);
    assert.match(
      core.buildToolOutputTruncationContent(truncationPlan, { spilloverPath: 'out.txt' }),
      /Full output saved to: out\.txt/,
    );
    assert.match(
      core.buildToolOutputTruncationContent(truncationPlan, { spilloverWriteFailed: true }),
      /spillover write failed/,
    );
    assert.equal(core.normalizeReadPathInput('src\\main.ts'), 'src/main.ts');
    assert.equal(core.isImageFile('assets/logo.svg'), true);
    assert.equal(core.isPdfFile('docs/spec.pdf'), true);
    assert.equal(core.getDefaultReadLineLimit('aggressive'), core.AGGRESSIVE_READ_LINE_LIMIT);
    assert.deepEqual(
      core.getEffectiveReadLineLimit(core.LARGE_TEXT_FILE_BYTES + 1, 'balanced', false),
      { lineLimit: core.LARGE_TEXT_DEFAULT_LINE_LIMIT, isLargeFileDefault: true },
    );
    assert.match(core.buildLargeReadFileNote(600 * 1024, 200), /Large file: 600KB/);
    assert.match(core.formatReadContent('one\ntwo\nthree', 1, 1), /2\ttwo/);
    assert.match(core.formatReadContent('one\ntwo\nthree', 1, 1), /Showing lines 2-2 of 3/);
    assert.equal(core.decodeTextBuffer(Buffer.from('plain text')).content, 'plain text');
    assert.match(
      core.summarizeTaskLog('{"type":"tool_start","tool_name":"Read"}', 'task_logs.json'),
      /tool_start=1/,
    );
    assert.match(core.formatImageReadResult('icon.jpg', 'abc'), /data:image\/jpeg;base64,abc/);
    assert.match(core.formatPdfReadResult('spec.pdf', 2048), /size: 2KB/);
    assert.equal(core.normalizeFileMutationPathInput('src\\main.ts'), 'src/main.ts');
    assert.equal(core.countContentLines('one\r\ntwo\nthree'), 3);
    assert.equal(core.formatWriteSuccess('src/main.ts', 'one\ntwo'), 'Successfully wrote 2 lines to src/main.ts');
    assert.doesNotThrow(() => core.validateJsonWriteContent('package.json', '{"ok":true}'));
    assert.throws(
      () => core.validateJsonWriteContent('package.json', '{bad json'),
      /Invalid JSON content/,
    );
    assert.equal(
      core.getEditInputValidationError('same', 'same'),
      'Error: old_string and new_string are identical. No changes needed.',
    );
    assert.equal(core.countExactOccurrences('foo bar foo', 'foo'), 2);
    assert.deepEqual(
      core.buildEditPlan('hello world', 'src/main.ts', 'hello', 'goodbye', false),
      {
        ok: true,
        content: 'goodbye world',
        occurrenceCount: 1,
        message: 'Successfully edited src/main.ts',
      },
    );
    assert.match(
      core.buildEditPlan('foo foo', 'src/main.ts', 'foo', 'bar', false).error,
      /appears 2 times/,
    );
    assert.equal(core.clampBashTimeout(undefined), core.DEFAULT_BASH_TIMEOUT_MS);
    assert.equal(core.clampBashTimeout(9_000_000), core.MAX_BASH_TIMEOUT_MS);
    assert.match(core.truncateBashOutput('x'.repeat(core.BASH_MAX_OUTPUT_LENGTH + 1)), /Output truncated/);
    assert.equal(core.isCompilerCommand('clang++ -o app main.cpp'), true);
    assert.match(
      core.truncateCompilerOutput(`note\n${'error: bad\n'.repeat(1000)}`, 200),
      /Compiler output truncated/,
    );
    assert.match(
      core.detectFastCommandFailure('findstr /s /n "needle" src\\*.ts', { isWindows: true }),
      /Inefficient Windows search command/,
    );
    assert.equal(core.detectFastCommandFailure('grep needle src/index.ts', { isWindows: false }), null);
    assert.match(core.formatBashCommandDenied('blocked'), /Command not allowed - blocked/);
    assert.equal(core.formatBackgroundCommandStarted('sleep 1'), 'Command started in background: sleep 1');
    assert.equal(
      core.formatBashExecutionResult({ command: 'true', stdout: '', stderr: '', exitCode: 0 }),
      '(no output)',
    );
    assert.match(
      core.formatBashExecutionResult({ command: 'false', stdout: '', stderr: 'warn', exitCode: 1 }),
      /STDERR:\nwarn\nExit code: 1/,
    );
    assert.deepEqual(
      core.buildToolRegistrationPlan({ webSearchEnabled: false }).slice(0, 7),
      ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch'],
    );
    assert.equal(core.buildToolRegistrationPlan({ webSearchEnabled: false }).includes('WebSearch'), false);
    assert.equal(core.buildToolRegistrationPlan({ webSearchEnabled: true }).includes('WebSearch'), true);
    assert.ok(core.getAllowedToolNamesForAgent('coder').includes('Read'));
    assert.equal(
      core.selectRegisteredToolNamesForAgent('merge_resolver', ['Read', 'Write']).length,
      0,
    );
    assert.equal(
      core.selectRegisteredToolNamesForAgent(
        'mmo_spec_orchestrator',
        ['SpawnSubagent'],
        { hasSubagentExecutor: false },
      ).includes('SpawnSubagent'),
      false,
    );
    assert.equal(
      core.selectRegisteredToolNamesForAgent(
        'mmo_spec_orchestrator',
        ['SpawnSubagent'],
        { hasSubagentExecutor: true },
      ).includes('SpawnSubagent'),
      true,
    );
    assert.equal(core.shouldExcludeSearchPath('node_modules/pkg/index.ts'), true);
    assert.equal(core.shouldExcludeSearchPath('src/index.ts'), false);
    assert.match(
      core.summarizePathsByDirectory(
        [join(projectRoot, 'src', 'a.ts'), join(projectRoot, 'src', 'feature', 'b.ts')],
        projectRoot,
        2,
      ),
      /Glob matched 2 files/,
    );
    const rgArgs = core.buildRipgrepArgs(
      { pattern: 'hello', output_mode: 'content', context: 2, type: 'ts', glob: '*.ts' },
      join(projectRoot, 'src'),
    );
    assert.ok(rgArgs.includes('--line-number'));
    assert.ok(rgArgs.includes('-C'));
    assert.ok(rgArgs.includes('!**/node_modules/**'));
    assert.equal(core.matchesSearchType('src/App.tsx', 'ts'), true);
    assert.equal(core.isProbablyBinaryBuffer(Buffer.from([65, 0, 66])), true);
    assert.equal(
      core.formatGrepFallbackResults([{ file: 'a.ts', count: 2 }], 'count'),
      'a.ts:2',
    );
    assert.match(core.truncateSearchOutput('x'.repeat(core.GREP_MAX_OUTPUT_LENGTH + 1)), /Output truncated/);

    const envAuth = core.resolveProviderEnvironmentAuth(
      { provider: 'openai' },
      (key) => ({ OPENAI_API_KEY: 'sk-env-openai', OPENAI_BASE_URL: 'https://proxy.example.com' })[key],
    );
    assert.equal(envAuth.apiKey, 'sk-env-openai');
    assert.equal(envAuth.source, 'environment');
    assert.equal(envAuth.baseURL, 'https://proxy.example.com');

    const settingsAuth = core.resolveProviderSettingsAuth(
      { provider: 'anthropic' },
      (key) => (key === 'globalAnthropicApiKey' ? 'sk-settings-anthropic' : undefined),
      () => undefined,
    );
    assert.equal(settingsAuth.apiKey, 'sk-settings-anthropic');
    assert.equal(settingsAuth.source, 'profile-api-key');
    assert.equal(core.resolveDefaultProviderAuth({ provider: 'ollama' }).source, 'default');
    assert.equal(
      core.resolveApiKeyProviderAccountAuth({
        provider: 'zai',
        authType: 'api-key',
        billingModel: 'subscription',
        apiKey: 'zhipu-key',
      }).baseURL,
      core.ZAI_CODING_API,
    );

    const queueConfig = core.buildProviderAccountQueueConfig('sonnet', (key) => {
      if (key === 'providerAccounts') {
        return JSON.stringify([
          { id: 'b', provider: 'openai', authType: 'api-key', apiKey: 'sk-b' },
          { id: 'a', provider: 'anthropic', authType: 'api-key', apiKey: 'sk-a' },
        ]);
      }
      if (key === 'globalPriorityOrder') {
        return JSON.stringify(['a', 'b']);
      }
      return undefined;
    });
    assert.equal(queueConfig.queue[0].id, 'a');
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function createSmokeProcessAdapter(input = {}) {
  return {
    startProcess(options) {
      const result = spawnSync(options.command, options.args, {
        cwd: options.cwd,
        encoding: 'utf8',
        shell: options.shell,
        env: input.env ? { ...process.env, ...input.env } : process.env,
      });
      const exitCode = result.status ?? (result.error ? 1 : 0);
      return {
        status: exitCode === 0 ? 'completed' : 'failed',
        exitCode,
        signal: result.signal,
        message: [
          result.error?.message,
          result.stdout,
          result.stderr,
        ].filter(Boolean).join('\n') || undefined,
      };
    },
  };
}

function readPlanMachineMetadata(content) {
  const match = /^<!--\s*autocode-plan-meta:\s*(\{.*\})\s*-->\s*$/m.exec(content);
  assert.ok(match, 'Expected implementation_plan.md to include autocode-plan-meta.');
  return JSON.parse(match[1]);
}

function writeFakeCodexCli(projectRoot) {
  const fakeBinDir = join(projectRoot, 'fake-codex-bin');
  mkdirSync(fakeBinDir, { recursive: true });
  const fakeCliPath = join(fakeBinDir, 'fake-codex-cli.cjs');
  writeFileSync(fakeCliPath, `const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const prompt = readFileSync(0, 'utf8');
const specDir = readPromptField('Spec directory');

if (!specDir) {
  console.error('Missing Spec directory in prompt.');
  process.exit(2);
}

if (!process.argv.includes('--json')) {
  console.error('Expected Codex CLI to run with --json.');
  process.exit(3);
}

writeFileSync(
  join(specDir, 'implementation_plan.md'),
  [
    '# Implementation Plan',
    '',
    'Feature: Track Codex CLI usage',
    'Workflow: feature',
    'Status: planning',
    '',
    '- [ ] 1. Implementation',
    '',
    '  - [ ] 1.1 Persist Codex usage',
    '    - Verify usage events update plan metadata and task logs.',
    '    - _Files: libs/core/src/tasks/cli-runner.ts_',
    '    - _Verification: npm --workspace @autocode/core run smoke_',
    '',
  ].join('\\n'),
  'utf8',
);

emit({ type: 'agent_message', message: 'Fake Codex generated implementation plan.' });
emit({
  msg: {
    type: 'usage',
    usage: {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    },
  },
  sessionId: 'codex-session-1',
});
emit({
  type: 'response_completed',
  session_id: 'codex-session-1',
  response: {
    usage: {
      input_tokens: 123,
      output_tokens: 45,
      total_tokens: 168,
      reasoning_output_tokens: 12,
      cached_input_tokens: 7,
    },
  },
});

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\\n');
}

function readPromptField(label) {
  const prefix = label + ':';
  const line = prompt.split(/\\r?\\n/).find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : '';
}
`, 'utf8');

  const posixShimPath = join(fakeBinDir, 'codex');
  writeFileSync(posixShimPath, `#!/usr/bin/env sh
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec node "$SCRIPT_DIR/fake-codex-cli.cjs" "$@"
`, 'utf8');
  try {
    chmodSync(posixShimPath, 0o755);
  } catch {
    // Windows does not need executable bits for the .cmd shim below.
  }

  writeFileSync(
    join(fakeBinDir, 'codex.cmd'),
    '@echo off\r\nnode "%~dp0fake-codex-cli.cjs" %*\r\n',
    'utf8',
  );

  return fakeBinDir;
}

function writeFakeCustomCli(projectRoot) {
  const fakeCliPath = join(projectRoot, 'fake-autocode-cli.cjs');
  writeFileSync(fakeCliPath, `const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const prompt = readFileSync(0, 'utf8');
const specDir = readPromptField('Spec directory');
const taskId = readPromptField('Task ID');
const title = readPromptField('Task title') || taskId;

if (!specDir) {
  console.error('Missing Spec directory in prompt.');
  process.exit(2);
}

if (prompt.includes('Create the initial task specification artifacts')) {
  console.log('Fake custom CLI: generating spec artifacts.');
  writeFileSync(
    join(specDir, 'spec.md'),
    [
      '# Fake Custom CLI Spec',
      '',
      '## Overview',
      'Generated by the smoke-test fake custom CLI.',
      '',
    ].join('\\n'),
    'utf8',
  );
  writePlan('pending');
  process.exit(0);
}

if (prompt.includes('Create or repair the implementation plan')) {
  console.log('Fake custom CLI: generating implementation plan.');
  writePlan('pending');
  process.exit(0);
}

if (prompt.includes('Implement the task according to the existing spec and implementation plan')) {
  console.log('Fake custom CLI: completing implementation plan.');
  writePlan('completed');
  writeFileSync(
    join(specDir, 'direct_summary.md'),
    'Fake custom CLI completed the implementation.\\n',
    'utf8',
  );
  process.exit(0);
}

if (prompt.includes('Implement the requested task directly')) {
  console.log('Fake custom CLI: running direct implementation.');
  writeFileSync(
    join(specDir, 'direct_summary.md'),
    'Fake custom CLI completed the direct task.\\n',
    'utf8',
  );
  process.exit(0);
}

console.error('Unrecognized fake custom CLI prompt.');
process.exit(3);

function readPromptField(label) {
  const prefix = label + ':';
  const line = prompt.split(/\\r?\\n/).find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : '';
}

function writePlan(status) {
  const completed = status === 'completed';
  const marker = completed ? 'x' : ' ';
  const completion = completed ? '\\n    - _Completion: Fake custom CLI marked this subtask complete._' : '';
  writeFileSync(
    join(specDir, 'implementation_plan.md'),
    [
      '# Implementation Plan',
      '',
      'Feature: ' + title,
      'Description: Fake custom CLI lifecycle task.',
      'Workflow: feature',
      'Status: ' + (completed ? 'coding' : 'planning'),
      'Created: 2026-01-01T00:00:00.000Z',
      'Updated: 2026-01-01T00:00:00.000Z',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [' + marker + '] 1.1 Complete fake lifecycle',
      '    - Prove the runner can pass a prompt to a custom CLI and validate returned artifacts.',
      '    - _Files: src/fake-flow.ts_',
      '    - _Requirements: 1.1_' + completion,
      '',
    ].join('\\n'),
    'utf8',
  );
}
`, 'utf8');
  return fakeCliPath;
}

function writeRetryingPlanCli(projectRoot) {
  const fakeCliPath = join(projectRoot, 'fake-retrying-plan-cli.cjs');
  writeFileSync(fakeCliPath, `const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const prompt = readFileSync(0, 'utf8');
const specDir = readPromptField('Spec directory');

if (!specDir) {
  console.error('Missing Spec directory in prompt.');
  process.exit(2);
}

if (!prompt.includes('Create or repair the implementation plan')) {
  console.error('Unexpected retry smoke prompt.');
  process.exit(3);
}

if (!prompt.includes('Retry Required')) {
  console.log('Retry smoke CLI: writing invalid top-level-only plan.');
  writeFileSync(
    join(specDir, 'implementation_plan.md'),
    [
      '# Implementation Plan',
      '',
      'Feature: Retry missing subtasks',
      'Workflow: feature',
      'Status: pending',
      '',
      '- [ ] 1. Implementation',
      '',
    ].join('\\n'),
    'utf8',
  );
  process.exit(0);
}

console.log('Retry smoke CLI: repairing plan with executable subtask.');
writeFileSync(
  join(specDir, 'implementation_plan.md'),
  [
    '# Implementation Plan',
    '',
    'Feature: Retry missing subtasks',
    'Workflow: feature',
    'Status: pending',
    '',
    '- [ ] 1. Implementation',
    '',
    '  - [ ] 1.1 Repair plan on retry',
    '    - Replace the invalid top-level-only plan with an executable subtask.',
    '    - _Files to modify: implementation_plan.md_',
    '    - _Verification: npm --workspace @autocode/core run smoke_',
    '',
  ].join('\\n'),
  'utf8',
);
process.exit(0);

function readPromptField(label) {
  const prefix = label + ':';
  const line = prompt.split(/\\r?\\n/).find((item) => item.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : '';
}
`, 'utf8');
  return fakeCliPath;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
