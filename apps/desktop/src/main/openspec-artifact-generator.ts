import { streamText } from 'ai';
import type {
  OpenSpecArtifactGenerator,
  OpenSpecArtifactGeneratorInput,
  OpenSpecArtifactProgress,
  OpenSpecArtifactProgressHandler,
} from '@autocode/core';
import type { TaskMetadata } from '../shared/types/task';
import { createSimpleClient } from './ai/client/factory';
import { getActiveProviderFeatureSettings } from './ipc-handlers/feature-settings-helper';

interface DesktopOpenSpecArtifactGeneratorOptions {
  onProgress?: OpenSpecArtifactProgressHandler;
}

const OPENSPEC_STREAM_PROGRESS_INTERVAL_MS = 8_000;
const OPENSPEC_STREAM_PROGRESS_CHARS = 1_500;
const OPENSPEC_STREAM_HEARTBEAT_MS = 15_000;

function buildSystemPrompt(language?: string): string {
  const baseRules = [
    'Generate OpenSpec artifacts for a software change.',
    '',
    'Rules:',
    '- Follow the OpenSpec instruction and template structure.',
    '- Use concrete project-specific content from the task description and dependencies.',
    '- Output only Markdown for the requested artifact. No preamble, no code fence.',
    '- Do not leave placeholders, TODO, TBD, HTML comments, or example tokens.',
    '- Keep OpenSpec as upstream product/design/spec truth. Do not write Autocode runtime logs or status.',
    '- When generating tasks.md, every executable checkbox task must include one standalone `- _Depends on: ..._` line that forms a task-level DAG. Do not put it on the task title line or repeat it.',
    '- When generating tasks.md, keep dependencies minimal. Do not serialize tasks by section or list order unless a real prerequisite exists.',
    '- When generating tasks.md, expose independent implementation, UI, test, and validation work as fan-out/join branches so runtime work packages can run concurrently.',
    '- When generating specs/<capability>/spec.md, every Requirement body must include the literal English word SHALL or MUST.',
  ];

  if (isChineseLanguage(language)) {
    return [
      ...baseRules,
      '- Output Simplified Chinese for all natural-language headings and prose, except OpenSpec required structural keywords, paths, commands, code identifiers, and filenames.',
      '- For proposal.md, design.md, and tasks.md, translate template headings to Chinese instead of copying English headings.',
      '- For specs/<capability>/spec.md, keep OpenSpec structural keywords in English: ADDED/MODIFIED/REMOVED Requirements, Requirement, Scenario, WHEN, THEN, and the required SHALL/MUST keyword. Write Chinese requirement bodies like "系统 SHALL ...".',
    ].join('\n');
  }

  return [
    ...baseRules,
    '- Match the user language when possible; keep OpenSpec structural keywords required by the template.',
  ].join('\n');
}

function isResponsesApiModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return (
    modelId.startsWith('gpt-5') ||
    modelId.includes('codex') ||
    modelId === 'o3' ||
    modelId.startsWith('o3-') ||
    modelId === 'o4-mini' ||
    modelId.startsWith('o4-')
  );
}

