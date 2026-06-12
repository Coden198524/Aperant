import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTOCODE_TASK_ARTIFACTS, normalizeAutocodeProjectDataDirName } from '../tasks/artifacts.js';
import {
  createAutocodeTask,
  listAutocodeTasks,
  type AutocodeTask,
  type AutocodeTaskMetadata,
  type AutocodeTaskRequirements,
} from '../tasks/spec-store.js';
import { saveAutocodeImplementationPlanSync } from '../tasks/plan-store.js';
import type { MutableAutocodePlan } from '../tasks/plan-file.js';
import { resolveAutocodeTaskRuntimeConcurrency } from '../runtime/concurrency.js';
import {
  AUTOCODE_PROJECT_DOCS_ARCHITECTURE_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_EVIDENCE_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_OUTLINE_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_PRODUCT_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_TECHNICAL_FILE_NAME,
  getAutocodeProjectDocsRelativeDir,
} from './data-paths.js';

export type AutocodeProjectDocType =
  | 'full'
  | 'product'
  | 'architecture'
  | 'technical';

export interface AutocodeProjectDocDefinition {
  type: Exclude<AutocodeProjectDocType, 'full'>;
  title: string;
  fileName: string;
  audience: string;
  purpose: string;
  requiredSections: string[];
}

export interface AutocodeProjectDocumentOutput {
  type: AutocodeProjectDocType | 'index';
  title: string;
  relativePath: string;
  absolutePath: string;
  purpose: string;
}

export interface CreateAutocodeProjectDocumentationTaskInput {
  projectRoot: string;
  dataDirName?: string;
  documentType?: AutocodeProjectDocType;
  outputDir?: string;
  language?: string;
  title?: string;
  specId?: string;
  overwrite?: boolean;
  now?: string;
  metadata?: AutocodeTaskMetadata;
}

export interface AutocodeProjectDocumentationTaskPlan {
  title: string;
  description: string;
  specMarkdown: string;
  implementationPlan: MutableAutocodePlan;
  metadata: AutocodeTaskMetadata;
  requirements: AutocodeTaskRequirements;
  outputs: AutocodeProjectDocumentOutput[];
  outputDir: string;
  finalMarkdown: string;
  outline: string;
  evidenceIndex: string;
}

export interface AutocodeProjectDocumentationTaskResult {
  task: AutocodeTask;
  plan: AutocodeProjectDocumentationTaskPlan;
}

export interface AutocodeProjectDocsReference {
  title: string;
  relativePath: string;
  content: string;
}

export interface BuildAutocodeProjectDocsReferencePromptInput {
  projectRoot: string;
  dataDirName?: string;
  maxBytes?: number;
}

export const AUTOCODE_PROJECT_DOC_TYPES: readonly AutocodeProjectDocType[] = [
  'full',
  'product',
  'architecture',
  'technical',
] as const;

export const AUTOCODE_PROJECT_DOC_DEFINITIONS: readonly AutocodeProjectDocDefinition[] = [
  {
    type: 'product',
    title: 'Product Document',
    fileName: AUTOCODE_PROJECT_DOCS_PRODUCT_FILE_NAME,
    audience: 'product managers, designers, support, and engineers',
    purpose: 'Explain the product purpose, target users, major workflows, domain concepts, assumptions, and product risks.',
    requiredSections: [
      'Product purpose and value proposition',
      'Primary users and workflows',
      'Domain concepts and business rules',
      'Current feature map with source evidence',
      'Open product questions',
    ],
  },
  {
    type: 'architecture',
    title: 'Architecture Document',
    fileName: AUTOCODE_PROJECT_DOCS_ARCHITECTURE_FILE_NAME,
    audience: 'architects and senior engineers',
    purpose: 'Map system boundaries, modules, runtime/process split, dependency direction, data flow, and architectural risks.',
    requiredSections: [
      'System overview and module boundaries',
      'Runtime/process/component map',
      'Core flows and data/state flow',
      'External integrations and storage boundaries',
      'Architecture risks, invariants, and open questions',
    ],
  },
  {
    type: 'technical',
    title: 'Technical Document',
    fileName: AUTOCODE_PROJECT_DOCS_TECHNICAL_FILE_NAME,
    audience: 'engineers',
    purpose: 'Capture stack, build/test commands, configuration, APIs, storage, conventions, and operational constraints.',
    requiredSections: [
      'Technology stack and package layout',
      'Build, test, lint, and run commands',
      'Configuration and environment files',
      'Public interfaces, APIs, schemas, and storage',
      'Technical risks, generated files, and verification gaps',
    ],
  },
] as const;

