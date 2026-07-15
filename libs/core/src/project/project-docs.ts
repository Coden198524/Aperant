import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTOCODE_TASK_ARTIFACTS, normalizeAutocodeProjectDataDirName } from '../tasks/artifacts.js';
import { stringifyAutocodeContextMarkdown } from '../tasks/plan-quality.js';
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
  contextData: Record<string, unknown>;
  contextMarkdown: string;
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
  language?: string;
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

const AUTOCODE_PROJECT_DOC_DEFINITIONS_ZH_READABLE: readonly AutocodeProjectDocDefinition[] = [
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

const INDEX_OUTPUT_ZH_READABLE: Omit<AutocodeProjectDocumentOutput, 'relativePath' | 'absolutePath'> = {
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

const DEFAULT_REFERENCE_MAX_BYTES = 4_200;
const PER_FILE_REFERENCE_MAX_BYTES = 900;
const PROJECT_DOC_REFERENCE_SOURCE_READ_MAX_BYTES = 40_000;
const PROJECT_DOC_REFERENCE_HEADING_LIMIT = 8;
const PROJECT_DOC_REFERENCE_BULLET_LIMIT = 10;
const PROJECT_DOC_REFERENCE_PARAGRAPH_LIMIT = 3;
const PROJECT_DOC_REFERENCE_LINE_MAX_BYTES = 180;
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
  const evidenceSources = buildProjectDocsEvidenceSources(outputs, outline, evidenceIndex);
  const requirements: AutocodeTaskRequirements = {
    workflow_type: 'documentation',
    task_description: description,
    language,
    constraints: [
      language === 'zh-CN'
        ? '除文件名、命令、代码标识符和必要英文专有名词外，所有生成的 Markdown 正文、标题、表格说明和总结必须使用简体中文。'
        : 'Write generated Markdown prose, headings, table descriptions, and summaries in English unless project source evidence requires quoted identifiers.',
    ],
    evidence_sources: evidenceSources,
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

  const contextData = buildProjectDocsContextData({
    description,
    documentType,
    language,
    outputDir,
    outputs,
    outline,
    evidenceIndex,
    evidenceSources,
    now: input.now,
  });

  return {
    title,
    description,
    specMarkdown: buildProjectDocsSpecMarkdown(title, description, outputs, language),
    contextData,
    contextMarkdown: stringifyAutocodeContextMarkdown(contextData),
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
      evidenceSources,
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
      writeFileSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.context), `${plan.contextMarkdown.trimEnd()}\n`, 'utf8');
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

  const language = resolveProjectDocsLanguage(input.language);
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

    const rawContent = readLimitedTextFile(absolutePath, PROJECT_DOC_REFERENCE_SOURCE_READ_MAX_BYTES);
    const content = compactProjectDocReferenceContent(
      rawContent,
      relativePath,
      language,
      Math.min(PER_FILE_REFERENCE_MAX_BYTES, remainingBytes),
    );
    if (!content.trim()) {
      continue;
    }

    references.push({
      title: titleFromProjectDocFileName(fileName, language),
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

  const language = resolveProjectDocsLanguage(input.language);
  const availablePaths = collectAutocodeProjectDocsReferencePaths(input);
  if (isChineseProjectDocsLanguage(language)) {
    return buildAutocodeProjectDocsReferencePromptZh(references, availablePaths);
  }
  const lines = language === 'zh-CN'
    ? [
        '## 项目文档参考',
        '',
        '将这些已生成的项目文档作为规格和编码的稳定上下文。优先用它们理解产品意图、架构边界、约定、验证命令和已知风险。如果文档与源码冲突，请以源码为准并说明差异。',
        '',
      ]
    : [
        '## Project Documentation Reference',
        '',
        'Use these generated project documents as stable context for specs and coding. Prefer them for product intent, architecture boundaries, conventions, verification commands, and known risks. If a document conflicts with source code, trust source code and note the drift.',
        'This is an index summary, not the full documentation. Read the referenced Markdown file directly when exact wording or deeper detail is needed.',
        '',
      ];

  if (availablePaths.length > 0) {
    lines.push(language === 'zh-CN'
      ? '\u53ef\u7528\u6587\u6863\uff1a'
      : 'Available documents:');
    for (const reference of availablePaths) {
      lines.push(`- ${reference.relativePath}`);
    }
    lines.push('');
  }

  for (const reference of references) {
    lines.push(`### ${reference.title} (${reference.relativePath})`);
    lines.push(reference.content.trim());
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function buildAutocodeProjectDocsReferencePromptZh(
  references: AutocodeProjectDocsReference[],
  availablePaths: Array<Pick<AutocodeProjectDocsReference, 'title' | 'relativePath'>>,
): string {
  const lines = [
    '## 项目文档参考',
    '',
    '将这些已生成的项目文档作为规格和编码的稳定上下文。优先用它们理解产品意图、架构边界、约定、验证命令和已知风险。',
    '这是索引摘要，不是完整文档。需要精确表述或更深细节时，请直接读取引用的 Markdown 文件。如果文档与源码冲突，请以源码为准并说明差异。',
    '',
  ];

  if (availablePaths.length > 0) {
    lines.push('可用文档：');
    for (const reference of availablePaths) {
      lines.push(`- ${reference.relativePath}`);
    }
    lines.push('');
  }

  for (const reference of references) {
    lines.push(`### ${reference.title} (${reference.relativePath})`);
    lines.push(reference.content.trim());
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function collectAutocodeProjectDocsReferencePaths(
  input: BuildAutocodeProjectDocsReferencePromptInput,
): Array<Pick<AutocodeProjectDocsReference, 'title' | 'relativePath'>> {
  const language = resolveProjectDocsLanguage(input.language);
  const outputDir = getAutocodeProjectDocsRelativeDir(input.dataDirName);
  const references: Array<Pick<AutocodeProjectDocsReference, 'title' | 'relativePath'>> = [];

  for (const fileName of REFERENCE_FILE_ORDER) {
    const relativePath = joinRelativePath(outputDir, fileName);
    const absolutePath = join(input.projectRoot, relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    references.push({
      title: titleFromProjectDocFileName(fileName, language),
      relativePath,
    });
  }

  return references;
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
  if (isChineseProjectDocsLanguage(language)) {
    return buildProjectDocsTaskDescriptionZh(documentType, outputs, outputDir);
  }

  return [
    `Generate ${documentType === 'full' ? 'a project documentation pack' : `the ${documentType} project document`} for future spec and coding context.`,
    '',
    'Documentation-only task. Do not modify product source code.',
    `Write outputs under \`${outputDir}\`.`,
    '',
    'Required outputs:',
    ...outputs.map((output) => `- \`${output.relativePath}\`: ${output.purpose}`),
    `- \`${joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_OUTLINE_FILE_NAME)}\`: Markdown outline with document type, audience, sections, and source references.`,
    `- \`${joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_EVIDENCE_FILE_NAME)}\`: Markdown evidence index with files read, evidence-backed claims, inferred claims, risks, and open questions.`,
    '',
    'Ground major claims in concrete source/config file paths or mark them as inference. Include product intent, architecture, conventions, verification commands, risks, and open questions.',
    'Do not rely on README/manifests alone. Trace entry points, imports/routes/IPC/API/schema/config/test/build evidence until ownership, boundaries, and core flows are clear.',
  ].join('\n');
}

function buildProjectDocsTaskDescriptionZh(
  documentType: AutocodeProjectDocType,
  outputs: AutocodeProjectDocumentOutput[],
  outputDir: string,
): string {
  const docLabel = documentType === 'full'
    ? '完整项目文档包'
    : `${projectDocTypeLabel(documentType, 'zh-CN')}项目文档`;
  return [
    `为后续需求分析和编码上下文生成${docLabel}。`,
    '',
    '这是纯文档任务。不要修改产品源码。',
    `请将输出写入 \`${outputDir}\`。`,
    '',
    '必须生成的输出：',
    ...outputs.map((output) => `- \`${output.relativePath}\`：${output.purpose}`),
    `- \`${joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_OUTLINE_FILE_NAME)}\`：Markdown 大纲，包含文档类型、目标读者、章节、每节回答的问题和预计引用的源文件。`,
    `- \`${joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_EVIDENCE_FILE_NAME)}\`：Markdown 证据索引，包含已阅读文件、有证据支持的结论、推断项、风险和开放问题。`,
    '',
    '除文件名、命令、代码标识符和必要英文专有名词外，所有生成的 Markdown 正文、标题、表格说明和总结必须使用简体中文。',
    '关键结论必须基于源码文件证据；如果属于推断，必须明确标注为推断。需要覆盖产品意图、架构、约定、验证命令、风险和待确认问题。',
  ].join('\n');
}

function buildProjectDocsSpecMarkdown(
  title: string,
  description: string,
  outputs: AutocodeProjectDocumentOutput[],
  language: ProjectDocsLanguage,
): string {
  const docRows = outputs.map((output) => `| ${output.type} | \`${output.relativePath}\` | ${output.purpose} |`);
  if (isChineseProjectDocsLanguage(language)) {
    return buildProjectDocsSpecMarkdownZh(title, description, docRows);
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
    '- Generated docs cite concrete source/config file paths, not just generic source references.',
    '- Each major conclusion cites file paths or is marked as inference.',
    '- `evidence_index.md` records files read, source-backed claims, inferred/unverified claims, confidence, risks/open questions, and uncovered areas.',
    '- Broad docs include source evidence matrices/tables for important modules, flows, configs, commands, and APIs.',
    '- Future specs can use the documents to scope requirements, dependencies, and acceptance criteria.',
    '- Future coding sessions can use the documents to locate entry points, follow conventions, and choose validation commands.',
    '- Product source files are not changed by this task.',
    '',
  ].join('\n');
}

function buildProjectDocsSpecMarkdownZh(
  title: string,
  description: string,
  docRows: string[],
): string {
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
  evidenceSources: string[];
  now?: string;
}): MutableAutocodePlan {
  if (isChineseProjectDocsLanguage(input.language)) {
    return buildProjectDocsImplementationPlanZh(input);
  }

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
                  'Start with README/package/build manifests, entry points, public interfaces, configuration, tests, and existing docs, but do not stop at README/manifests. Expand through imports, routes, IPC/API/schema/config/test/build evidence until source ownership, module boundaries, and core flows are clear.',
                  'Write `doc_outline.md` before final docs. It must list sections, target audience, planned source references, and open source questions for each major section.',
                  'Write `evidence_index.md` as a source ledger with files actually read, subsystem, claim, confidence, inferred/unverified claims, and uncovered areas.',
                  'Final docs must include a source evidence matrix, module ownership, entry points, public interfaces, call/data/state flow, configs, validation commands, and risks/open questions.',
                  '',
                  'Required document coverage:',
                  ...sectionRequirements,
                  '',
                  'The index must link generated documents and explain how future spec/coding sessions should use them.',
                  'Only create or update listed documentation outputs.',
                ].join('\n'),
            status: 'pending',
            files_to_create: outputPaths,
            depends_on: [],
            evidence: input.evidenceSources.join('; '),
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
                : `Confirm ${input.finalMarkdown}, ${input.outline}, and ${input.evidenceIndex} exist; ${input.evidenceIndex} cites concrete source/config paths; generated Markdown cites multiple source files, covers architecture boundaries plus call/data/state flow, and lists risks or open questions.`,
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

function buildProjectDocsImplementationPlanZh(input: {
  title: string;
  description: string;
  documentType: AutocodeProjectDocType;
  language: ProjectDocsLanguage;
  outputDir: string;
  outputs: AutocodeProjectDocumentOutput[];
  finalMarkdown: string;
  outline: string;
  evidenceIndex: string;
  evidenceSources: string[];
  now?: string;
}): MutableAutocodePlan {
  const outputPaths = [
    ...input.outputs.map((output) => output.relativePath),
    input.outline,
    input.evidenceIndex,
  ];
  const documentDefinitions = input.documentType === 'full'
    ? [...AUTOCODE_PROJECT_DOC_DEFINITIONS_ZH_READABLE]
    : [getAutocodeProjectDocDefinition(input.documentType, 'zh-CN')];
  const sectionRequirements = documentDefinitions.flatMap((definition) => [
    `${definition.title}（${definition.fileName}），面向${definition.audience}：`,
    ...definition.requiredSections.map((section) => `  - ${section}`),
  ]);

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
        name: '项目文档',
        depends_on: [],
        subtasks: [
          {
            id: '1.1',
            title: '生成项目文档参考包',
            description: [
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
            ].join('\n'),
            status: 'pending',
            files_to_create: outputPaths,
            depends_on: [],
            evidence: input.evidenceSources.join('; '),
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
              run: `确认 ${input.finalMarkdown}、${input.outline} 和 ${input.evidenceIndex} 已存在；生成的 Markdown 使用简体中文，引用源码/证据文件，覆盖流程或状态/数据流转，并列出风险或待确认问题。`,
            },
          },
        ],
      },
    ],
    documentation_depth: 'architecture',
    documentation_profile: 'project-reference',
    documentation_focus: [
      '产品意图',
      '架构边界',
      '技术约定',
      '需求阶段上下文',
      '编码阶段上下文',
      '验证命令',
      '风险和待确认问题',
      '简体中文文档输出',
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

function buildProjectDocsEvidenceSources(
  outputs: AutocodeProjectDocumentOutput[],
  outline: string,
  evidenceIndex: string,
): string[] {
  return [
    'spec.md project documentation scope',
    'requirements.md project documentation requirements',
    ...outputs.map((output) => `${output.relativePath} planned project documentation output`),
    `${outline} planned documentation outline output`,
    `${evidenceIndex} planned evidence index output`,
    'project source/docs read during documentation generation',
  ];
}

function buildProjectDocsContextData(input: {
  description: string;
  documentType: AutocodeProjectDocType;
  language: ProjectDocsLanguage;
  outputDir: string;
  outputs: AutocodeProjectDocumentOutput[];
  outline: string;
  evidenceIndex: string;
  evidenceSources: string[];
  now?: string;
}): Record<string, unknown> {
  if (isChineseProjectDocsLanguage(input.language)) {
    return buildProjectDocsContextDataZh(input);
  }

  const markdownOutputs = input.outputs.map((output) => output.relativePath);
  return {
    task_description: input.description,
    workflow_type: 'documentation',
    project_documentation: {
      document_type: input.documentType,
      language: input.language,
      output_dir: input.outputDir,
      outputs: [
        ...input.outputs.map((output) => ({
          type: output.type,
          path: output.relativePath,
          purpose: output.purpose,
        })),
        {
          type: 'outline',
          path: input.outline,
          purpose: 'Markdown outline for the generated project documentation pack.',
        },
        {
          type: 'evidence_index',
          path: input.evidenceIndex,
          purpose: 'Markdown evidence index for source-backed documentation claims.',
        },
      ],
      future_usage: ['spec-phase-context', 'coding-phase-context'],
    },
    files_to_modify: [...markdownOutputs, input.outline, input.evidenceIndex],
    files_to_reference: [
      'README*',
      'package.json',
      'apps/*/package.json',
      'libs/*/package.json',
      'src/**/*',
      'apps/**/*',
      'libs/**/*',
      'docs/**/*',
    ],
    implementation_notes: [
      'Documentation-only task. Do not modify product source code.',
      'Read focused project evidence before writing the generated documentation pack; do not rely on README/manifests alone.',
      'Trace entry points, imports/routes/IPC/API/schema/config/test/build evidence until source ownership, boundaries, and core flows are clear.',
      'Major claims must cite concrete source/config file paths or be marked as inference.',
      'The evidence index must record files actually read, subsystem, claim, confidence, inferred/unverified claims, and uncovered areas.',
      'Final docs should include source evidence matrices for important modules, flows, configs, commands, and APIs.',
    ],
    risks: [
      'Large repositories may require sampling; document uncovered areas as open questions.',
      'Generated documentation can drift from source code and should be refreshed after major changes.',
    ],
    verification_suggestions: [
      `Confirm ${input.outline} is structured Markdown.`,
      `Confirm ${input.evidenceIndex} is structured Markdown with concrete source/config file paths and confidence markers.`,
      'Confirm generated Markdown cites multiple source files, analyzes entry points/module boundaries/data flow, and lists risks or open questions.',
    ],
    evidence_sources: input.evidenceSources.map((source) => ({
      path: source,
      proves: source,
      confidence: 'medium',
    })),
    assumptions: [],
    created_at: input.now,
  };
}

function buildProjectDocsContextDataZh(input: {
  description: string;
  documentType: AutocodeProjectDocType;
  language: ProjectDocsLanguage;
  outputDir: string;
  outputs: AutocodeProjectDocumentOutput[];
  outline: string;
  evidenceIndex: string;
  evidenceSources: string[];
  now?: string;
}): Record<string, unknown> {
  const markdownOutputs = input.outputs.map((output) => output.relativePath);
  return {
    task_description: input.description,
    workflow_type: 'documentation',
    project_documentation: {
      document_type: input.documentType,
      language: input.language,
      output_dir: input.outputDir,
      outputs: [
        ...input.outputs.map((output) => ({
          type: output.type,
          path: output.relativePath,
          purpose: output.purpose,
        })),
        {
          type: 'outline',
          path: input.outline,
          purpose: '生成项目文档包的 Markdown 大纲。',
        },
        {
          type: 'evidence_index',
          path: input.evidenceIndex,
          purpose: '用于记录源码证据和文档结论来源的 Markdown 证据索引。',
        },
      ],
      future_usage: ['spec-phase-context', 'coding-phase-context'],
    },
    files_to_modify: [...markdownOutputs, input.outline, input.evidenceIndex],
    files_to_reference: [
      'README*',
      'package.json',
      'apps/*/package.json',
      'libs/*/package.json',
      'src/**/*',
      'apps/**/*',
      'libs/**/*',
      'docs/**/*',
    ],
    implementation_notes: [
      '这是纯文档任务，不要修改产品源码。',
      '先阅读聚焦的项目证据，再编写生成的项目文档包。',
      '关键结论必须引用源码文件，或明确标注为推断。',
    ],
    risks: [
      '大型仓库可能需要抽样阅读；未覆盖区域必须写入开放问题。',
      '生成文档可能随源码演进而过期，重大变更后应刷新。',
    ],
    verification_suggestions: [
      `确认 ${input.outline} 是结构化 Markdown。`,
      `确认 ${input.evidenceIndex} 是结构化 Markdown。`,
      '确认生成的 Markdown 引用源码/证据文件，并列出风险或开放问题。',
    ],
    evidence_sources: input.evidenceSources.map((source) => ({
      path: source,
      proves: source,
      confidence: 'medium',
    })),
    assumptions: [],
    created_at: input.now,
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

function isChineseProjectDocsLanguage(language: ProjectDocsLanguage): boolean {
  return language === 'zh-CN';
}

function getAutocodeProjectDocDefinitions(language?: string): readonly AutocodeProjectDocDefinition[] {
  return resolveProjectDocsLanguage(language) === 'zh-CN'
    ? AUTOCODE_PROJECT_DOC_DEFINITIONS_ZH_READABLE
    : AUTOCODE_PROJECT_DOC_DEFINITIONS;
}

function getProjectDocsIndexOutput(language: ProjectDocsLanguage): Omit<AutocodeProjectDocumentOutput, 'relativePath' | 'absolutePath'> {
  return language === 'zh-CN' ? INDEX_OUTPUT_ZH_READABLE : INDEX_OUTPUT;
}

function projectDocTypeLabel(documentType: AutocodeProjectDocType, language: ProjectDocsLanguage): string {
  if (language !== 'zh-CN') {
    return documentType;
  }
  const labels: Record<AutocodeProjectDocType, string> = {
    full: '完整',
    product: '产品',
    architecture: '架构',
    technical: '技术',
  };
  return labels[documentType];
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
  if (isChineseProjectDocsLanguage(language)) {
    return documentType === 'full'
      ? '生成项目文档参考包'
      : `生成${projectDocTypeLabel(documentType, language)}项目文档`;
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
  return limitUtf8PrefixText(content, maxBytes, '\n...[truncated]');
}

function compactProjectDocReferenceContent(
  content: string,
  relativePath: string,
  language: ProjectDocsLanguage,
  maxBytes: number,
): string {
  const normalized = normalizeReferenceMarkdown(content);
  if (Buffer.byteLength(normalized, 'utf8') <= maxBytes) {
    return normalized;
  }

  const headings: string[] = [];
  const bullets: string[] = [];
  const paragraphs: string[] = [];
  let inFence = false;

  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    if (/^#{1,4}\s+\S/.test(line)) {
      pushUnique(headings, line.replace(/^#{1,4}\s+/, ''));
      continue;
    }
    if (/^(?:[-*+]|\d+[.)])\s+\S/.test(line)) {
      pushUnique(bullets, line.replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
      continue;
    }
    if (line.length >= 36) {
      pushUnique(paragraphs, line);
    }
  }

  const compactLines = [
    language === 'zh-CN'
      ? '> \u7d27\u51d1\u6458\u5f55\uff1b\u9700\u8981\u5b8c\u6574\u539f\u6587\u65f6\uff0c\u8bf7\u7cbe\u786e\u8bfb\u53d6\u6b64\u6587\u6863\u3002'
      : '> Compact excerpt; read this document directly when exact wording or deeper detail is needed.',
    `> Source: ${relativePath}`,
    '',
  ];

  appendReferenceSection(
    compactLines,
    language === 'zh-CN' ? '\u5173\u952e\u6807\u9898' : 'Key headings',
    selectLeadingItems(headings, PROJECT_DOC_REFERENCE_HEADING_LIMIT),
  );
  appendReferenceSection(
    compactLines,
    language === 'zh-CN' ? '\u6458\u8981' : 'Selected notes',
    selectLeadingItems(paragraphs, PROJECT_DOC_REFERENCE_PARAGRAPH_LIMIT),
  );
  appendReferenceSection(
    compactLines,
    language === 'zh-CN' ? '\u5173\u952e\u8981\u70b9' : 'Selected bullets',
    selectLeadingItems(bullets, PROJECT_DOC_REFERENCE_BULLET_LIMIT),
  );

  if (headings.length === 0 && bullets.length === 0 && paragraphs.length === 0) {
    compactLines.push(limitUtf8Text(normalized, Math.max(0, maxBytes - 80), '\n...[truncated]'));
  }

  return limitUtf8PrefixText(
    compactLines.join('\n').trimEnd(),
    maxBytes,
    `\n...[compact reference truncated; read ${relativePath}]`,
  );
}

function normalizeReferenceMarkdown(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function appendReferenceSection(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) {
    return;
  }
  lines.push(`${title}:`);
  for (const item of items) {
    lines.push(`- ${limitUtf8Text(item, PROJECT_DOC_REFERENCE_LINE_MAX_BYTES, '...')}`);
  }
  lines.push('');
}

function selectLeadingItems(items: readonly string[], limit: number): string[] {
  if (limit <= 0) {
    return [];
  }
  return items.slice(0, limit);
}

function pushUnique(items: string[], value: string): void {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || items.includes(normalized)) {
    return;
  }
  items.push(normalized);
}

function limitUtf8Text(content: string, maxBytes: number, suffix: string): string {
  if (maxBytes <= 0) {
    return '';
  }
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return content;
  }

  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const contentBudget = Math.max(0, maxBytes - suffixBytes);
  if (contentBudget <= 0) {
    return takeUtf8Prefix(content, maxBytes);
  }

  const headBudget = Math.ceil(contentBudget * 0.65);
  const tailBudget = Math.max(0, contentBudget - headBudget);
  return `${takeUtf8Prefix(content, headBudget).trimEnd()}${suffix}${takeUtf8Suffix(content, tailBudget).trimStart()}`;
}

function limitUtf8PrefixText(content: string, maxBytes: number, suffix: string): string {
  if (maxBytes <= 0) {
    return '';
  }
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
    return content;
  }

  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const contentBudget = Math.max(0, maxBytes - suffixBytes);
  if (contentBudget <= 0) {
    return takeUtf8Prefix(content, maxBytes);
  }
  return `${takeUtf8Prefix(content, contentBudget).trimEnd()}${suffix}`;
}

function takeUtf8Prefix(content: string, maxBytes: number): string {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(content.slice(0, mid), 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return content.slice(0, low);
}

function takeUtf8Suffix(content: string, maxBytes: number): string {
  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(content.slice(content.length - mid), 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return content.slice(content.length - low);
}

function titleFromProjectDocFileName(fileName: string, language: ProjectDocsLanguage = 'en'): string {
  if (isChineseProjectDocsLanguage(language)) {
    if (fileName === AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME) return '项目文档索引';
    if (fileName === AUTOCODE_PROJECT_DOCS_PRODUCT_FILE_NAME) return '产品文档';
    if (fileName === AUTOCODE_PROJECT_DOCS_ARCHITECTURE_FILE_NAME) return '架构文档';
    if (fileName === AUTOCODE_PROJECT_DOCS_TECHNICAL_FILE_NAME) return '技术文档';
  }

  if (fileName === AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME) return 'Project Documentation Index';
  const definition = AUTOCODE_PROJECT_DOC_DEFINITIONS.find((item) => item.fileName === fileName);
  return definition?.title ?? fileName;
}