export function createDesktopOpenSpecArtifactGenerator(
  metadata?: TaskMetadata,
  options: DesktopOpenSpecArtifactGeneratorOptions = {},
): OpenSpecArtifactGenerator {
  const modelSettings = resolveSpecGenerationModel(metadata);

  return {
    async generateArtifact(input: OpenSpecArtifactGeneratorInput): Promise<string> {
      const language = resolveOpenSpecLanguage(input.language, metadata);
      const systemPrompt = buildSystemPrompt(language);
      const startedAt = Date.now();
      let generatedChars = 0;
      let lastProgressAt = 0;
      let lastProgressChars = 0;
      const emitProgress = createArtifactProgressEmitter(input, options.onProgress);

      const client = await createSimpleClient({
        systemPrompt,
        modelShorthand: modelSettings.model,
        thinkingLevel: modelSettings.thinkingLevel as 'low' | 'medium' | 'high' | 'xhigh',
      });
      const isResponsesModel = isResponsesApiModel(client.resolvedModelId);

      emitProgress({
        stage: 'artifact_model_start',
        modelId: client.resolvedModelId,
        elapsedMs: Date.now() - startedAt,
      });

      const heartbeat = setInterval(() => {
        emitProgress({
          stage: 'artifact_heartbeat',
          generatedChars,
          elapsedMs: Date.now() - startedAt,
          modelId: client.resolvedModelId,
        });
      }, OPENSPEC_STREAM_HEARTBEAT_MS);

      try {
        const result = streamText({
          model: client.model,
          system: isResponsesModel ? undefined : client.systemPrompt,
          prompt: buildArtifactPrompt(input, language),
          providerOptions: isResponsesModel ? {
            openai: {
              ...(client.systemPrompt ? { instructions: client.systemPrompt } : {}),
              store: false,
            },
          } : undefined,
          onChunk: ({ chunk }) => {
            if (chunk.type !== 'text-delta') {
              return;
            }
            generatedChars += chunk.text.length;
            const now = Date.now();
            if (
              now - lastProgressAt < OPENSPEC_STREAM_PROGRESS_INTERVAL_MS &&
              generatedChars - lastProgressChars < OPENSPEC_STREAM_PROGRESS_CHARS
            ) {
              return;
            }
            lastProgressAt = now;
            lastProgressChars = generatedChars;
            emitProgress({
              stage: 'artifact_model_delta',
              generatedChars,
              elapsedMs: now - startedAt,
              modelId: client.resolvedModelId,
            });
          },
        });
        const text = await result.text;
        generatedChars = Math.max(generatedChars, text.length);
        emitProgress({
          stage: 'artifact_model_complete',
          generatedChars,
          elapsedMs: Date.now() - startedAt,
          modelId: client.resolvedModelId,
        });
        return cleanMarkdown(text.trim());
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}

function createArtifactProgressEmitter(
  input: OpenSpecArtifactGeneratorInput,
  fallback?: OpenSpecArtifactProgressHandler,
): (event: Partial<OpenSpecArtifactProgress>) => void {
  const handler = input.onProgress ?? fallback;
  return (event) => {
    if (!handler) {
      return;
    }
    try {
      handler({
        stage: event.stage ?? 'artifact_heartbeat',
        artifactId: input.artifactId,
        outputPath: input.outputPath,
        changeId: input.changeId,
        capability: input.capability,
        artifactIndex: input.artifactIndex,
        totalArtifacts: input.totalArtifacts,
        attempt: input.attempt,
        generatedChars: event.generatedChars,
        elapsedMs: event.elapsedMs,
        modelId: event.modelId,
        error: event.error,
      });
    } catch {
      // Keep generation independent from UI/log progress reporting.
    }
  };
}

function resolveSpecGenerationModel(metadata?: TaskMetadata): { model: string; thinkingLevel: string } {
  const phaseModel = stringFrom(metadata?.phaseModels?.spec);
  const phaseThinking = stringFrom(metadata?.phaseThinking?.spec);
  if (phaseModel) {
    return {
      model: phaseModel,
      thinkingLevel: phaseThinking || stringFrom(metadata?.thinkingLevel) || 'medium',
    };
  }

  const metadataModel = stringFrom(metadata?.model);
  if (metadataModel) {
    return {
      model: metadataModel,
      thinkingLevel: stringFrom(metadata?.thinkingLevel) || 'medium',
    };
  }

  return getActiveProviderFeatureSettings('roadmap');
}

function buildArtifactPrompt(input: OpenSpecArtifactGeneratorInput, language?: string): string {
  if (isChineseLanguage(language)) {
    return buildChineseArtifactPrompt(input);
  }

  const dependencies = input.dependencies.length > 0
    ? input.dependencies.map((artifact) => [
      `### ${artifact.relativePath}`,
      truncate(artifact.content, 7000),
    ].join('\n')).join('\n\n')
    : 'None yet.';
  const reviewFeedback = stringFrom(input.requirements?.plan_review_feedback);
  const reviewFeedbackSection = reviewFeedback ? [
    'Plan review feedback:',
    reviewFeedback,
    '',
    'Revision rule:',
    '- Revise this upstream OpenSpec artifact to reflect the feedback.',
    '- Preserve useful existing OpenSpec content only when it still matches the feedback.',
    '- The downstream implementation_plan.md will be regenerated after these OpenSpec artifacts are updated.',
  ].join('\n') : '';

  return [
    `Artifact: ${input.artifactId}`,
    `Output path: ${input.outputPath}`,
    `Change ID: ${input.changeId}`,
    `Schema: ${input.schema}`,
    `Capability: ${input.capability}`,
    '',
    'Task title:',
    input.title,
    '',
    'Task description:',
    input.description,
    '',
    ...(reviewFeedbackSection ? [reviewFeedbackSection, ''] : []),
    'Task metadata JSON:',
    stringifyJson(input.metadata ?? {}),
    '',
    'Requirements JSON:',
    stringifyJson(input.requirements ?? {}),
    '',
    'OpenSpec instruction:',
    stringFrom(input.instructions.instruction) || 'Create this OpenSpec artifact.',
    '',
    'OpenSpec project context:',
    stringFrom(input.instructions.context) || 'None.',
    '',
    'OpenSpec template:',
    stringFrom(input.instructions.template) || 'Use the standard OpenSpec template for this artifact.',
    '',
    'OpenSpec rules:',
    stringifyJson(input.instructions.rules ?? []),
    '',
    'Completed dependency artifacts:',
    dependencies,
    '',
    artifactSpecificRules(input.artifactId, input.capability),
    '',
    'Return only the final Markdown content for this artifact.',
  ].join('\n');
}

function buildChineseArtifactPrompt(input: OpenSpecArtifactGeneratorInput): string {
  const dependencies = input.dependencies.length > 0
    ? input.dependencies.map((artifact) => [
      `### ${artifact.relativePath}`,
      truncate(artifact.content, 7000),
    ].join('\n')).join('\n\n')
    : '暂无。';
  const reviewFeedback = stringFrom(input.requirements?.plan_review_feedback);
  const reviewFeedbackSection = reviewFeedback ? [
    '计划审核反馈：',
    reviewFeedback,
    '',
    '修订规则：',
    '- 修改上游 OpenSpec 文档以体现反馈。',
    '- 仅保留仍然符合反馈的已有 OpenSpec 内容。',
    '- 更新 OpenSpec 文档后，下游 implementation_plan.md 会重新生成。',
  ].join('\n') : '';

  return [
    `文档类型：${input.artifactId}`,
    `输出路径：${input.outputPath}`,
    `变更 ID：${input.changeId}`,
    `Schema：${input.schema}`,
    `能力：${input.capability}`,
    '',
    '任务标题：',
    input.title,
    '',
    '任务描述：',
    input.description,
    '',
    ...(reviewFeedbackSection ? [reviewFeedbackSection, ''] : []),
    '任务 metadata JSON：',
    stringifyJson(input.metadata ?? {}),
    '',
    'Requirements JSON：',
    stringifyJson(input.requirements ?? {}),
    '',
    'OpenSpec 指令：',
    stringFrom(input.instructions.instruction) || '创建此 OpenSpec 文档。',
    '',
    'OpenSpec 项目上下文：',
    stringFrom(input.instructions.context) || '暂无。',
    '',
    'OpenSpec 模板：',
    stringFrom(input.instructions.template) || '使用此文档类型的标准 OpenSpec 模板。',
    '',
    'OpenSpec 规则：',
    stringifyJson(input.instructions.rules ?? []),
    '',
    '已完成的依赖文档：',
    dependencies,
    '',
    artifactSpecificRules(input.artifactId, input.capability, 'zh-CN'),
    '',
    '只返回最终 Markdown 内容。',
  ].join('\n');
}

function artifactSpecificRules(artifactId: string, capability: string, language?: string): string {
  if (isChineseLanguage(language)) {
    if (artifactId === 'proposal') {
      return [
        '提案要求：',
        '- 使用中文标题：## 背景、## 变更内容、## 能力范围、## 影响。',
        `- 将新增或修改的能力列为 \`${capability}\`，除非任务明确需要其他能力。`,
        '- 具体说明范围和用户可见行为。',
      ].join('\n');
    }

    if (artifactId === 'design') {
      return [
        '设计要求：',
        '- 使用中文标题：## 上下文、## 目标 / 非目标、## 决策、## 风险 / 权衡。',
        '- 能推断时，写出具体模块、数据流、集成点和取舍。',
        '- 实现指导要具体到能支持编码。',
      ].join('\n');
    }

    if (artifactId === 'specs') {
      return [
        '规格要求：',
        '- 使用 OpenSpec delta 格式：## ADDED Requirements、## MODIFIED Requirements 或 ## REMOVED Requirements。',
        '- 每个 Requirement 正文必须包含字面英文 SHALL 或 MUST；中文正文写成“系统 SHALL ...”。',
        '- 每个 requirement 至少包含一个 #### Scenario，并包含 WHEN 和 THEN 项。',
        '- Requirement 名称、Scenario 名称、条件和结果正文使用简体中文。',
        '- 描述外部可观察行为，不写实现杂项。',
      ].join('\n');
    }

    if (artifactId === 'tasks') {
      return [
        '任务要求：',
        '- 使用分组 Markdown checkbox：顶层 `- [ ] 1. 阶段名称`，缩进子项 `  - [ ] 1.1 具体任务`。',
        '- 将工作拆成具体实现和验证步骤。',
        '- 每个可执行 checkbox 任务必须包含一个独立的 `- _Depends on: ..._` 元数据行，不能写在任务标题同一行，也不能重复。',
        '- 根任务写 `_Depends on: none_`；有前置任务时只写任务 ID，例如 `_Depends on: 1.1, 1.2_`。',
        '- 根据实现顺序、共享文件、验证前置条件和运行时前置条件推断最小依赖图。',
        '- 依赖必须最小化：不要按章节顺序或任务列表顺序自动串行化，只有真实数据、接口、文件或运行前置关系才算依赖。',
        '- 独立实现、独立 UI 区域、独立测试和独立验收场景要形成扇出/汇合 DAG，便于并发执行。',
        '- 多个验证任务可以共同依赖同一个实现完成点；除非验证场景之间真实有前后关系，否则不要互相串行依赖。',
        '- 文件提示、需求引用、验证说明都使用中文；`Depends on` 键名保持英文，便于解析。',
        '- 不要创建单个笼统的“实现全部功能”任务。',
      ].join('\n');
    }

    return '使用 OpenSpec 模板，生成可执行的中文文档。';
  }

  if (artifactId === 'proposal') {
    return [
      'Proposal requirements:',
      '- Include ## Why, ## What Changes, ## Capabilities, and ## Impact.',
      `- List the new or modified capability as \`${capability}\` unless the task clearly requires another capability.`,
      '- Explain scope and user-visible behavior concretely.',
    ].join('\n');
  }

  if (artifactId === 'design') {
    return [
      'Design requirements:',
      '- Include ## Context, ## Goals / Non-Goals, ## Decisions, and ## Risks / Trade-offs.',
      '- Name concrete modules, data flow, integration points, and trade-offs when inferable.',
      '- Keep implementation guidance specific enough for coding.',
    ].join('\n');
  }

  if (artifactId === 'specs') {
    return [
      'Spec requirements:',
      '- Use OpenSpec delta format: ## ADDED Requirements, ## MODIFIED Requirements, or ## REMOVED Requirements.',
      '- Each requirement must include at least one #### Scenario with WHEN and THEN bullets.',
      '- Write externally observable behavior, not implementation chores.',
    ].join('\n');
  }

  if (artifactId === 'tasks') {
    return [
      'Tasks requirements:',
      '- Use grouped Markdown checkbox tasks: a top-level `- [ ] 1. Phase name`, then indented `  - [ ] 1.1 Concrete task` items.',
      '- Split work into concrete implementation and verification steps.',
      '- Every executable checkbox task must include one `_Depends on: ..._` metadata line.',
      '- Root tasks use `_Depends on: none_`; dependent tasks list prerequisite task IDs only, for example `_Depends on: 1.1, 1.2_`.',
      '- Infer the minimum dependency DAG from implementation order, shared files, verification prerequisites, and runtime prerequisites.',
      '- Keep dependencies minimal: do not serialize by section or list order unless a real data, interface, file, or runtime prerequisite exists.',
      '- Independent implementation, UI, test, and validation work should form fan-out/join DAGs so runtime work packages can run concurrently.',
      '- Verification tasks may share the same implementation prerequisite; do not chain independent verification scenarios together.',
      '- Include file hints and requirement references when useful.',
      '- Do not create a single vague "implement everything" task.',
    ].join('\n');
  }

  return 'Use the OpenSpec template and make the artifact actionable.';
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function resolveOpenSpecLanguage(language: unknown, metadata?: TaskMetadata): string | undefined {
  return stringFrom(language) || stringFrom(metadata?.language);
}

function isChineseLanguage(language: unknown): boolean {
  const normalized = stringFrom(language).toLowerCase().replace(/_/g, '-');
  return normalized === 'zh' || normalized.startsWith('zh-') || normalized.includes('chinese');
}

function stringFrom(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...` : value;
}