const INDEX_OUTPUT: Omit<AutocodeProjectDocumentOutput, 'relativePath' | 'absolutePath'> = {
  type: 'index',
  title: 'Project Documentation Index',
  purpose: 'Index the generated project documentation pack and explain how future spec and coding agents should use it.',
};

const AUTOCODE_PROJECT_DOC_DEFINITIONS_ZH: readonly AutocodeProjectDocDefinition[] = [
  {
    type: 'product',
    title: '产品文档',
    fileName: AUTOCODE_PROJECT_DOCS_PRODUCT_FILE_NAME,
    audience: '产品经理、设计、支持人员和工程师',
    purpose: '说明产品目标、目标用户、主要流程、领域概念、假设和产品风险。',
    requiredSections: [
      '产品目标和价值主张',
      '主要用户和业务流程',
      '领域概念和业务规则',
      '带源码证据的当前功能地图',
      '待确认的产品问题',
    ],
  },
  {
    type: 'architecture',
    title: '架构文档',
    fileName: AUTOCODE_PROJECT_DOCS_ARCHITECTURE_FILE_NAME,
    audience: '架构师和资深工程师',
    purpose: '梳理系统边界、模块划分、运行时/进程分层、依赖方向、数据流和架构风险。',
    requiredSections: [
      '系统概览和模块边界',
      '运行时、进程和组件关系图',
      '核心流程以及数据/状态流转',
      '外部集成和存储边界',
      '架构风险、不变量和待确认问题',
    ],
  },
  {
    type: 'technical',
    title: '技术文档',
    fileName: AUTOCODE_PROJECT_DOCS_TECHNICAL_FILE_NAME,
    audience: '工程师',
    purpose: '记录技术栈、构建/测试命令、配置、API、存储、编码约定和运维约束。',
    requiredSections: [
      '技术栈和包结构',
      '构建、测试、Lint 和运行命令',
      '配置和环境文件',
      '公开接口、API、Schema 和存储',
      '技术风险、生成文件和验证缺口',
    ],
  },
] as const;

const INDEX_OUTPUT_ZH: Omit<AutocodeProjectDocumentOutput, 'relativePath' | 'absolutePath'> = {
  type: 'index',
  title: '项目文档索引',
  purpose: '索引生成的项目文档包，并说明后续需求分析和编码 Agent 应如何使用这些文档。',
};

const REFERENCE_FILE_ORDER = [
  AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_ARCHITECTURE_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_TECHNICAL_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_PRODUCT_FILE_NAME,
] as const;

const DEFAULT_REFERENCE_MAX_BYTES = 12_000;
const PER_FILE_REFERENCE_MAX_BYTES = 2_400;
type ProjectDocsLanguage = 'en' | 'zh-CN';

export function isAutocodeProjectDocType(value: string): value is AutocodeProjectDocType {
  return (AUTOCODE_PROJECT_DOC_TYPES as readonly string[]).includes(value);
}

export function formatAutocodeProjectDocTypeList(): string {
  return AUTOCODE_PROJECT_DOC_TYPES.join(', ');
}

