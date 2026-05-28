const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

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

    const projectIndexPath = join(projectRoot, '.autocode', 'project_index.json');
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
    });
    assert.match(task.specId, /^001-add-provider-settings/);
    assert.equal(task.status, 'backlog');
    assert.ok(existsSync(join(task.specsPath, 'implementation_plan.json')));
    assert.ok(existsSync(join(task.specsPath, 'requirements.json')));

    const tasks = core.listAutocodeTasks({ projectRoot, dataDirName: '.autocode' });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, task.id);
    assert.equal(tasks[0].description, 'Create provider account settings shared by desktop and VS Code.');

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
    assert.ok(runnerScript.includes("plan.status = failed ? 'error' : 'human_review'"));

    writeFileSync(join(task.specsPath, 'spec.md'), '# Add provider settings\n\n## Overview\nImplement settings.\n');
    const planningRunPlan = core.createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
      cli: 'codex',
      bypassPermissions: true,
    });
    assert.equal(planningRunPlan.phase, 'planning');
    assert.equal(planningRunPlan.command, 'codex');
    assert.ok(planningRunPlan.args.includes('--dangerously-bypass-approvals-and-sandbox'));
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

    writeFileSync(
      join(task.specsPath, 'implementation_plan.json'),
      JSON.stringify({
        feature: task.title,
        status: 'pending',
        phases: [{ subtasks: [{ id: '1.1', title: 'Build UI', description: 'Add UI', status: 'pending' }] }],
      }, null, 2),
    );
    const codingRunPlan = core.createAutocodeTaskRunPlan({
      projectRoot,
      dataDirName: '.autocode',
      taskId: task.id,
      cli: 'gemini',
    });
    assert.equal(codingRunPlan.phase, 'coding');
    assert.equal(codingRunPlan.command, 'gemini');

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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
