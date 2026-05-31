const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, join } = require('node:path');
const iconvLite = require('iconv-lite');

function normalizePath(value) {
  return value.replace(/\\/g, '/');
}

function makeChineseMojibake(value) {
  return iconvLite.decode(Buffer.from(value, 'utf8'), 'gbk');
}

async function main() {
  const core = await import('../dist/index.js');
  const projectRoot = mkdtempSync(join(tmpdir(), 'autocode-core-smoke-'));

  try {
    const dependencyAnalysis = core.analyzeAutocodeWorkDependencies([
      { id: '1', status: 'pending', dependsOn: [] },
      { id: '2', status: 'pending', dependsOn: ['1'] },
      { id: '3', status: 'pending', dependsOn: ['missing'] },
      { id: '4', status: 'pending', dependsOn: ['5'] },
      { id: '5', status: 'pending', dependsOn: ['4'] },
    ]);
    assert.deepEqual(dependencyAnalysis.runnable.map((item) => item.id), ['1']);
    assert.ok(dependencyAnalysis.issues.some((issue) => issue.type === 'missing' && issue.itemId === '3'));
    assert.ok(dependencyAnalysis.issues.some((issue) => issue.type === 'cycle' && issue.cycle.includes('4')));
    assert.match(core.describeAutocodeWorkDependencyBlockers(dependencyAnalysis.blocked), /dependency cycle/);
    const duplicateDependencyAnalysis = core.analyzeAutocodeWorkDependencies([
      { id: 'dup', status: 'pending', dependsOn: [] },
      { id: 'dup', status: 'pending', dependsOn: [] },
    ]);
    assert.equal(duplicateDependencyAnalysis.runnable.length, 0);
    assert.ok(duplicateDependencyAnalysis.issues.every((issue) => issue.type === 'duplicate'));

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
    const sessionSpecDir = join(projectRoot, '.autocode', 'specs', 'session-memory-task');
    mkdirSync(sessionSpecDir, { recursive: true });
    core.recordAutocodeSessionDiscoveryInFile({
      specDir: sessionSpecDir,
      filePath: 'src/App.tsx',
      description: 'Main application component',
      category: 'ui',
      now: new Date('2026-01-02T03:05:00.000Z'),
    });
    core.recordAutocodeSessionDiscoveryInFile({
      specDir: sessionSpecDir,
      filePath: 'src/api.ts',
      description: 'API client helpers',
      category: 'api',
      now: new Date('2026-01-02T03:06:00.000Z'),
    });
    const persistedCodebaseMap = core.loadAutocodeSessionCodebaseMapSync(sessionSpecDir);
    assert.equal(persistedCodebaseMap.discovered_files['src/App.tsx'].category, 'ui');
    assert.equal(persistedCodebaseMap.discovered_files['src/api.ts'].description, 'API client helpers');
    assert.equal(persistedCodebaseMap.last_updated, '2026-01-02T03:06:00.000Z');
    const firstGotcha = core.appendAutocodeSessionGotcha({
      specDir: sessionSpecDir,
      gotcha: 'Keep writes atomic.',
      context: 'concurrency',
      now: new Date('2026-01-02T03:07:00.000Z'),
    });
    const secondGotcha = core.appendAutocodeSessionGotcha({
      specDir: sessionSpecDir,
      gotcha: 'Reuse core lock helpers.',
      now: new Date('2026-01-02T03:08:00.000Z'),
    });
    assert.equal(firstGotcha.isNew, true);
    assert.equal(secondGotcha.isNew, false);
    const persistedGotchas = readFileSync(core.getAutocodeSessionGotchasPath(sessionSpecDir), 'utf8');
    assert.match(persistedGotchas, /# Gotchas & Pitfalls/);
    assert.match(persistedGotchas, /Keep writes atomic\./);
    assert.match(persistedGotchas, /Reuse core lock helpers\./);
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
    const taskMetadata = JSON.parse(readFileSync(join(task.specsPath, 'task_metadata.json'), 'utf8'));
    assert.equal(taskMetadata.taskTitle, 'Add provider settings');
    const titleRewritePlan = core.loadAutocodeImplementationPlanSync(task.specsPath);
    titleRewritePlan.feature = 'Agent regenerated implementation feature';
    core.saveAutocodeImplementationPlanSync(task.specsPath, titleRewritePlan);
    const stableListedTask = core.listAutocodeTasks({ projectRoot, dataDirName: '.autocode' })
      .find((candidate) => candidate.id === task.id);
    assert.equal(stableListedTask.title, 'Add provider settings');
    const stableProjectTask = core.loadAutocodeProjectTasks({ projectRoot, dataDirName: '.autocode' })
      .find((candidate) => candidate.id === task.id);
    assert.equal(stableProjectTask.title, 'Add provider settings');

    const raceSpecDir = join(projectRoot, '.autocode-plan-race', 'specs', 'plan-update-race');
    mkdirSync(raceSpecDir, { recursive: true });
    core.saveAutocodeImplementationPlanSync(raceSpecDir, {
      feature: 'Plan update race',
      phases: [
        {
          id: '1',
          name: 'Implementation',
          subtasks: [
            { id: '1.1', title: 'First concurrent update', description: 'First concurrent update', status: 'pending' },
            { id: '1.2', title: 'Second concurrent update', description: 'Second concurrent update', status: 'pending' },
          ],
        },
      ],
    });
    await Promise.all([
      core.updateAutocodeImplementationPlan(raceSpecDir, async (plan) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        core.updateAutocodePlanSubtask(plan, '1.1', {
          status: 'completed',
          completionSummary: 'first done',
          now: '2026-01-02T03:04:01.000Z',
        });
      }),
      core.updateAutocodeImplementationPlan(raceSpecDir, (plan) => {
        core.updateAutocodePlanSubtask(plan, '1.2', {
          status: 'completed',
          completionSummary: 'second done',
          now: '2026-01-02T03:04:02.000Z',
        });
      }),
    ]);
    const racePlan = core.loadAutocodeImplementationPlanSync(raceSpecDir);
    assert.equal(racePlan.phases[0].subtasks[0].status, 'completed');
    assert.equal(racePlan.phases[0].subtasks[1].status, 'completed');

    const noneMetadataPlan = core.parseAutocodeImplementationPlanMarkdown([
      '# Implementation Plan',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Inspect without edits',
      '    - _Files to modify: none_',
      '    - _Depends on: none_',
      '    - _Verification: manual check_',
      '',
    ].join('\n'));
    const noneMetadataSubtask = noneMetadataPlan.phases[0].subtasks[0];
    assert.deepEqual(noneMetadataSubtask.files_to_modify, []);
    assert.deepEqual(noneMetadataSubtask.depends_on, []);
    assert.equal(Object.prototype.hasOwnProperty.call(noneMetadataSubtask, 'files_to_modify'), true);
    assert.equal(Object.prototype.hasOwnProperty.call(noneMetadataSubtask, 'depends_on'), true);
    const noneMetadataMarkdown = core.stringifyAutocodeImplementationPlanMarkdown(noneMetadataPlan);
    assert.match(noneMetadataMarkdown, /_Files to modify: none_/);
    assert.match(noneMetadataMarkdown, /_Depends on: none_/);
    assert.deepEqual(core.normalizeAutocodeWorkDependencyIds(['none', '无依赖', '1.1']), ['1.1']);

    const openSpecChangeDir = join(projectRoot, 'openspec', 'changes', 'share-runtime');
    mkdirSync(join(openSpecChangeDir, 'specs', 'agent-runtime'), { recursive: true });
    writeFileSync(join(openSpecChangeDir, 'proposal.md'), '# Share Runtime\n\nBridge upstream specs to downstream execution.\n');
    writeFileSync(join(openSpecChangeDir, 'design.md'), '# Runtime Bridge Design\n\nOpenSpec owns specs; Autocode owns execution.\n');
    writeFileSync(
      join(openSpecChangeDir, 'tasks.md'),
      [
        '# Tasks',
        '',
        '- [ ] 1. Connect OpenSpec source',
        '  - _Files: libs/core/src/openspec/index.ts_',
        '  - _Depends on: none_',
        '- [ ] 2. Expose runtime import',
        '  - _Depends on: 1_',
        '  - _Verification: npm run build_',
        '- [ ] 3. Reuse compact context',
        '  - _Files: libs/core/src/runtime/agent-messages.ts_',
        '  - _Depends on: none_',
        '- [ ] 4. Sync OpenSpec parent status',
        '  - [ ] 4.1 Complete parent from merged runtime package',
        '    - _Files: libs/core/src/openspec/index.ts_',
        '    - _Depends on: none_',
        '  - [ ] 4.2 Keep compact context available',
        '    - _Files: libs/core/src/tasks/cli-runner.ts_',
        '    - _Depends on: none_',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(openSpecChangeDir, 'specs', 'agent-runtime', 'spec.md'),
      '## MODIFIED Requirements\n\n### Requirement: Runtime bridge\nAutocode SHALL execute OpenSpec changes downstream.\n',
    );
    assert.deepEqual(core.listOpenSpecChanges(projectRoot), ['share-runtime']);
    const openSpecTaskResult = core.createAutocodeTaskFromOpenSpecChange({
      projectRoot,
      dataDirName: '.autocode-openspec',
      changeId: 'share-runtime',
      now: '2026-01-02T03:04:00.000Z',
    });
    assert.equal(openSpecTaskResult.task.metadata.sourceType, 'openspec');
    assert.equal(openSpecTaskResult.task.metadata.openSpecChangeId, 'share-runtime');
    assert.equal(openSpecTaskResult.task.subtasks.length, 4);
    assert.ok(openSpecTaskResult.task.subtasks.every((subtask) => subtask.workPackage === true));
    assert.deepEqual(openSpecTaskResult.task.subtasks.flatMap((subtask) => subtask.upstreamTaskIds), ['1', '2', '3', '4.1', '4.2']);
    assert.equal(core.normalizeOpenSpecChangeId('001-build-game'), 'change-001-build-game');
    assert.equal(core.normalizeOpenSpecChangeId('Build game'), 'build-game');
    const openSpecTaskSpec = readFileSync(join(openSpecTaskResult.task.specsPath, 'spec.md'), 'utf8');
    assert.ok(openSpecTaskSpec.includes('downstream Autocode execution handoff'));
    assert.ok(openSpecTaskSpec.includes('openspec/changes/share-runtime/tasks.md'));
    assert.ok(existsSync(join(openSpecTaskResult.task.specsPath, 'openspec_context.md')));
    const openSpecRuntimePlan = core.loadAutocodeImplementationPlanSync(openSpecTaskResult.task.specsPath);
    assert.equal(openSpecRuntimePlan.source_task.kind, 'openspec-change');
    assert.equal(openSpecRuntimePlan.source_task.runtime_granularity, 'work_package');
    assert.equal(openSpecRuntimePlan.source_task.ownership.upstream, 'openspec');
    assert.equal(openSpecRuntimePlan.phases[0].subtasks[0].id, 'wp-1');
    assert.equal(openSpecRuntimePlan.phases[0].subtasks[1].id, 'wp-2');
    assert.equal(openSpecRuntimePlan.phases[0].subtasks[2].id, 'wp-3');
    assert.equal(openSpecRuntimePlan.phases[0].subtasks[3].id, 'wp-4');
    assert.deepEqual(openSpecRuntimePlan.phases[0].subtasks[0].upstream_task_ids, ['1', '2']);
    assert.deepEqual(openSpecRuntimePlan.phases[0].subtasks[1].upstream_task_ids, ['3']);
    assert.deepEqual(openSpecRuntimePlan.phases[0].subtasks[2].upstream_task_ids, ['4.1']);
    assert.deepEqual(openSpecRuntimePlan.phases[0].subtasks[3].upstream_task_ids, ['4.2']);
    assert.deepEqual(openSpecRuntimePlan.phases[0].subtasks.flatMap((subtask) => subtask.upstream_task_ids), ['1', '2', '3', '4.1', '4.2']);
    assert.equal(
      core.createAutocodeTaskRunPlan({
        projectRoot,
        dataDirName: '.autocode-openspec',
        taskId: openSpecTaskResult.task.id,
        cli: 'custom',
        customCommand: 'node fake-agent.js',
      }).phase,
      'coding',
    );
    for (const phase of openSpecRuntimePlan.phases) {
      for (const subtask of phase.subtasks ?? []) {
        if (subtask.id === 'wp-1' || subtask.id === 'wp-2' || subtask.id === 'wp-3' || subtask.id === 'wp-4') {
          subtask.status = 'completed';
        }
      }
    }
    core.saveAutocodeImplementationPlanSync(openSpecTaskResult.task.specsPath, openSpecRuntimePlan);
    const openSpecSyncResult = core.syncOpenSpecTasksFromAutocodePlan({
      specDir: openSpecTaskResult.task.specsPath,
      projectRoot,
    });
    assert.equal(openSpecSyncResult.changed, true);
    const syncedOpenSpecTasks = readFileSync(join(openSpecChangeDir, 'tasks.md'), 'utf8');
    assert.match(syncedOpenSpecTasks, /- \[x\] 1\. Connect OpenSpec source/);
    assert.match(syncedOpenSpecTasks, /- \[x\] 2\. Expose runtime import/);
    assert.match(syncedOpenSpecTasks, /- \[x\] 3\. Reuse compact context/);
    assert.match(syncedOpenSpecTasks, /- \[x\] 4\. Sync OpenSpec parent status/);
    assert.match(syncedOpenSpecTasks, /- \[x\] 4\.1 Complete parent from merged runtime package/);
    assert.match(syncedOpenSpecTasks, /- \[x\] 4\.2 Keep compact context available/);

    const dependencyPackageChangeDir = join(projectRoot, 'openspec', 'changes', 'dependency-graph-packages');
    mkdirSync(join(dependencyPackageChangeDir, 'specs', 'runtime'), { recursive: true });
    writeFileSync(join(dependencyPackageChangeDir, 'proposal.md'), '# Dependency Graph Packages\n');
    writeFileSync(join(dependencyPackageChangeDir, 'design.md'), '# Design\n\nUse task dependencies to create runtime work packages.\n');
    writeFileSync(
      join(dependencyPackageChangeDir, 'tasks.md'),
      [
        '# Tasks',
        '',
        '- [ ] 1. UI foundation',
        '  - [ ] 1.1 Create board markup',
        '    - _Depends on: none_',
        '  - [ ] 1.2 Wire board state',
        '    - _Depends on: 1.1_',
        '  - [ ] 1.3 Add keyboard controls',
        '    - _Depends on: 1.2_',
        '- [ ] 2. Scoring',
        '  - [ ] 2.1 Add score state',
        '    - _Depends on: none_',
        '  - [ ] 2.2 Render score panel',
        '    - _Depends on: 2.1_',
        '- [ ] 3. Verification',
        '  - [ ] 3.1 Add browser smoke test',
        '    - _Depends on: 1.3, 2.2_',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dependencyPackageChangeDir, 'specs', 'runtime', 'spec.md'),
      '## ADDED Requirements\n\n### Requirement: Dependency graph packages\nWork packages SHALL follow OpenSpec task dependencies.\n\n#### Scenario: Package dependent tasks\n- **WHEN** tasks declare dependencies\n- **THEN** runtime packages keep dependent chains together and use package dependencies across phases\n',
    );
    const dependencyPackageTask = core.createAutocodeTaskFromOpenSpecChange({
      projectRoot,
      dataDirName: '.autocode-openspec-dependencies',
      changeId: 'dependency-graph-packages',
      now: '2026-01-02T03:04:10.000Z',
    });
    const dependencyPackagePlan = core.loadAutocodeImplementationPlanSync(dependencyPackageTask.task.specsPath);
    assert.deepEqual(
      dependencyPackagePlan.phases[0].subtasks.map((subtask) => subtask.upstream_task_ids),
      [['1.1', '1.2', '1.3'], ['2.1', '2.2'], ['3.1']],
    );
    assert.deepEqual(dependencyPackagePlan.phases[0].subtasks[2].depends_on, ['wp-1', 'wp-2']);

    const balancedLinearPlan = core.buildAutocodeRuntimeImplementationPlanFromTasksMarkdown(
      [
        '# Tasks',
        '',
        '- [ ] 1. Linear chain',
        '  - [ ] 1.1 Step 1',
        '    - _Depends on: none_',
        '  - [ ] 1.2 Step 2',
        '    - _Depends on: 1.1_',
        '  - [ ] 1.3 Step 3',
        '    - _Depends on: 1.2_',
        '  - [ ] 1.4 Step 4',
        '    - _Depends on: 1.3_',
        '  - [ ] 1.5 Step 5',
        '    - _Depends on: 1.4_',
        '  - [ ] 1.6 Step 6',
        '    - _Depends on: 1.5_',
        '',
      ].join('\n'),
      { now: '2026-01-02T03:04:12.000Z', sourcePath: 'tasks.md' },
    );
    assert.deepEqual(
      balancedLinearPlan.phases[0].subtasks.map((subtask) => subtask.upstream_task_ids),
      [['1.1', '1.2', '1.3'], ['1.4', '1.5', '1.6']],
    );
    assert.deepEqual(balancedLinearPlan.phases[0].subtasks[1].depends_on, ['wp-1']);

    const fanOutPackageChangeDir = join(projectRoot, 'openspec', 'changes', 'fan-out-work-packages');
    mkdirSync(join(fanOutPackageChangeDir, 'specs', 'runtime'), { recursive: true });
    writeFileSync(join(fanOutPackageChangeDir, 'proposal.md'), '# Fan Out Work Packages\n');
    writeFileSync(join(fanOutPackageChangeDir, 'design.md'), '# Design\n\nExpose parallel branches in runtime work packages.\n');
    writeFileSync(
      join(fanOutPackageChangeDir, 'tasks.md'),
      [
        '# Tasks',
        '',
        '- [ ] 1. Runtime DAG',
        '  - [ ] 1.1 Create shared runtime contract',
        '    - _Depends on: none_',
        '  - [ ] 1.2 Implement UI adapter',
        '    - _Depends on: 1.1_',
        '  - [ ] 1.3 Implement CLI adapter',
        '    - _Depends on: 1.1_',
        '  - [ ] 1.4 Implement VS Code adapter',
        '    - _Depends on: 1.1_',
        '  - [ ] 1.5 Add shared integration test',
        '    - _Depends on: 1.2, 1.3, 1.4_',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(fanOutPackageChangeDir, 'specs', 'runtime', 'spec.md'),
      '## ADDED Requirements\n\n### Requirement: Fan-out work packages\nRuntime planning SHALL preserve independent task branches as concurrent work packages.\n\n#### Scenario: Branching task graph\n- **WHEN** multiple tasks depend on the same prerequisite\n- **THEN** runtime packages expose those tasks as independent runnable packages\n',
    );
    const fanOutPackageTask = core.createAutocodeTaskFromOpenSpecChange({
      projectRoot,
      dataDirName: '.autocode-openspec-fan-out-packages',
      changeId: 'fan-out-work-packages',
      now: '2026-01-02T03:04:15.000Z',
    });
    const fanOutPackagePlan = core.loadAutocodeImplementationPlanSync(fanOutPackageTask.task.specsPath);
    assert.deepEqual(
      fanOutPackagePlan.phases[0].subtasks.map((subtask) => subtask.upstream_task_ids),
      [['1.1'], ['1.2'], ['1.3'], ['1.4'], ['1.5']],
    );
    assert.deepEqual(fanOutPackagePlan.phases[0].subtasks[1].depends_on, ['wp-1']);
    assert.deepEqual(fanOutPackagePlan.phases[0].subtasks[2].depends_on, ['wp-1']);
    assert.deepEqual(fanOutPackagePlan.phases[0].subtasks[3].depends_on, ['wp-1']);
    assert.deepEqual(fanOutPackagePlan.phases[0].subtasks[4].depends_on, ['wp-2', 'wp-3', 'wp-4']);

    const inferredDependencyChangeDir = join(projectRoot, 'openspec', 'changes', 'infer-missing-task-dependencies');
    mkdirSync(join(inferredDependencyChangeDir, 'specs', 'runtime'), { recursive: true });
    writeFileSync(join(inferredDependencyChangeDir, 'proposal.md'), '# Infer Missing Dependencies\n');
    writeFileSync(join(inferredDependencyChangeDir, 'design.md'), '# Design\n\nInfer a conservative DAG when tasks omit dependencies.\n');
    writeFileSync(
      join(inferredDependencyChangeDir, 'tasks.md'),
      [
        '# Tasks',
        '',
        '- [ ] 1. Implementation',
        '  - [ ] 1.1 Create model',
        '  - [ ] 1.2 Render view',
        '- [ ] 2. Verification',
        '  - [ ] 2.1 Add smoke test',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(inferredDependencyChangeDir, 'specs', 'runtime', 'spec.md'),
      '## ADDED Requirements\n\n### Requirement: Inferred dependencies\nRuntime planning SHALL infer missing OpenSpec task dependencies conservatively.\n\n#### Scenario: Missing task metadata\n- **WHEN** tasks omit Depends on metadata\n- **THEN** the runtime plan is not fully parallelized\n',
    );
    const inferredDependencyTask = core.createAutocodeTaskFromOpenSpecChange({
      projectRoot,
      dataDirName: '.autocode-openspec-inferred-dependencies',
      changeId: 'infer-missing-task-dependencies',
      now: '2026-01-02T03:04:20.000Z',
    });
    const inferredDependencyPlan = core.loadAutocodeImplementationPlanSync(inferredDependencyTask.task.specsPath);
    assert.deepEqual(
      inferredDependencyPlan.phases[0].subtasks.map((subtask) => subtask.upstream_task_ids),
      [['1.1', '1.2'], ['2.1']],
    );
    assert.deepEqual(inferredDependencyPlan.phases[0].subtasks[1].depends_on, ['wp-1']);

    const fakeOpenSpecCliCalls = [];
    const fakeOpenSpecProtocolCalls = [];
    const fakeOpenSpecCli = {
      createChange(input) {
        fakeOpenSpecCliCalls.push(input);
        const changeDir = join(input.projectRoot, 'openspec', 'changes', input.changeId);
        mkdirSync(changeDir, { recursive: true });
        writeFileSync(join(changeDir, '.openspec.yaml'), `schema: ${input.schema || 'spec-driven'}\n`);
        writeFileSync(join(changeDir, 'README.md'), `${input.description}\n`);
        return {
          command: 'openspec',
          args: [
            'new',
            'change',
            '--description',
            input.description,
            '--schema',
            input.schema || 'spec-driven',
            input.changeId,
          ],
          cwd: input.projectRoot,
          status: 0,
          stdout: 'Created change',
          stderr: '',
        };
      },
      getStatus(input) {
        fakeOpenSpecProtocolCalls.push({ command: 'status', changeId: input.changeId });
        return {
          command: 'openspec',
          args: ['status', '--change', input.changeId, '--json'],
          cwd: input.projectRoot,
          status: 0,
          stdout: '',
          stderr: '',
          data: {
            changeName: input.changeId,
            schemaName: input.schema || 'spec-driven',
            isComplete: true,
            applyRequires: ['proposal', 'design', 'specs', 'tasks'],
            artifacts: [
              { id: 'proposal', outputPath: 'proposal.md', status: 'done' },
              { id: 'design', outputPath: 'design.md', status: 'done' },
              { id: 'specs', outputPath: 'specs/feature/spec.md', status: 'done' },
              { id: 'tasks', outputPath: 'tasks.md', status: 'done' },
            ],
          },
        };
      },
      getInstructions(input) {
        fakeOpenSpecProtocolCalls.push({
          command: 'instructions',
          changeId: input.changeId,
          artifactId: input.artifactId,
        });
        const templates = {
          proposal: '## Why\n\n## What Changes\n\n## Capabilities\n\n## Impact\n',
          design: '## Context\n\n## Goals / Non-Goals\n\n## Decisions\n\n## Risks / Trade-offs\n',
          specs: '## ADDED Requirements\n\n### Requirement: <name>\n\n#### Scenario: <scenario>\n- **WHEN** ...\n- **THEN** ...\n',
          tasks: '- [ ] 1. Task group\n  - [ ] 1.1 Concrete task\n',
        };
        return {
          command: 'openspec',
          args: ['instructions', input.artifactId, '--change', input.changeId, '--json'],
          cwd: input.projectRoot,
          status: 0,
          stdout: '',
          stderr: '',
          data: {
            artifactId: input.artifactId,
            outputPath: input.artifactId === 'specs' ? 'specs/feature/spec.md' : `${input.artifactId}.md`,
            instruction: `Create or revise ${input.artifactId} through the OpenSpec instructions interface.`,
            template: templates[input.artifactId] || '',
            rules: ['Use OpenSpec schema rules.'],
            dependencies: [],
          },
        };
      },
    };

    const manualStandardTask = core.createManualAutocodeTask({
      projectRoot,
      dataDirName: '.autocode-manual-standard',
      title: 'Add standard default task',
      description: 'Create normal UI tasks with the lightweight Autocode workflow by default.',
      metadata: {
        category: 'feature',
      },
      now: '2026-01-02T03:03:30.000Z',
      openSpecCli: fakeOpenSpecCli,
    });
    assert.equal(fakeOpenSpecCliCalls.length, 0);
    assert.equal(manualStandardTask.metadata.sourceType, 'manual');
    assert.equal(manualStandardTask.metadata.developmentMode, 'standard');
    assert.equal(manualStandardTask.metadata.workflowMode, 'balanced');
    assert.deepEqual(manualStandardTask.metadata.runtimeConcurrency, {
      mode: 'concurrent',
      workers: 2,
      unit: 'work_item',
      conflictPolicy: 'lock-and-queue',
    });
    assert.ok(existsSync(join(manualStandardTask.specsPath, 'spec.md')));

    const manualFastTask = core.createManualAutocodeTask({
      projectRoot,
      dataDirName: '.autocode-manual-fast',
      title: 'Add fast task',
      description: 'Implement a small change directly.',
      metadata: {
        developmentMode: 'fast',
      },
      now: '2026-01-02T03:03:45.000Z',
    });
    assert.equal(manualFastTask.metadata.sourceType, 'manual');
    assert.equal(manualFastTask.metadata.developmentMode, 'fast');
    assert.equal(manualFastTask.metadata.workflowMode, 'off');
    assert.deepEqual(manualFastTask.metadata.runtimeConcurrency, {
      mode: 'serial',
      workers: 1,
      unit: 'work_item',
      conflictPolicy: 'lock-and-queue',
    });
    assert.equal(
      core.createAutocodeTaskRunPlan({
        projectRoot,
        dataDirName: '.autocode-manual-fast',
        taskId: manualFastTask.id,
        cli: 'custom',
        customCommand: 'node fake-agent.js',
      }).phase,
      'direct',
    );

    const deferredSpecTask = core.createManualAutocodeTask({
      projectRoot,
      dataDirName: '.autocode-manual-spec-deferred',
      title: 'Add deferred spec task',
      description: 'Generate OpenSpec artifacts when planning starts.',
      metadata: {
        developmentMode: 'spec',
      },
      now: '2026-01-02T03:03:50.000Z',
      openSpecCli: fakeOpenSpecCli,
    });
    assert.equal(fakeOpenSpecCliCalls.length, 0);
    assert.equal(deferredSpecTask.metadata.sourceType, 'openspec');
    assert.equal(deferredSpecTask.metadata.developmentMode, 'spec');
    assert.equal(deferredSpecTask.metadata.openSpecGenerationMode, 'deferred');
    assert.deepEqual(deferredSpecTask.metadata.runtimeConcurrency, {
      mode: 'concurrent',
      workers: 5,
      unit: 'work_item',
      conflictPolicy: 'lock-and-queue',
    });
    assert.equal(
      core.createAutocodeTaskRunPlan({
        projectRoot,
        dataDirName: '.autocode-manual-spec-deferred',
        taskId: deferredSpecTask.id,
        cli: 'custom',
        customCommand: 'node fake-agent.js',
      }).phase,
      'planning',
    );

    const manualOpenSpecTask = core.createAutocodeTaskFromOpenSpecDraft({
      projectRoot,
      dataDirName: '.autocode-manual-openspec',
      title: 'Add OpenSpec default task',
      description: 'Create spec-mode UI tasks through OpenSpec upstream documents.',
      metadata: {
        developmentMode: 'spec',
        category: 'feature',
        acceptanceCriteria: ['OpenSpec files are created before Autocode execution starts.'],
      },
      now: '2026-01-02T03:04:00.000Z',
      openSpecCli: fakeOpenSpecCli,
    }).task;
    assert.equal(fakeOpenSpecCliCalls.length, 1);
    assert.equal(fakeOpenSpecCliCalls[0].changeId, 'add-openspec-default-task');
    assert.equal(fakeOpenSpecCliCalls[0].schema, undefined);
    assert.equal(manualOpenSpecTask.metadata.sourceType, 'openspec');
    assert.ok(manualOpenSpecTask.metadata.openSpecScaffoldCommand.includes('openspec new change'));
    assert.equal(manualOpenSpecTask.subtasks.length, 1);
    assert.ok(core.listOpenSpecChanges(projectRoot).includes('add-openspec-default-task'));
    assert.ok(existsSync(join(projectRoot, 'openspec', 'changes', 'add-openspec-default-task', '.openspec.yaml')));
    assert.ok(existsSync(join(projectRoot, 'openspec', 'changes', 'add-openspec-default-task', 'proposal.md')));
    assert.ok(existsSync(join(projectRoot, 'openspec', 'changes', 'add-openspec-default-task', 'design.md')));
    assert.ok(existsSync(join(projectRoot, 'openspec', 'changes', 'add-openspec-default-task', 'tasks.md')));
    assert.ok(existsSync(join(projectRoot, 'openspec', 'changes', 'add-openspec-default-task', 'specs', 'feature', 'spec.md')));

    const chineseOpenSpecTask = core.createAutocodeTaskFromOpenSpecDraft({
      projectRoot,
      dataDirName: '.autocode-zh-openspec',
      title: '生成中文 OpenSpec 文档',
      description: '为中文界面创建任务时，OpenSpec 提案、设计和任务文档应使用简体中文。',
      metadata: {
        category: 'feature',
        language: 'zh-CN',
        acceptanceCriteria: ['OpenSpec 文档正文使用简体中文。'],
      },
      now: '2026-01-02T03:04:30.000Z',
      openSpecCli: false,
    }).task;
    const chineseProposal = readFileSync(join(projectRoot, chineseOpenSpecTask.metadata.openSpecProposalPath), 'utf8');
    const chineseDesign = readFileSync(join(projectRoot, chineseOpenSpecTask.metadata.openSpecDesignPath), 'utf8');
    const chineseTasks = readFileSync(join(projectRoot, chineseOpenSpecTask.metadata.openSpecTasksPath), 'utf8');
    const chineseSpecDelta = readFileSync(join(projectRoot, chineseOpenSpecTask.metadata.openSpecSpecDeltaPaths[0]), 'utf8');
    assert.match(chineseProposal, /## 背景/);
    assert.match(chineseProposal, /## 变更内容/);
    assert.doesNotMatch(chineseProposal, /## Why|## What Changes/);
    assert.match(chineseDesign, /## 上下文/);
    assert.match(chineseDesign, /## 决策/);
    assert.doesNotMatch(chineseDesign, /## Context|## Decisions/);
    assert.match(chineseTasks, /# 任务/);
    assert.match(chineseTasks, /_验证：/);
    assert.doesNotMatch(chineseTasks, /Implement the OpenSpec change|_Verification|_Created/);
    assert.match(chineseSpecDelta, /## ADDED Requirements/);
    assert.match(chineseSpecDelta, /用户执行相关流程/);

    assert.equal(
      core.createAutocodeTaskRunPlan({
        projectRoot,
        dataDirName: '.autocode-manual-openspec',
        taskId: manualOpenSpecTask.id,
        cli: 'custom',
        customCommand: 'node fake-agent.js',
      }).phase,
      'coding',
    );

    const generatedArtifactCalls = [];
    const generatedOpenSpecTask = await core.createManualAutocodeTaskWithOpenSpecArtifacts({
      projectRoot,
      dataDirName: '.autocode-generated-openspec',
      title: 'Generate rich OpenSpec documents',
      description: 'Use the OpenSpec workflow instructions to produce proposal, design, specs, and tasks before creating the downstream Autocode runtime task.',
      metadata: {
        category: 'feature',
      },
      now: '2026-01-02T03:05:00.000Z',
      openSpecCli: fakeOpenSpecCli,
      validateOpenSpec: false,
      openSpecArtifactGenerator: {
        async generateArtifact(input) {
          generatedArtifactCalls.push(input.artifactId);
          if (input.artifactId === 'proposal') {
            return [
              '## Why',
              'Task creation should produce real upstream OpenSpec artifacts.',
              '',
              '## What Changes',
              'Generate proposal, design, spec deltas, and tasks from OpenSpec instructions before Autocode runtime files are created.',
              '',
              '## Capabilities',
              '',
              '### New Capabilities',
              '- `feature`: OpenSpec-backed task creation.',
              '',
              '### Modified Capabilities',
              '- None',
              '',
              '## Impact',
              '- Desktop task creation receives richer upstream documents.',
            ].join('\n');
          }
          if (input.artifactId === 'design') {
            if (generatedArtifactCalls.filter((artifactId) => artifactId === 'design').length === 1) {
              return [
                '## Context',
                'This first draft intentionally misses required sections so retry repair is exercised.',
              ].join('\n');
            }
            return [
              '## Context',
              'OpenSpec owns durable specification artifacts while Autocode owns runtime execution state.',
              '',
              '## Goals / Non-Goals',
              '**Goals:**',
              '- Generate complete upstream artifacts before creating the downstream task.',
              '',
              '**Non-Goals:**',
              '- Store transient runtime logs in OpenSpec.',
              '',
              '## Decisions',
              '- Keep the artifact generator behind a core adapter contract.',
              '',
              '## Risks / Trade-offs',
              '- Bad model output must fail validation instead of creating vague tasks.',
            ].join('\n');
          }
          if (input.artifactId === 'specs') {
            return [
              '## ADDED Requirements',
              '',
              '### Requirement: OpenSpec artifact generation',
              'Task creation SHALL generate upstream OpenSpec documents before creating downstream Autocode runtime state.',
              '',
              '#### Scenario: Create task through generated OpenSpec artifacts',
              '- **WHEN** a user creates a task',
              '- **THEN** proposal, design, spec delta, and tasks artifacts are generated first',
            ].join('\n');
          }
          return [
            '- [ ] 1. Generate upstream artifacts',
            '  - [ ] 1.1 Create proposal, design, and spec delta documents',
            '    - _Files: libs/core/src/openspec/index.ts_',
            '  - [ ] 1.2 Create executable OpenSpec task list',
            '    - _Files: libs/core/src/openspec/index.ts_',
          ].join('\n');
        },
      },
    });
    assert.deepEqual(generatedArtifactCalls, ['proposal', 'design', 'design', 'specs', 'tasks']);
    assert.equal(generatedOpenSpecTask.metadata.openSpecGenerationMode, 'ai');
    assert.equal(generatedOpenSpecTask.subtasks.length, 1);
    assert.equal(generatedOpenSpecTask.subtasks[0].workPackage, true);
    assert.match(
      readFileSync(join(projectRoot, 'openspec', 'changes', 'generate-rich-openspec-documents', 'tasks.md'), 'utf8'),
      /1\.2 Create executable OpenSpec task list/,
    );
    assert.match(
      readFileSync(join(projectRoot, 'openspec', 'changes', 'generate-rich-openspec-documents', 'tasks.md'), 'utf8'),
      /_Depends on: 1\.1_/,
    );

    const normalizedOpenSpecTask = await core.createManualAutocodeTaskWithOpenSpecArtifacts({
      projectRoot,
      dataDirName: '.autocode-normalized-openspec-artifacts',
      title: 'Normalize OpenSpec artifacts',
      description: 'Normalize model-generated OpenSpec tasks and Chinese requirement bodies before runtime planning.',
      metadata: {
        category: 'feature',
        language: 'zh-CN',
      },
      now: '2026-01-02T03:05:20.000Z',
      openSpecCli: fakeOpenSpecCli,
      validateOpenSpec: false,
      openSpecArtifactGenerator: {
        async generateArtifact(input) {
          if (input.artifactId === 'proposal') {
            return '## 背景\n需要规范化模型输出。\n\n## 变更内容\n修复 OpenSpec 文档格式。\n\n## 能力范围\n- `project`: 文档规范化。\n\n## 影响\n- runtime plan 不再误读依赖。';
          }
          if (input.artifactId === 'design') {
            return '## 上下文\n模型可能输出重复或裸露的 Depends on 行。\n\n## 目标 / 非目标\n**目标：**\n- 规范化 tasks 和 specs。\n\n**非目标：**\n- 改变 OpenSpec 结构。\n\n## 决策\n- core 在写入前清洗生成内容。\n\n## 风险 / 权衡\n- 不依赖单个模型格式。';
          }
          if (input.artifactId === 'specs') {
            return '## ADDED Requirements\n\n### Requirement: 中文需求正文\n系统必须在中文需求正文中满足 OpenSpec 校验。\n\n#### Scenario: 生成中文规格\n- **WHEN** 模型输出中文 requirement 正文\n- **THEN** core 写入前补齐 OpenSpec 需要的 SHALL 或 MUST';
          }
          return [
            '- [ ] 1. 文档规范化',
            '  - [ ] 1.1 规范化任务依赖元数据',
            '    - _Depends on: none_',
            '    _Depends on: none_',
            '    文件提示：检查 tasks.md。',
            '  - [ ] 1.2 生成 runtime plan',
            '    _Depends on: 1.1_',
            '    文件提示：检查 implementation_plan.md。',
          ].join('\n');
        },
      },
    });
    const normalizedTasksMarkdown = readFileSync(
      join(projectRoot, 'openspec', 'changes', 'normalize-openspec-artifacts', 'tasks.md'),
      'utf8',
    );
    assert.equal((normalizedTasksMarkdown.match(/_Depends on:/g) ?? []).length, 2);
    assert.doesNotMatch(normalizedTasksMarkdown, /^\s*_Depends on:/m);
    const normalizedSpecMarkdown = readFileSync(
      join(projectRoot, 'openspec', 'changes', 'normalize-openspec-artifacts', 'specs', 'feature', 'spec.md'),
      'utf8',
    );
    assert.match(normalizedSpecMarkdown, /\bSHALL\b/);
    const normalizedRuntimePlan = core.loadAutocodeImplementationPlanSync(normalizedOpenSpecTask.specsPath);
    const normalizedRuntimePlanMarkdown = readFileSync(join(normalizedOpenSpecTask.specsPath, 'implementation_plan.md'), 'utf8');
    assert.ok(
      normalizedRuntimePlan.phases
        .flatMap((phase) => phase.subtasks)
        .every((subtask) => (subtask.depends_on ?? []).every((dependency) => /^wp-\d+$/.test(dependency))),
    );
    assert.doesNotMatch(normalizedRuntimePlanMarkdown, /Depends on: none_.*文件提示/);

    const chineseGeneratedInputs = [];
    await core.createManualAutocodeTaskWithOpenSpecArtifacts({
      projectRoot,
      dataDirName: '.autocode-generated-zh-openspec',
      title: 'AI 生成中文 OpenSpec 文档',
      description: '中文界面下，AI 生成的 OpenSpec 文档应优先使用简体中文。',
      metadata: {
        category: 'feature',
        language: 'zh-CN',
      },
      now: '2026-01-02T03:05:30.000Z',
      openSpecCli: fakeOpenSpecCli,
      validateOpenSpec: false,
      openSpecArtifactGenerator: {
        async generateArtifact(input) {
          chineseGeneratedInputs.push(input);
          if (input.artifactId === 'proposal') {
            return '## 背景\n需要中文文档。\n\n## 变更内容\n生成中文 OpenSpec 文档。\n\n## 能力范围\n- `feature`: 中文文档。\n\n## 影响\n- 用户阅读更顺畅。';
          }
          if (input.artifactId === 'design') {
            return '## 上下文\n当前模板可能包含英文。\n\n## 目标 / 非目标\n**目标：**\n- 输出中文。\n\n**非目标：**\n- 改变 OpenSpec 结构关键字。\n\n## 决策\n- 将语言规则传入生成器。\n\n## 风险 / 权衡\n- spec delta 保留必要关键字。';
          }
          if (input.artifactId === 'specs') {
            return '## ADDED Requirements\n\n### Requirement: 中文 OpenSpec 文档\nOpenSpec 文档正文 SHALL 使用简体中文。\n\n#### Scenario: 创建中文任务\n- **WHEN** 用户使用中文界面创建任务\n- **THEN** OpenSpec 文档正文使用简体中文';
          }
          return '- [ ] 1. 生成中文文档\n  - [ ] 1.1 写入中文 proposal、design、spec 和 tasks\n    - _Depends on: none_\n    - _验证：检查文档没有英文模板标题_';
        },
      },
    });
    assert.ok(chineseGeneratedInputs.every((input) => input.language === 'zh-CN'));
    assert.ok(chineseGeneratedInputs.every((input) => JSON.stringify(input.instructions.rules ?? []).includes('简体中文')));

    const openSpecCliCallsBeforeDeferred = fakeOpenSpecCliCalls.length;
    const deferredOpenSpecTask = core.createManualAutocodeTaskWithDeferredOpenSpecArtifacts({
      projectRoot,
      dataDirName: '.autocode-deferred-openspec',
      title: 'Defer rich OpenSpec documents',
      description: 'Create the Desktop task quickly, then generate proposal, design, spec deltas, and tasks when the task starts planning.',
      metadata: {
        category: 'feature',
      },
      now: '2026-01-02T03:06:00.000Z',
    });
    assert.equal(fakeOpenSpecCliCalls.length, openSpecCliCallsBeforeDeferred);
    assert.equal(deferredOpenSpecTask.metadata.sourceType, 'openspec');
    assert.equal(deferredOpenSpecTask.metadata.openSpecGenerationMode, 'deferred');
    const deferredOpenSpecChangeId = deferredOpenSpecTask.metadata.openSpecChangeId;
    assert.match(deferredOpenSpecChangeId, /^[a-z]/);
    assert.equal(deferredOpenSpecChangeId, `change-${deferredOpenSpecTask.id}`);
    assert.equal(deferredOpenSpecTask.subtasks.length, 0);
    assert.ok(readFileSync(join(deferredOpenSpecTask.specsPath, 'spec.md'), 'utf8').includes('Planning Startup'));
    assert.ok(!existsSync(join(projectRoot, 'openspec', 'changes', deferredOpenSpecChangeId, 'tasks.md')));
    assert.equal(
      core.createAutocodeTaskRunPlan({
        projectRoot,
        dataDirName: '.autocode-deferred-openspec',
        taskId: deferredOpenSpecTask.id,
        cli: 'custom',
        customCommand: 'node fake-agent.js',
      }).phase,
      'planning',
    );

    const deferredArtifactCalls = [];
    const ensuredDeferredOpenSpecTask = await core.ensureOpenSpecArtifactsForAutocodeTask({
      projectRoot,
      dataDirName: '.autocode-deferred-openspec',
      taskId: deferredOpenSpecTask.id,
      now: '2026-01-02T03:07:00.000Z',
      openSpecCli: fakeOpenSpecCli,
      validateOpenSpec: false,
      artifactGenerator: {
        async generateArtifact(input) {
          deferredArtifactCalls.push(input.artifactId);
          if (input.artifactId === 'proposal') {
            return [
              '## Why',
              'Desktop task creation should stay responsive while still using OpenSpec as upstream truth.',
              '',
              '## What Changes',
              'Generate OpenSpec proposal, design, spec delta, and tasks when the task starts planning.',
              '',
              '## Capabilities',
              '',
              '### New Capabilities',
              '- `feature`: Deferred OpenSpec generation.',
              '',
              '### Modified Capabilities',
              '- None',
              '',
              '## Impact',
              '- Task creation returns quickly and planning owns upstream artifact generation.',
            ].join('\n');
          }
          if (input.artifactId === 'design') {
            return [
              '## Context',
              'OpenSpec generation can be slow because it asks the model for multiple upstream documents.',
              '',
              '## Goals / Non-Goals',
              '**Goals:**',
              '- Generate artifacts during task planning startup.',
              '',
              '**Non-Goals:**',
              '- Generate implementation code while creating the task.',
              '',
              '## Decisions',
              '- Store a deferred marker in task metadata and complete artifacts when execution starts.',
              '',
              '## Risks / Trade-offs',
              '- Planning startup now owns generation failures and must surface them in task logs.',
            ].join('\n');
          }
          if (input.artifactId === 'specs') {
            return [
              '## ADDED Requirements',
              '',
              '### Requirement: Deferred OpenSpec generation',
              'Desktop task creation SHALL create a lightweight task and defer rich OpenSpec artifact generation until task planning starts.',
              '',
              '#### Scenario: Start a deferred OpenSpec task',
              '- **WHEN** the user starts the task',
              '- **THEN** proposal, design, spec delta, and tasks artifacts are generated before downstream execution continues',
            ].join('\n');
          }
          return [
            '- [ ] 1. Generate deferred OpenSpec artifacts',
            '  - [ ] 1.1 Create proposal, design, and spec delta documents',
            '    - _Files: libs/core/src/openspec/index.ts_',
            '    - _Depends on: none_',
            '  - [ ] 1.2 Create the downstream runtime plan from OpenSpec tasks',
            '    - _Files: libs/core/src/tasks/workspace-state.ts_',
            '    - _Depends on: 1.1_',
          ].join('\n');
        },
      },
    });
    assert.deepEqual(deferredArtifactCalls, ['proposal', 'design', 'specs', 'tasks']);
    assert.equal(ensuredDeferredOpenSpecTask.generated, true);
    assert.equal(ensuredDeferredOpenSpecTask.task.metadata.openSpecGenerationMode, 'ai');
    assert.equal(ensuredDeferredOpenSpecTask.task.metadata.openSpecChangeId, deferredOpenSpecChangeId);
    assert.equal(ensuredDeferredOpenSpecTask.task.subtasks.length, 1);
    assert.equal(ensuredDeferredOpenSpecTask.task.subtasks[0].workPackage, true);
    assert.ok(existsSync(join(ensuredDeferredOpenSpecTask.task.specsPath, 'openspec_context.md')));
    assert.ok(existsSync(join(projectRoot, 'openspec', 'changes', deferredOpenSpecChangeId, 'tasks.md')));

    const reviewHumanInput = [
      '# Human Input',
      '',
      'The user reviewed the generated plan/specification and requested planning changes.',
      '',
      '## Requested Changes',
      '',
      'Add an audit trail requirement to the OpenSpec upstream documents.',
      '',
      '## Instructions',
      '',
      '- Update OpenSpec artifacts before regenerating the downstream implementation plan.',
      '',
    ].join('\n');
    writeFileSync(join(ensuredDeferredOpenSpecTask.task.specsPath, 'HUMAN_INPUT.md'), reviewHumanInput);
    const reviewArtifactCalls = [];
    const reviewProtocolCallStart = fakeOpenSpecProtocolCalls.length;
    const reviewedOpenSpecTask = await core.ensureOpenSpecArtifactsForAutocodeTask({
      projectRoot,
      dataDirName: '.autocode-deferred-openspec',
      taskId: deferredOpenSpecTask.id,
      overwrite: true,
      now: '2026-01-02T03:08:00.000Z',
      openSpecCli: fakeOpenSpecCli,
      validateOpenSpec: false,
      artifactGenerator: {
        async generateArtifact(input) {
          reviewArtifactCalls.push({
            artifactId: input.artifactId,
            feedback: input.requirements.plan_review_feedback,
            description: input.description,
          });
          if (input.artifactId === 'proposal') {
            return [
              '## Why',
              'Desktop task planning must preserve reviewer feedback in upstream OpenSpec documents.',
              '',
              '## What Changes',
              'Add an audit trail requirement to the OpenSpec upstream documents.',
              '',
              '## Capabilities',
              '',
              '### New Capabilities',
              '- `feature`: Review-driven OpenSpec updates.',
              '',
              '### Modified Capabilities',
              '- None',
              '',
              '## Impact',
              '- Downstream plans are regenerated from updated OpenSpec artifacts.',
            ].join('\n');
          }
          if (input.artifactId === 'design') {
            return [
              '## Context',
              'Plan review feedback is upstream specification feedback.',
              '',
              '## Goals / Non-Goals',
              '**Goals:**',
              '- Update OpenSpec proposal, design, specs, and tasks before downstream planning.',
              '',
              '**Non-Goals:**',
              '- Treat implementation_plan.md as the source of truth.',
              '',
              '## Decisions',
              '- Carry review feedback into OpenSpec artifact generation.',
              '',
              '## Risks / Trade-offs',
              '- Regeneration must preserve useful existing OpenSpec details.',
            ].join('\n');
          }
          if (input.artifactId === 'specs') {
            return [
              '## ADDED Requirements',
              '',
              '### Requirement: Review feedback audit trail',
              'Plan review feedback SHALL update upstream OpenSpec documents before downstream Autocode plans are regenerated.',
              '',
              '#### Scenario: Request planning changes',
              '- **WHEN** a reviewer requests planning changes',
              '- **THEN** OpenSpec artifacts include the requested audit trail requirement before implementation_plan.md is updated',
            ].join('\n');
          }
          return [
            '- [ ] 1. Apply review feedback upstream',
            '  - [ ] 1.1 Update OpenSpec proposal, design, spec delta, and tasks with the audit trail requirement',
            '    - _Files: libs/core/src/openspec/index.ts_',
            '    - _Depends on: none_',
            '  - [ ] 1.2 Regenerate downstream runtime plan after OpenSpec is updated',
            '    - _Files: libs/core/src/tasks/cli-runner.ts_',
            '    - _Depends on: 1.1_',
          ].join('\n');
        },
      },
    });
    assert.deepEqual(reviewArtifactCalls.map((call) => call.artifactId), ['proposal', 'design', 'specs', 'tasks']);
    assert.deepEqual(
      fakeOpenSpecProtocolCalls
        .slice(reviewProtocolCallStart)
        .filter((call) => call.changeId === deferredOpenSpecChangeId)
        .map((call) => call.command === 'instructions' ? `${call.command}:${call.artifactId}` : call.command),
      ['status', 'instructions:proposal', 'instructions:design', 'instructions:specs', 'instructions:tasks'],
    );
    assert.ok(reviewArtifactCalls.every((call) => call.feedback.includes('audit trail requirement')));
    assert.ok(reviewArtifactCalls.every((call) => call.description.includes('audit trail requirement')));
    assert.equal(reviewedOpenSpecTask.generated, true);
    assert.equal(reviewedOpenSpecTask.task.metadata.openSpecReviewFeedback, 'Add an audit trail requirement to the OpenSpec upstream documents.');
    assert.match(
      readFileSync(join(projectRoot, 'openspec', 'changes', deferredOpenSpecChangeId, 'tasks.md'), 'utf8'),
      /audit trail requirement/,
    );
    assert.equal(
      core.createAutocodeTaskRunPlan({
        projectRoot,
        dataDirName: '.autocode-deferred-openspec',
        taskId: deferredOpenSpecTask.id,
        cli: 'custom',
        customCommand: 'node fake-agent.js',
      }).phase,
      'coding',
    );

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
          { id: '3', status: 'blocked', started_at: 'now' },
          { id: '4', status: 'completed' },
        ],
      }],
    };
    const resetResult = core.resetAutocodeStuckSubtasksInPlan(resetPlan);
    assert.equal(resetResult.resetCount, 3);
    assert.equal(core.countAutocodePlanSubtasks(resetPlan.phases), 4);
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
    assert.deepEqual(core.resolveAutocodeTaskRuntimeConcurrency({ workflowMode: 'balanced' }), {
      mode: 'concurrent',
      workers: 2,
      unit: 'work_item',
      conflictPolicy: 'lock-and-queue',
    });
    assert.deepEqual(core.resolveAutocodeTaskRuntimeConcurrency({
      developmentMode: 'standard',
      workflowMode: 'balanced',
      runtimeConcurrency: { mode: 'serial', workers: 1 },
    }), {
      mode: 'concurrent',
      workers: 2,
      unit: 'work_item',
      conflictPolicy: 'lock-and-queue',
    });
    assert.deepEqual(core.resolveAutocodeTaskRuntimeConcurrency({
      developmentMode: 'spec',
      sourceType: 'openspec',
      runtimeConcurrency: { mode: 'serial', workers: 1 },
    }), {
      mode: 'concurrent',
      workers: 5,
      unit: 'work_item',
      conflictPolicy: 'lock-and-queue',
    });
    assert.deepEqual(core.resolveAutocodeTaskRuntimeConcurrency({
      developmentMode: 'fast',
      workflowMode: 'off',
      runtimeConcurrency: { mode: 'concurrent', workers: 5 },
    }), {
      mode: 'serial',
      workers: 1,
      unit: 'work_item',
      conflictPolicy: 'lock-and-queue',
    });
    const claimManager = new core.AutocodeRuntimeWorkspaceClaimManager();
    const firstDirectClaim = claimManager.tryClaim({
      taskId: 'task-a',
      projectRoot,
      workspaceRoot: projectRoot,
      mode: 'direct',
      fileIntents: ['src/main.tsx'],
      now: '2026-01-02T03:09:00.000Z',
    });
    assert.equal(firstDirectClaim.ok, true);
    assert.equal(claimManager.tryClaim({
      taskId: 'task-b',
      projectRoot,
      workspaceRoot: projectRoot,
      mode: 'direct',
      fileIntents: ['src/other.tsx'],
      now: '2026-01-02T03:09:01.000Z',
    }).ok, true);
    const overlappingDirectClaim = claimManager.tryClaim({
      taskId: 'task-c',
      projectRoot,
      workspaceRoot: projectRoot,
      mode: 'direct',
      fileIntents: ['src/main.tsx'],
      now: '2026-01-02T03:09:02.000Z',
    });
    assert.equal(overlappingDirectClaim.ok, false);
    assert.equal(overlappingDirectClaim.conflict.reason, 'overlapping_files');
    const unknownDirectClaim = claimManager.tryClaim({
      taskId: 'task-d',
      projectRoot,
      workspaceRoot: projectRoot,
      mode: 'direct',
      now: '2026-01-02T03:09:03.000Z',
    });
    assert.equal(unknownDirectClaim.ok, false);
    assert.equal(unknownDirectClaim.conflict.reason, 'unknown_direct_files');
    assert.equal(claimManager.tryClaim({
      taskId: 'task-e',
      projectRoot: join(projectRoot, 'other-project'),
      workspaceRoot: join(projectRoot, 'other-project'),
      mode: 'direct',
      now: '2026-01-02T03:09:04.000Z',
    }).ok, true);
    assert.equal(claimManager.tryClaim({
      taskId: 'task-f',
      projectRoot,
      workspaceRoot: join(projectRoot, '.autocode', 'worktrees', 'tasks', 'task-f'),
      mode: 'worktree',
      now: '2026-01-02T03:09:05.000Z',
    }).ok, true);
    assert.deepEqual(core.collectAutocodeRuntimeFileIntentsFromPlan({
      phases: [{
        subtasks: [{
          files_to_modify: ['src/main.tsx'],
          files_to_create: ['src/new.tsx'],
          pattern_files: ['docs/**/*.md'],
        }],
      }],
    }), ['docs/**/*.md', 'src/main.tsx', 'src/new.tsx']);
    const wildcardClaimManager = new core.AutocodeRuntimeWorkspaceClaimManager();
    assert.equal(wildcardClaimManager.tryClaim({
      taskId: 'wildcard-a',
      projectRoot,
      workspaceRoot: projectRoot,
      mode: 'direct',
      fileIntents: ['src/**/*.ts'],
    }).ok, true);
    const wildcardConflict = wildcardClaimManager.tryClaim({
      taskId: 'wildcard-b',
      projectRoot,
      workspaceRoot: projectRoot,
      mode: 'direct',
      fileIntents: ['src/app.ts'],
    });
    assert.equal(wildcardConflict.ok, false);
    assert.equal(wildcardConflict.conflict.reason, 'overlapping_files');
    const writeLock = await core.acquireAutocodeRuntimeFileWriteLock({
      projectRoot,
      filePath: join(projectRoot, 'src', 'main.tsx'),
      ownerId: 'smoke-lock-a',
      timeoutMs: 20,
      retryMs: 1,
      now: '2026-01-02T03:09:06.000Z',
    });
    assert.equal(JSON.parse(readFileSync(join(writeLock.lockDir, 'metadata.json'), 'utf8')).processId, process.pid);
    await assert.rejects(
      () => core.acquireAutocodeRuntimeFileWriteLock({
        projectRoot,
        filePath: join(projectRoot, 'src', 'main.tsx'),
        ownerId: 'smoke-lock-b',
        timeoutMs: 5,
        retryMs: 1,
      }),
      /already held by this process/,
    );
    assert.equal(core.releaseAutocodeRuntimeFileWriteLock(writeLock), true);
    const reacquiredWriteLock = await core.acquireAutocodeRuntimeFileWriteLock({
      projectRoot,
      filePath: join(projectRoot, 'src', 'main.tsx'),
      ownerId: 'smoke-lock-c',
      timeoutMs: 20,
      retryMs: 1,
    });
    assert.equal(core.releaseAutocodeRuntimeFileWriteLock(reacquiredWriteLock), true);
    const syncWriteLock = core.acquireAutocodeRuntimeFileWriteLockSync({
      projectRoot,
      filePath: join(projectRoot, 'src', 'sync-lock.ts'),
      ownerId: 'smoke-sync-lock-a',
      timeoutMs: 20,
      retryMs: 1,
    });
    assert.throws(
      () => core.acquireAutocodeRuntimeFileWriteLockSync({
        projectRoot,
        filePath: join(projectRoot, 'src', 'sync-lock.ts'),
        ownerId: 'smoke-sync-lock-b',
        timeoutMs: 5,
        retryMs: 1,
      }),
      /already held by this process/,
    );
    assert.equal(core.releaseAutocodeRuntimeFileWriteLock(syncWriteLock), true);
    assert.deepEqual(core.inferAutocodeRuntimeFileWriteLockScopeFromSpecDir(
      join(projectRoot, '.autocode', 'specs', '001-task'),
    ), {
      projectRoot,
      dataDirName: '.autocode',
    });
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
    assert.ok(runnerScript.includes('repairChineseMojibakeText'));
    assert.ok(runnerScript.includes('emitPhase(executionPhase, startMessage, 0)'));
    assert.ok(runnerScript.includes("upsertPlanMetadata(content, 'Execution Phase'"));
    assert.ok(runnerScript.includes('upsertPlanMachineMetadata(content'));
    assert.ok(runnerScript.includes("xstateState: phaseValue"));
    assert.ok(runnerScript.includes('const activeFileWriteLockDirs = new Set()'));
    assert.ok(runnerScript.includes('processId: process.pid'));
    assert.ok(runnerScript.includes('is already held by this process'));

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
    assert.match(codingRunPlan.prompt, /runner owns status updates/);
    assert.doesNotMatch(codingRunPlan.prompt, /Mark only the current work item/);
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
    assert.equal(fakeSpecResult.status, 'completed', JSON.stringify(fakeSpecResult));
    assert.equal(JSON.parse(readFileSync(join(fakeFlowTask.specsPath, 'autocode-run-result.json'), 'utf8')).phase, 'spec');
    assert.ok(readFileSync(join(fakeFlowTask.specsPath, 'spec.md'), 'utf8').includes('Fake Custom CLI Spec'));
    const fakePlannedTask = core.listAutocodeTasks({ projectRoot, dataDirName: '.autocode' })
      .find((candidate) => candidate.id === fakeFlowTask.id);
    assert.equal(fakePlannedTask.status, 'human_review');
    assert.equal(fakePlannedTask.reviewReason, 'plan_review');
    assert.equal(fakePlannedTask.executionPhase, 'planning');
    assert.equal(fakePlannedTask.subtasks.length, 1);
    assert.deepEqual(fakePlannedTask.subtasks.map((subtask) => subtask.status), ['pending']);

    const fakeCodingRuntime = core.createStartedAutocodeAgentRuntime({
      projectRoot,
      dataDirName: '.autocode',
      taskId: fakeFlowTask.id,
      cli: 'custom',
      customCommand: fakeCustomCliCommand,
    });
    assert.equal(fakeCodingRuntime.runtimePlan.mode, 'coding');
    assert.equal(fakeCodingRuntime.taskRunPlan.phase, 'coding');
    const fakeCodingRunnerScript = readFileSync(fakeCodingRuntime.taskRunPlan.runnerFilePath, 'utf8');
    assert.ok(fakeCodingRunnerScript.includes('const runtimeConcurrency ='));
    assert.ok(fakeCodingRunnerScript.includes('startCodingWorkQueue()'));
    assert.ok(fakeCodingRunnerScript.includes('activeCodingAttempts'));
    assert.ok(fakeCodingRunnerScript.includes('conflictsWithActiveCodingWork'));
    assert.ok(fakeCodingRunnerScript.includes('patternFiles'));
    assert.ok(fakeCodingRunnerScript.includes('workItemPathsOverlap'));
    assert.ok(fakeCodingRunnerScript.includes('Do not edit implementation_plan.md or OpenSpec tasks.md status checkboxes'));
    assert.equal(fakeCodingRunnerScript.includes('When done, mark only work package'), false);
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
    assert.deepEqual(fakeImplementedTask.subtasks.map((subtask) => subtask.status), ['completed']);
    const fakeCliCalls = readFileSync(join(fakeFlowTask.specsPath, 'fake-cli-calls.log'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      fakeCliCalls
        .filter((call) => call.mode === 'coding')
        .map((call) => call.currentSubtaskId),
      ['wp-1'],
    );
    const fakeLogs = core.readAutocodeTaskLogs({
      projectRoot,
      dataDirName: '.autocode',
      taskId: fakeFlowTask.id,
    });
    assert.equal(fakeLogs.phases.planning.status, 'completed');
    assert.equal(fakeLogs.phases.coding.status, 'completed');
    const fakeLogText = [
      ...fakeLogs.phases.planning.entries,
      ...fakeLogs.phases.coding.entries,
    ].map((entry) => entry.content).join('\n');
    assert.ok(
      [
        ...fakeLogs.phases.planning.entries,
        ...fakeLogs.phases.coding.entries,
      ].some((entry) => entry.type === 'text' && entry.content.includes('Fake custom CLI')),
    );
    assert.ok(fakeLogText.includes('当前子任务：wp-1'));
    assert.equal(fakeLogText.includes(makeChineseMojibake('当前子任务：wp-1')), false);

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
    assert.equal(retryPlannedTask.subtasks[0].title, 'Work package: Repair plan on retry');
    const retryLogs = core.readAutocodeTaskLogs({
      projectRoot,
      dataDirName: '.autocode',
      taskId: retryTask.id,
    });
    assert.ok(
      retryLogs.phases.planning.entries.some((entry) =>
        entry.content.includes('CLI finished without creating tasks.md') &&
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
    assert.match(
      core.createToolOutputSpilloverFileName('Tool.Name@v2', new Date('2026-01-02T03:04:00.000Z')),
      /^Tool_Name_v2-20260102T030400000Z-[a-f0-9-]{8}\.txt$/,
    );
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
    const chineseLogText = '当前子任务：1.1 实现一个网页版的俄罗斯方块游戏';
    const mojibakeChineseLogText = makeChineseMojibake(chineseLogText);
    assert.equal(core.repairAutocodeChineseMojibakeText(mojibakeChineseLogText), chineseLogText);
    assert.equal(core.decodeAutocodeCliOutputChunk(Buffer.from(mojibakeChineseLogText, 'utf8')), chineseLogText);
    assert.equal(core.decodeAutocodeCliOutputChunk(iconvLite.encode(chineseLogText, 'gbk')), chineseLogText);
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
    assert.deepEqual(
      core.extractBashWriteFileTargets('echo hi > src/out.txt && printf ok >> "logs/app.log" 2>nul'),
      ['logs/app.log', 'src/out.txt'],
    );
    assert.deepEqual(
      core.extractBashWriteFileTargets('printf ok | tee -a build/output.log | cat'),
      ['build/output.log'],
    );
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
  join(specDir, 'tasks.md'),
  [
    '# Tasks',
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
    '    - _Depends on: none_',
    '    - _Verification: npm --workspace @autocode/core run smoke_',
    '',
  ].join('\\n'),
  'utf8',
);

emit({ type: 'agent_message', message: 'Fake Codex generated tasks source.' });
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
  const mojibakeSubtaskLogPrefix = makeChineseMojibake('当前子任务：');
  writeFileSync(fakeCliPath, `const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const prompt = readFileSync(0, 'utf8');
const specDir = readPromptField('Spec directory');
const taskId = readPromptField('Task ID');
const title = readPromptField('Task title') || taskId;
const currentSubtaskId = readCurrentSubtaskId();
const mojibakeSubtaskLogPrefix = ${JSON.stringify(mojibakeSubtaskLogPrefix)};

if (!specDir) {
  console.error('Missing Spec directory in prompt.');
  process.exit(2);
}

appendFileSync(
  join(specDir, 'fake-cli-calls.log'),
  JSON.stringify({
    mode: currentSubtaskId ? 'coding' : prompt.includes('Create or repair the implementation plan') ? 'planning' : 'spec',
    currentSubtaskId,
  }) + '\\n',
  'utf8',
);

if (prompt.includes('Create initial spec artifacts') || prompt.includes('Create the initial task specification artifacts')) {
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
  writeTasks();
  process.exit(0);
}

if (prompt.includes('Create or repair the implementation plan')) {
  console.log('Fake custom CLI: generating tasks source.');
  writeTasks();
  process.exit(0);
}

if (prompt.includes('Implement the task from the existing spec and runtime work plan') || prompt.includes('Implement the task from the existing spec and plan') || prompt.includes('Implement the task according to the existing spec and implementation plan')) {
  if (!currentSubtaskId) {
    console.error('Missing Current Work Item section for coding prompt.');
    process.exit(4);
  }
  console.log('Fake custom CLI: completing implementation plan for ' + currentSubtaskId + '.');
  console.error(mojibakeSubtaskLogPrefix + currentSubtaskId);
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

function readCurrentSubtaskId() {
  const match = /^(?:Subtask|Work Package) ID:\\s*(.+?)\\s*$/m.exec(prompt);
  return match ? match[1].trim() : '';
}

function writeTasks() {
  writeFileSync(
    join(specDir, 'tasks.md'),
    [
      '# Tasks',
      '',
      'Feature: ' + title,
      'Description: Fake custom CLI lifecycle task.',
      'Workflow: feature',
      'Status: planning',
      'Created: 2026-01-01T00:00:00.000Z',
      'Updated: 2026-01-01T00:00:00.000Z',
      '',
      '- [ ] 1. Implementation',
      '',
      '  - [ ] 1.1 Complete fake lifecycle',
      '    - Prove the runner can pass a prompt to a custom CLI and validate returned artifacts.',
      '    - _Files: src/fake-flow.ts_',
      '    - _Depends on: none_',
      '    - _Requirements: 1.1_',
      '    - _Verification: fake CLI smoke check_',
      '',
      '  - [ ] 1.2 Verify fake lifecycle',
      '    - Prove the runner invokes the custom CLI once per subtask.',
      '    - _Files: src/fake-flow.test.ts_',
      '    - _Depends on: 1.1_',
      '    - _Requirements: 1.2_',
      '    - _Verification: fake CLI smoke check_',
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
  console.log('Retry smoke CLI: leaving tasks.md missing.');
  process.exit(0);
}

console.log('Retry smoke CLI: repairing tasks with executable subtask.');
writeFileSync(
  join(specDir, 'tasks.md'),
  [
    '# Tasks',
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
    '    - _Depends on: none_',
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