export function getAutocodeProjectDocDefinition(
  type: Exclude<AutocodeProjectDocType, 'full'>,
  language?: string,
): AutocodeProjectDocDefinition {
  const definitions = getAutocodeProjectDocDefinitions(language);
  const definition = definitions.find((item) => item.type === type);
  if (!definition) {
    throw new Error(`Unsupported project document type: ${type}`);
  }
  return definition;
}

export function buildAutocodeProjectDocumentationTaskPlan(
  input: CreateAutocodeProjectDocumentationTaskInput,
): AutocodeProjectDocumentationTaskPlan {
  const dataDirName = normalizeAutocodeProjectDataDirName(input.dataDirName);
  const documentType = normalizeProjectDocType(input.documentType);
  const language = resolveProjectDocsLanguage(input.language ?? metadataLanguage(input.metadata));
  const outputDir = normalizeProjectRelativePath(
    input.outputDir ?? getAutocodeProjectDocsRelativeDir(dataDirName),
    'outputDir',
  );
  const outputs = buildDocumentOutputs(input.projectRoot, outputDir, documentType, language);
  const finalMarkdown = documentType === 'full'
    ? joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME)
    : outputs.find((output) => output.type === documentType)?.relativePath ?? outputs[0].relativePath;
  const outline = joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_OUTLINE_FILE_NAME);
  const evidenceIndex = joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_EVIDENCE_FILE_NAME);
  const title = input.title?.trim() || defaultProjectDocsTitle(documentType, language);
  const description = buildProjectDocsTaskDescription(documentType, outputs, outputDir, language);
  const metadataBase: AutocodeTaskMetadata = {
    sourceType: 'project_docs',
    category: 'documentation',
    priority: 'high',
    impact: 'high',
    complexity: documentType === 'full' ? 'large' : 'medium',
    workflowMode: 'balanced',
    ...input.metadata,
    language,
    projectDocumentType: documentType,
    projectDocumentOutputDir: outputDir,
    projectDocumentOutputs: outputs.map((output) => output.relativePath),
  };
  const metadata: AutocodeTaskMetadata = {
    ...metadataBase,
    runtimeConcurrency: resolveAutocodeTaskRuntimeConcurrency(metadataBase),
  };
  const requirements: AutocodeTaskRequirements = {
    workflow_type: 'documentation',
    task_description: description,
    language,
    constraints: [
      language === 'zh-CN'
        ? '除文件名、命令、代码标识符和必要英文专有名词外，所有生成的 Markdown 正文、标题、表格说明和总结必须使用简体中文。'
        : 'Write generated Markdown prose, headings, table descriptions, and summaries in English unless project source evidence requires quoted identifiers.',
    ],
    project_documentation: {
      document_type: documentType,
      language,
      output_dir: outputDir,
      outputs: outputs.map((output) => ({
        type: output.type,
        path: output.relativePath,
        purpose: output.purpose,
      })),
      future_usage: ['spec-phase-context', 'coding-phase-context'],
    },
  };

  return {
    title,
    description,
    specMarkdown: buildProjectDocsSpecMarkdown(title, description, outputs, language),
    implementationPlan: buildProjectDocsImplementationPlan({
      title,
      description,
      documentType,
      language,
      outputDir,
      outputs,
      finalMarkdown,
      outline,
      evidenceIndex,
      now: input.now,
    }),
    metadata,
    requirements,
    outputs,
    outputDir,
    finalMarkdown,
    outline,
    evidenceIndex,
  };
}

