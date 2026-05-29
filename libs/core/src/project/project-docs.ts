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

const REFERENCE_FILE_ORDER = [
  AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_ARCHITECTURE_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_TECHNICAL_FILE_NAME,
  AUTOCODE_PROJECT_DOCS_PRODUCT_FILE_NAME,
] as const;

const DEFAULT_REFERENCE_MAX_BYTES = 12_000;
const PER_FILE_REFERENCE_MAX_BYTES = 2_400;

export function isAutocodeProjectDocType(value: string): value is AutocodeProjectDocType {
  return (AUTOCODE_PROJECT_DOC_TYPES as readonly string[]).includes(value);
}

export function formatAutocodeProjectDocTypeList(): string {
  return AUTOCODE_PROJECT_DOC_TYPES.join(', ');
}

export function getAutocodeProjectDocDefinition(
  type: Exclude<AutocodeProjectDocType, 'full'>,
): AutocodeProjectDocDefinition {
  const definition = AUTOCODE_PROJECT_DOC_DEFINITIONS.find((item) => item.type === type);
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
  const outputDir = normalizeProjectRelativePath(
    input.outputDir ?? getAutocodeProjectDocsRelativeDir(dataDirName),
    'outputDir',
  );
  const outputs = buildDocumentOutputs(input.projectRoot, outputDir, documentType);
  const finalMarkdown = documentType === 'full'
    ? joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_INDEX_FILE_NAME)
    : outputs.find((output) => output.type === documentType)?.relativePath ?? outputs[0].relativePath;
  const outline = joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_OUTLINE_FILE_NAME);
  const evidenceIndex = joinRelativePath(outputDir, AUTOCODE_PROJECT_DOCS_EVIDENCE_FILE_NAME);
  const title = input.title?.trim() || defaultProjectDocsTitle(documentType);
  const description = buildProjectDocsTaskDescription(documentType, outputs, outputDir);
  const metadata: AutocodeTaskMetadata = {
    sourceType: 'project_docs',
    category: 'documentation',
    priority: 'high',
    impact: 'high',
    complexity: documentType === 'full' ? 'large' : 'medium',
    workflowMode: 'balanced',
    enableBatchExecution: false,
    ...input.metadata,
    projectDocumentType: documentType,
    projectDocumentOutputDir: outputDir,
    projectDocumentOutputs: outputs.map((output) => output.relativePath),
  };
  const requirements: AutocodeTaskRequirements = {
    workflow_type: 'documentation',
    task_description: description,
    project_documentation: {
      document_type: documentType,
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
    specMarkdown: buildProjectDocsSpecMarkdown(title, description, outputs),
    implementationPlan: buildProjectDocsImplementationPlan({
      title,
      description,
      documentType,
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
): AutocodeProjectDocumentOutput[] {
  const definitions = documentType === 'full'
    ? [...AUTOCODE_PROJECT_DOC_DEFINITIONS]
    : [getAutocodeProjectDocDefinition(documentType)];
  const outputs: AutocodeProjectDocumentOutput[] = [
    {
      ...INDEX_OUTPUT,
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
): string {
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
): string {
  const docRows = outputs.map((output) => `| ${output.type} | \`${output.relativePath}\` | ${output.purpose} |`);
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
  const documentDefinitions = input.documentType === 'full'
    ? [...AUTOCODE_PROJECT_DOC_DEFINITIONS]
    : [getAutocodeProjectDocDefinition(input.documentType)];
  const sectionRequirements = documentDefinitions.flatMap((definition) => [
    `${definition.title} (${definition.fileName}) for ${definition.audience}:`,
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
        name: 'Project documentation',
        depends_on: [],
        subtasks: [
          {
            id: '1.1',
            title: 'Generate project documentation reference pack',
            description: [
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
              run: `Confirm ${input.finalMarkdown}, ${input.outline}, and ${input.evidenceIndex} exist; generated Markdown cites source/evidence files, covers flows or state/data movement, and lists risks or open questions.`,
            },
          },
        ],
      },
    ],
    documentation_depth: 'architecture',
    documentation_profile: 'project-reference',
    documentation_focus: [
      'product intent',
      'architecture boundaries',
      'technical conventions',
      'spec phase context',
      'coding phase context',
      'verification commands',
      'risks and open questions',
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

function defaultProjectDocsTitle(documentType: AutocodeProjectDocType): string {
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