export function createAutocodeProjectDocumentationTask(
  input: CreateAutocodeProjectDocumentationTaskInput,
): AutocodeProjectDocumentationTaskResult {
  const projectRoot = requireNonEmpty(input.projectRoot, 'projectRoot');
  const dataDirName = normalizeAutocodeProjectDataDirName(input.dataDirName);
  const plan = buildAutocodeProjectDocumentationTaskPlan({ ...input, projectRoot, dataDirName });
  const task = createAutocodeTask({
    projectRoot,
    dataDirName,
    title: plan.title,
    description: plan.description,
    specId: input.specId,
    fallbackSlug: 'project-docs',
    overwrite: input.overwrite,
    metadata: plan.metadata,
    requirements: plan.requirements,
    now: input.now,
    prepareSpecArtifacts: ({ specDir }) => {
      writeFileSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile), `${plan.specMarkdown.trimEnd()}\n`, 'utf8');
      return {
        metadata: plan.metadata,
        requirements: plan.requirements,
      };
    },
  });

  const now = input.now ?? task.createdAt;
  saveAutocodeImplementationPlanSync(task.specsPath, {
    ...plan.implementationPlan,
    created_at: now,
    updated_at: now,
  });

  const refreshed = listAutocodeTasks({ projectRoot, dataDirName })
    .find((candidate) => candidate.id === task.id || candidate.specId === task.specId);

  return {
    task: refreshed ?? task,
    plan,
  };
}

export function collectAutocodeProjectDocsReferences(
  input: BuildAutocodeProjectDocsReferencePromptInput,
): AutocodeProjectDocsReference[] {
  const maxBytes = input.maxBytes ?? DEFAULT_REFERENCE_MAX_BYTES;
  if (maxBytes <= 0) {
    return [];
  }

  const outputDir = getAutocodeProjectDocsRelativeDir(input.dataDirName);
  const references: AutocodeProjectDocsReference[] = [];
  let remainingBytes = maxBytes;

  for (const fileName of REFERENCE_FILE_ORDER) {
    if (remainingBytes <= 0) {
      break;
    }
    const relativePath = joinRelativePath(outputDir, fileName);
    const absolutePath = join(input.projectRoot, relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }

    const content = readLimitedTextFile(absolutePath, Math.min(PER_FILE_REFERENCE_MAX_BYTES, remainingBytes));
    if (!content.trim()) {
      continue;
    }

    references.push({
      title: titleFromProjectDocFileName(fileName),
      relativePath,
      content,
    });
    remainingBytes -= Buffer.byteLength(content, 'utf8');
  }

  return references;
}

export function buildAutocodeProjectDocsReferencePrompt(
  input: BuildAutocodeProjectDocsReferencePromptInput,
): string {
  const references = collectAutocodeProjectDocsReferences(input);
  if (references.length === 0) {
    return '';
  }

  const lines = [
    '## Project Documentation Reference',
    '',
    'Use these generated project documents as stable context for specs and coding. Prefer them for product intent, architecture boundaries, conventions, verification commands, and known risks. If a document conflicts with source code, trust source code and note the drift.',
    '',
  ];

  for (const reference of references) {
    lines.push(`### ${reference.title} (${reference.relativePath})`);
    lines.push(reference.content.trim());
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function buildDocumentOutputs(
  projectRoot: string,
  outputDir: string,
  documentType: AutocodeProjectDocType,
  language: ProjectDocsLanguage,
): AutocodeProjectDocumentOutput[] {
  const definitionsForLanguage = getAutocodeProjectDocDefinitions(language);
  const definitions = documentType === 'full'
    ? [...definitionsForLanguage]
    : [getAutocodeProjectDocDefinition(documentType, language)];
  const outputs: AutocodeProjectDocumentOutput[] = [
    {
      ...getProjectDocsIndexOutput(language),
      relativePath: joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME),
      absolutePath: join(projectRoot, outputDir, AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME),
    },
  ];

  for (const definition of definitions) {
    outputs.push({
      type: definition.type,
      title: definition.title,
      relativePath: joinRelativePath(outputDir, definition.fileName),
      absolutePath: join(projectRoot, outputDir, definition.fileName),
      purpose: definition.purpose,
    });
  }

  return outputs;
}

function buildProjectDocsTaskDescription(
  documentType: AutocodeProjectDocType,
  outputs: AutocodeProjectDocumentOutput[],
  outputDir: string,
  language: ProjectDocsLanguage,
): string {
  if (language === 'zh-CN') {
    return [
      `为后续需求分析和编码上下文生成${documentType === 'full' ? '完整项目文档包' : `${projectDocTypeLabel(documentType, language)}项目文档`}。`,
      '',
      '这是纯文档任务。不要修改产品源码。',
      `请将输出写入 \`${outputDir}\`。`,
      '',
      '必须生成的输出：',
      ...outputs.map((output) => `- \`${output.relativePath}\`：${output.purpose}`),
      `- \`${joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_OUTLINE_FILE_NAME)}\`：JSON 大纲，包含 document_type、audience、sections 和 source references。`,
      `- \`${joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_EVIDENCE_FILE_NAME)}\`：JSON 证据索引，包含 files_read、evidence_backed_claims、inferred_claims、risks 和 open_questions。`,
      '',
      '除文件名、命令、代码标识符和必要英文专有名词外，所有生成的 Markdown 正文、标题、表格说明和总结必须使用简体中文。',
      '关键结论必须基于源码文件证据；如果属于推断，必须明确标注为推断。需要覆盖产品意图、架构、约定、验证命令、风险和待确认问题。',
    ].join('\n');
  }

  return [
    `Generate ${documentType === 'full' ? 'a project documentation pack' : `the ${documentType} project document`} for future spec and coding context.`,
    '',
    'Documentation-only task. Do not modify product source code.',
    `Write outputs under \`${outputDir}\`.`,
    '',
    'Required outputs:',
    ...outputs.map((output) => `- \`${output.relativePath}\`: ${output.purpose}`),
    `- \`${joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_OUTLINE_FILE_NAME)}\`: JSON outline with document_type, audience, sections, and source references.`,
    `- \`${joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_EVIDENCE_FILE_NAME)}\`: JSON evidence index with files_read, evidence_backed_claims, inferred_claims, risks, and open_questions.`,
    '',
    'Ground major claims in source files or mark them as inference. Include product intent, architecture, conventions, verification commands, risks, and open questions.',
  ].join('\n');
}

function buildProjectDocsSpecMarkdown(
  title: string,
  description: string,
  outputs: AutocodeProjectDocumentOutput[],
  language: ProjectDocsLanguage,
): string {
  const docRows = outputs.map((output) => `| ${output.type} | \`${output.relativePath}\` | ${output.purpose} |`);
  if (language === 'zh-CN') {
    return [
      `# ${title}`,
      '',
      '## 目标',
      description,
      '',
      '## 输出',
      '| 类型 | 路径 | 用途 |',
      '| --- | --- | --- |',
      ...docRows,
      '',
      '## 质量要求',
      '- 文档必须基于源码证据生成，不能写成通用猜测。',
      '- 每个关键结论都要引用文件路径，或明确标注为推断。',
      '- 后续需求分析可以用这些文档界定需求范围、依赖关系和验收标准。',
      '- 后续编码会话可以用这些文档定位入口、遵循约定并选择验证命令。',
      '- 本任务不得修改产品源码。',
      '- 除文件名、命令、代码标识符和必要英文专有名词外，所有生成的 Markdown 正文、标题、表格说明和总结必须使用简体中文。',
      '',
    ].join('\n');
  }

  return [
    `# ${title}`,
    '',
    '## Goal',
    description,
    '',
    '## Outputs',
    '| Type | Path | Purpose |',
    '| --- | --- | --- |',
    ...docRows,
    '',
    '## Quality Bar',
    '- Documentation is generated from source evidence, not generic guesses.',
    '- Each major conclusion cites file paths or is marked as inference.',
    '- Future specs can use the documents to scope requirements, dependencies, and acceptance criteria.',
    '- Future coding sessions can use the documents to locate entry points, follow conventions, and choose validation commands.',
    '- Product source files are not changed by this task.',
    '',
  ].join('\n');
}

function buildProjectDocsImplementationPlan(input: {
  title: string;
  description: string;
  documentType: AutocodeProjectDocType;
  language: ProjectDocsLanguage;
  outputDir: string;
  outputs: AutocodeProjectDocumentOutput[];
  finalMarkdown: string;
  outline: string;
  evidenceIndex: string;
  now?: string;
}): MutableAutocodePlan {
  const outputPaths = [
    ...input.outputs.map((output) => output.relativePath),
    input.outline,
    input.evidenceIndex,
  ];
  const definitionsForLanguage = getAutocodeProjectDocDefinitions(input.language);
  const documentDefinitions = input.documentType === 'full'
    ? [...definitionsForLanguage]
    : [getAutocodeProjectDocDefinition(input.documentType, input.language)];
  const sectionRequirements = documentDefinitions.flatMap((definition) => [
    input.language === 'zh-CN'
      ? `${definition.title}（${definition.fileName}），面向${definition.audience}：`
      : `${definition.title} (${definition.fileName}) for ${definition.audience}:`,
    ...definition.requiredSections.map((section) => `  - ${section}`),
  ]);
  const isChinese = input.language === 'zh-CN';

  return {
    feature: input.title,
    description: input.description,
    workflow_type: 'documentation',
    status: 'pending',
    planStatus: 'pending',
    created_at: input.now,
    updated_at: input.now,
    phases: [
      {
        id: '1',
        name: isChinese ? '项目文档' : 'Project documentation',
        depends_on: [],
        subtasks: [
          {
            id: '1.1',
            title: isChinese ? '生成项目文档参考包' : 'Generate project documentation reference pack',
            description: isChinese
              ? [
                  '分析仓库并生成所需的项目文档。',
                  '',
                  '优先从 README、package/build 清单、入口点、公开接口、配置、测试和已有文档开始阅读，只在必要时扩展范围。',
                  '',
                  '必须覆盖的文档内容：',
                  ...sectionRequirements,
                  '',
                  '索引文档必须链接已生成的文档，并说明后续需求分析/编码会话应如何使用它们。',
                  '只允许创建或更新列出的文档输出。',
                  '除文件名、命令、代码标识符和必要英文专有名词外，所有生成的 Markdown 正文、标题、表格说明和总结必须使用简体中文。',
                ].join('\n')
              : [
                  'Analyze the repository and write the requested project documentation.',
                  '',
                  'Start with README/package/build manifests, entry points, public interfaces, configuration, tests, and existing docs. Expand only as needed.',
                  '',
                  'Required document coverage:',
                  ...sectionRequirements,
                  '',
                  'The index must link generated documents and explain how future spec/coding sessions should use them.',
                  'Only create or update listed documentation outputs.',
                ].join('\n'),
            status: 'pending',
            files_to_create: outputPaths,
            pattern_files: [
              'README*',
              'package.json',
              'apps/*/package.json',
              'libs/*/package.json',
              'src/**/*',
              'apps/**/*',
              'libs/**/*',
              'docs/**/*',
            ],
            verification: {
              type: 'manual',
              run: isChinese
                ? `确认 ${input.finalMarkdown}、${input.outline} 和 ${input.evidenceIndex} 已存在；生成的 Markdown 使用简体中文，引用源码/证据文件，覆盖流程或状态/数据流转，并列出风险或待确认问题。`
                : `Confirm ${input.finalMarkdown}, ${input.outline}, and ${input.evidenceIndex} exist; generated Markdown cites source/evidence files, covers flows or state/data movement, and lists risks or open questions.`,
            },
          },
        ],
      },
    ],
    documentation_depth: 'architecture',
    documentation_profile: 'project-reference',
    documentation_focus: [
      ...(isChinese
        ? [
            '产品意图',
            '架构边界',
            '技术约定',
            '需求阶段上下文',
            '编码阶段上下文',
            '验证命令',
            '风险和待确认问题',
            '简体中文文档输出',
          ]
        : [
            'product intent',
            'architecture boundaries',
            'technical conventions',
            'spec phase context',
            'coding phase context',
            'verification commands',
            'risks and open questions',
          ]),
    ],
    document_outputs: {
      base: 'project',
      final_markdown: input.finalMarkdown,
      outline: input.outline,
      evidence_index: input.evidenceIndex,
      markdown_files: input.outputs.map((output) => output.relativePath),
    },
    source_task: {
      kind: 'project-documentation',
      document_type: input.documentType,
      output_dir: input.outputDir,
      future_usage: ['spec-phase-context', 'coding-phase-context'],
    },
  };
}

function normalizeProjectDocType(value: AutocodeProjectDocType | undefined): AutocodeProjectDocType {
  const normalized = value ?? 'full';
  if (!isAutocodeProjectDocType(normalized)) {
    throw new Error(`Unsupported project document type "${normalized}". Supported values: ${formatAutocodeProjectDocTypeList()}.`);
  }
  return normalized;
}

function metadataLanguage(metadata?: AutocodeTaskMetadata): string | undefined {
  return typeof metadata?.language === 'string' && metadata.language.trim()
    ? metadata.language.trim()
    : undefined;
}

function resolveProjectDocsLanguage(language?: string): ProjectDocsLanguage {
  const normalized = language?.trim().toLowerCase();
  return normalized?.startsWith('zh') ? 'zh-CN' : 'en';
}

function getAutocodeProjectDocDefinitions(language?: string): readonly AutocodeProjectDocDefinition[] {
  return resolveProjectDocsLanguage(language) === 'zh-CN'
    ? AUTOCODE_PROJECT_DOC_DEFINITIONS_ZH
    : AUTOCODE_PROJECT_DOC_DEFINITIONS;
}

function getProjectDocsIndexOutput(language: ProjectDocsLanguage): Omit<AutocodeProjectDocumentOutput, 'relativePath' | 'absolutePath'> {
  return language === 'zh-CN' ? INDEX_OUTPUT_ZH : INDEX_OUTPUT;
}

function projectDocTypeLabel(documentType: AutocodeProjectDocType, language: ProjectDocsLanguage): string {
  if (language !== 'zh-CN') {
    return documentType;
  }
  switch (documentType) {
    case 'full':
      return '完整';
    case 'product':
      return '产品';
    case 'architecture':
      return '架构';
    case 'technical':
      return '技术';
  }
}

function normalizeProjectRelativePath(value: string, name: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) {
    throw new Error(`${name} is required.`);
  }
  if (
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`${name} must be a project-relative path.`);
  }
  return normalized;
}

function joinRelativePath(base: string, fileName: string): string {
  return `${base.replace(/\/+$/, '')}/${fileName.replace(/^\/+/, '')}`;
}

function defaultProjectDocsTitle(documentType: AutocodeProjectDocType, language: ProjectDocsLanguage): string {
  if (language === 'zh-CN') {
    if (documentType === 'full') {
      return '生成项目文档参考包';
    }
    return `生成${projectDocTypeLabel(documentType, language)}项目文档`;
  }

  if (documentType === 'full') {
    return 'Generate project documentation reference pack';
  }
  return `Generate ${documentType} project documentation`;
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }
  return trimmed;
}

function readLimitedTextFile(filePath: string, maxBytes: number): string {
  const content = readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return content;
  }
  return `${content.slice(0, maxBytes)}\n...[truncated]`;
}

function titleFromProjectDocFileName(fileName: string): string {
  if (fileName === AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME) return 'Project Documentation Index';
  const definition = AUTOCODE_PROJECT_DOC_DEFINITIONS.find((item) => item.fileName === fileName);
  return definition?.title ?? fileName;
}
