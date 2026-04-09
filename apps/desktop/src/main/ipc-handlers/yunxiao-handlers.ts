import { ipcMain, app } from 'electron';
import type { BrowserWindow } from 'electron';
import { generateText } from 'ai';
import { IPC_CHANNELS, getSpecsDir, AUTO_BUILD_PATHS } from '../../shared/constants';
import type {
  IPCResult,
  Project,
  TaskMetadata,
  YunxiaoIssue,
  YunxiaoIssueSyncResult,
  YunxiaoImportResult,
  YunxiaoProject,
  YunxiaoSyncStatus,
  YunxiaoWorkItem
} from '../../shared/types';
import path from 'path';
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { projectStore } from '../project-store';
import { parseEnvFile } from './utils';
import { sanitizeText, sanitizeUrl } from './shared/sanitize';
import { buildSpecId } from './shared/spec-id';
import { buildYunxiaoTaskMetadata } from './yunxiao/metadata';
import { formatYunxiaoDescriptionContent, normalizeYunxiaoDescriptionValue } from './yunxiao/description';
import { AgentManager } from '../agent';
import { createSimpleClient } from '../ai/client/factory';
import {
  listYunxiaoIssues,
  upsertYunxiaoIssuesFromWorkItems,
  updateYunxiaoIssueLocalFields
} from '../integrations/yunxiao-issues-store';
import { getActiveProviderFeatureSettings } from './feature-settings-helper';
import type { ThinkingLevel } from '../../shared/types/settings';
import { isClosedYunxiaoStatus } from '../../shared/utils/yunxiao-status';

const DEFAULT_TOOLSETS = 'organization-management,project-management';
const DEFAULT_WORKITEM_CATEGORY = 'Task';
const YUNXIAO_WORKITEM_CATEGORIES = ['Task', 'Req', 'Bug'] as const;
type YunxiaoWorkitemCategory = (typeof YUNXIAO_WORKITEM_CATEGORIES)[number];
const DEFAULT_MCP_COMMAND = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const DEFAULT_MCP_ARGS = ['-y', 'alibabacloud-devops-mcp-server'];
const YUNXIAO_SYNC_MAX_PAGES = 30;
const YUNXIAO_SYNC_PER_PAGE = 200;
const MAX_YUNXIAO_IMAGE_BYTES = 15 * 1024 * 1024;
const ALLOWED_YUNXIAO_IMAGE_HOSTS = new Set([
  'devops.aliyun.com',
  'openapi-rdc.aliyuncs.com'
]);
const ALLOWED_YUNXIAO_IMAGE_HOST_SUFFIXES = [
  '.aliyuncs.com'
];
const YUNXIAO_VALID_TOOLSETS = new Set([
  'base',
  'code-management',
  'organization-management',
  'project-management',
  'pipeline-management',
  'packages-management',
  'application-delivery',
  'test-management',
]);
const YUNXIAO_ANALYSIS_SYSTEM_PROMPT = [
  '你是资深游戏研发缺陷分析助手。',
  '请基于给定缺陷信息输出可执行、可验证的分析结果。',
  '规则：',
  '1. 使用简体中文。',
  '2. 使用 Markdown 格式。',
  '3. 保持结论可落地，不要泛泛而谈。',
  '4. 缺少信息时必须明确写“待确认”，不要编造。'
].join('\n');

function isResponsesApiModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  return modelId.startsWith('gpt-5')
    || modelId.includes('codex')
    || modelId === 'o3'
    || modelId.startsWith('o3-')
    || modelId === 'o4-mini'
    || modelId.startsWith('o4-');
}

export interface YunxiaoEnvConfig {
  accessToken: string;
  enabled: boolean;
  autoSync: boolean;
  organizationId?: string;
  projectId?: string;
  workitemCategory: string;
  toolsets: string;
  mcpCommand: string;
  mcpArgs: string[];
  mcpNpmCache?: string;
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

export function getString(record: Record<string, unknown> | null, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function getNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function normalizeErrorText(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message.replace(/\s+/g, ' ').trim();
  }
  if (typeof error === 'string') {
    return error.replace(/\s+/g, ' ').trim();
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error).replace(/\s+/g, ' ').trim();
    } catch {
      return 'Unknown error';
    }
  }
  return 'Unknown error';
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildYunxiaoIssueAnalysisPrompt(issue: YunxiaoIssue): string {
  const description = truncate(
    sanitizeText(issue.description || '', 12000, true) || '',
    12000
  ) || '（无描述）';
  const existingAnalysis = truncate(
    sanitizeText(issue.localAnalysis || '', 6000, true) || '',
    6000
  ) || '（无）';

  return [
    '请输出该缺陷的分析初稿，用于研发排查与修复讨论。',
    '',
    '输出结构（必须包含以下标题）：',
    '## 问题概述',
    '## 复现路径',
    '## 根因假设（按可能性排序）',
    '## 修复建议',
    '## 验收要点',
    '## 风险与回归测试',
    '',
    '缺陷信息：',
    `- 标题：${issue.title}`,
    `- 云效编号：${issue.identifier || issue.workItemId}`,
    `- 状态：${issue.statusName || '未知'}`,
    `- 优先级：${issue.priority || '未知'}`,
    `- 空间：${issue.spaceName || '未知'}`,
    `- 本地分类：${issue.localCategory || 'unclassified'}`,
    `- 本地严重级别：${issue.localSeverity || 'medium'}`,
    '',
    '缺陷描述：',
    description,
    '',
    '已有人工分析（如有）：',
    existingAnalysis,
    '',
    '注意：',
    '- 没有证据的内容写“待确认”。',
    '- 尽量给出适用于游戏研发场景的建议（客户端/服务器/数值/资源/网络等）。',
  ].join('\n');
}

async function generateYunxiaoIssueAnalysis(issue: YunxiaoIssue): Promise<string> {
  const { model, thinkingLevel } = getActiveProviderFeatureSettings('utility');
  const client = await createSimpleClient({
    systemPrompt: YUNXIAO_ANALYSIS_SYSTEM_PROMPT,
    modelShorthand: model,
    thinkingLevel: thinkingLevel as ThinkingLevel,
    maxSteps: 1
  });

  const modelId = typeof client.model === 'string' ? client.model : client.model.modelId;
  const isCodex = modelId?.includes('codex') ?? false;
  const isResponsesModel = isResponsesApiModel(modelId);
  const prompt = buildYunxiaoIssueAnalysisPrompt(issue);

  const result = await generateText({
    model: client.model,
    system: isCodex ? undefined : client.systemPrompt,
    prompt,
    ...(isResponsesModel ? {
      providerOptions: {
        openai: {
          ...(isCodex && client.systemPrompt ? { instructions: client.systemPrompt } : {}),
          store: true,
        },
      },
    } : {}),
  });

  const analysis = result.text.trim();
  if (!analysis) {
    throw new Error('AI returned empty analysis');
  }
  return analysis;
}

export function isPermissionError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('insufficient permissions')
    || lower.includes('permission denied')
    || lower.includes('forbidden')
    || lower.includes('status code 403')
    || /\b403\b/.test(lower);
}

export function isUnauthorizedError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('unauthorized')
    || lower.includes('invalid token')
    || lower.includes('authentication')
    || lower.includes('status code 401')
    || /\b401\b/.test(lower);
}

export function isNetworkError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('timeout')
    || lower.includes('timed out')
    || lower.includes('econnreset')
    || lower.includes('enotfound')
    || lower.includes('network')
    || lower.includes('fetch failed')
    || lower.includes('socket hang up');
}

export function parseMcpArgs(raw?: string): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [...DEFAULT_MCP_ARGS];

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const args = parsed
          .map(item => String(item).trim())
          .filter(Boolean);
        if (args.length > 0) return args;
      }
    } catch {
      // Fallback to whitespace split below.
    }
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  return tokens.length > 0 ? tokens : [...DEFAULT_MCP_ARGS];
}

export function normalizeToolsets(raw?: string): string {
  const input = raw?.trim();
  if (!input) return DEFAULT_TOOLSETS;

  const valid = input
    .split(',')
    .map(toolset => toolset.trim())
    .filter(Boolean)
    .filter(toolset => YUNXIAO_VALID_TOOLSETS.has(toolset));

  if (valid.length === 0) {
    return DEFAULT_TOOLSETS;
  }

  // Keep order, remove duplicates.
  return [...new Set(valid)].join(',');
}

export function normalizeWorkitemCategoryToken(raw?: string): YunxiaoWorkitemCategory | undefined {
  const token = raw?.trim().toLowerCase();
  if (!token) return undefined;

  if (
    token === 'task'
    || token.includes('任务')
    || token.includes('task')
  ) return 'Task';

  if (
    token === 'req'
    || token.includes('requirement')
    || token.includes('story')
    || token.includes('需求')
  ) return 'Req';

  if (
    token.includes('bug')
    || token.includes('defect')
    || token.includes('issue')
    || token.includes('缺陷')
    || token.includes('问题')
    || token.includes('故障')
  ) return 'Bug';

  return undefined;
}

function isAllowedYunxiaoImageUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    if (ALLOWED_YUNXIAO_IMAGE_HOSTS.has(parsed.hostname)) return true;
    return ALLOWED_YUNXIAO_IMAGE_HOST_SUFFIXES.some(suffix => parsed.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

function extractImageUrlFromJsonValue(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') {
    const safe = sanitizeUrl(value);
    return safe || undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractImageUrlFromJsonValue(item);
      if (nested) return nested;
    }
    return undefined;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidateKeys = ['url', 'downloadUrl', 'fileUrl', 'imageUrl', 'href', 'link'];
    for (const key of candidateKeys) {
      const nested = extractImageUrlFromJsonValue(record[key]);
      if (nested) return nested;
    }
    for (const nestedValue of Object.values(record)) {
      const nested = extractImageUrlFromJsonValue(nestedValue);
      if (nested) return nested;
    }
  }
  return undefined;
}

function extractImageUrlFromText(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text);
    const fromJson = extractImageUrlFromJsonValue(parsed);
    if (fromJson) return fromJson;
  } catch {
    // Keep regex fallback for non-JSON payload.
  }

  const match = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) return undefined;
  const safe = sanitizeUrl(match[0]);
  return safe || undefined;
}

async function responseToImageDataUrl(response: Response): Promise<string | null> {
  if (!response.ok) return null;

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    return null;
  }

  const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_YUNXIAO_IMAGE_BYTES) {
    throw new Error(`Image too large (${contentLength} bytes)`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_YUNXIAO_IMAGE_BYTES) {
    throw new Error(`Image too large (${buffer.length} bytes)`);
  }
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

async function fetchImageDataUrl(
  url: string,
  accessToken?: string
): Promise<{ dataUrl?: string; text?: string; status: number }> {
  const headers: Record<string, string> = {
    Accept: 'image/*,application/json;q=0.9,*/*;q=0.8'
  };
  if (accessToken) {
    headers['x-yunxiao-token'] = accessToken;
  }

  const response = await fetch(url, { headers });
  const dataUrl = await responseToImageDataUrl(response);
  if (dataUrl) {
    return { dataUrl, status: response.status };
  }

  const text = await response.text().catch(() => '');
  return { text, status: response.status };
}

function extractFileIdentifierFromYunxiaoUrl(imageUrl: string): string | undefined {
  try {
    const parsed = new URL(imageUrl);
    const fileIdentifier = parsed.searchParams.get('fileIdentifier');
    const safe = sanitizeText(fileIdentifier || '', 120);
    return safe || undefined;
  } catch {
    return undefined;
  }
}

async function resolveYunxiaoImageDownloadUrlViaMcp(
  config: YunxiaoEnvConfig,
  workItemId: string,
  imageUrl: string
): Promise<string | null> {
  const fileId = extractFileIdentifierFromYunxiaoUrl(imageUrl);
  if (!fileId) return null;

  return withYunxiaoClient(config, async (client) => {
    const org = await resolveOrganization(client, config);
    const fileInfo = await callYunxiaoTool<Record<string, unknown>>(client, 'get_workitem_file', {
      organizationId: org.organizationId,
      workitemId: workItemId,
      id: fileId
    });
    const fileRecord = toRecord(fileInfo);
    const candidate = sanitizeUrl(
      getString(fileRecord, 'url')
      || getString(fileRecord, 'downloadUrl')
      || getString(fileRecord, 'fileUrl')
      || ''
    );
    return candidate || null;
  });
}

async function resolveYunxiaoImageToDataUrl(
  config: YunxiaoEnvConfig,
  imageUrl: string,
  workItemId?: string
): Promise<string> {
  const normalized = sanitizeUrl(imageUrl);
  if (!normalized) {
    throw new Error('Invalid image URL');
  }
  if (!isAllowedYunxiaoImageUrl(normalized)) {
    throw new Error('Image URL host is not allowed');
  }

  if (workItemId && normalized.includes('/projex/api/workitem/file/url')) {
    const resolvedDownloadUrl = await resolveYunxiaoImageDownloadUrlViaMcp(config, workItemId, normalized);
    if (resolvedDownloadUrl) {
      const direct = await fetchImageDataUrl(resolvedDownloadUrl);
      if (direct.dataUrl) return direct.dataUrl;
    }
  }

  const first = await fetchImageDataUrl(normalized, config.accessToken);
  if (first.dataUrl) return first.dataUrl;

  const nestedUrl = first.text ? extractImageUrlFromText(first.text) : undefined;
  if (nestedUrl) {
    // First try without token for pre-signed URLs, then with token if needed.
    const secondNoToken = await fetchImageDataUrl(nestedUrl);
    if (secondNoToken.dataUrl) return secondNoToken.dataUrl;
    const secondWithToken = await fetchImageDataUrl(nestedUrl, config.accessToken);
    if (secondWithToken.dataUrl) return secondWithToken.dataUrl;
  }

  throw new Error(`Unable to resolve Yunxiao image (status ${first.status})`);
}

export function resolveWorkitemCategories(raw?: string, fallback: string = DEFAULT_WORKITEM_CATEGORY): YunxiaoWorkitemCategory[] {
  const input = raw?.trim();
  if (!input) {
    return [normalizeWorkitemCategoryToken(fallback) || 'Task'];
  }

  const normalized = input.toLowerCase();
  if (['all', '*', '全部', 'all-categories', 'all_categories'].includes(normalized)) {
    return [...YUNXIAO_WORKITEM_CATEGORIES];
  }

  const parts = input
    .split(/[,\uFF0C;\uFF1B|/]+/)
    .map(token => normalizeWorkitemCategoryToken(token))
    .filter((value): value is YunxiaoWorkitemCategory => Boolean(value));

  if (parts.length === 0) {
    const fallbackCategory = normalizeWorkitemCategoryToken(input)
      || normalizeWorkitemCategoryToken(fallback)
      || 'Task';
    return [fallbackCategory];
  }

  return [...new Set(parts)];
}

export function formatYunxiaoError(
  error: unknown,
  context: 'connection' | 'projects' | 'workitems' | 'import' = 'connection'
): string {
  const message = normalizeErrorText(error);

  if (isPermissionError(message)) {
    if (context === 'workitems' || context === 'import') {
      return 'Yunxiao permission denied: this token cannot read work items. Grant project read permissions and ensure the account is a member of the target project.';
    }
    return 'Yunxiao permission denied (403): verify the Access Token has organization/project read permissions and that your account can access the target organization/project.';
  }

  if (isUnauthorizedError(message)) {
    return 'Yunxiao authentication failed (401): check whether YUNXIAO_ACCESS_TOKEN is valid and not expired.';
  }

  if (isNetworkError(message)) {
    return 'Yunxiao connection failed due to a network/proxy issue. Check connectivity and retry.';
  }

  if (message.toLowerCase().includes('connection closed')) {
    return 'Yunxiao MCP process exited unexpectedly (Connection closed). Check YUNXIAO_MCP_COMMAND / YUNXIAO_MCP_ARGS, and ensure npm cache directory is writable.';
  }

  return `Yunxiao request failed: ${truncate(message, 220)}`;
}

export function getYunxiaoEnvConfig(project: Project): YunxiaoEnvConfig | null {
  if (!project.autoBuildPath) return null;
  const envPath = path.join(project.path, project.autoBuildPath, '.env');
  if (!existsSync(envPath)) return null;

  try {
    const content = readFileSync(envPath, 'utf-8');
    const vars = parseEnvFile(content);
    const accessToken = vars['YUNXIAO_ACCESS_TOKEN']?.trim();
    if (!accessToken) return null;
    const enabled = vars['YUNXIAO_ENABLED']?.toLowerCase() !== 'false';
    const autoSync = vars['YUNXIAO_AUTO_SYNC']?.toLowerCase() === 'true';

    return {
      accessToken,
      enabled,
      autoSync,
      organizationId: vars['YUNXIAO_ORGANIZATION_ID']?.trim() || undefined,
      projectId: vars['YUNXIAO_PROJECT_ID']?.trim() || undefined,
      workitemCategory: resolveWorkitemCategories(
        vars['YUNXIAO_WORKITEM_CATEGORY'],
        DEFAULT_WORKITEM_CATEGORY
      )[0],
      toolsets: normalizeToolsets(vars['DEVOPS_TOOLSETS']),
      mcpCommand: vars['YUNXIAO_MCP_COMMAND']?.trim() || DEFAULT_MCP_COMMAND,
      mcpArgs: parseMcpArgs(vars['YUNXIAO_MCP_ARGS']),
      mcpNpmCache: vars['YUNXIAO_MCP_NPM_CACHE']?.trim() || undefined
    };
  } catch {
    return null;
  }
}

export function createYunxiaoTransport(config: YunxiaoEnvConfig): StdioClientTransport {
  const npmCache = config.mcpNpmCache?.trim()
    || path.join(app.getPath('userData'), 'mcp-cache', 'yunxiao-npm');
  mkdirSync(npmCache, { recursive: true });

  return new StdioClientTransport({
    command: config.mcpCommand,
    args: config.mcpArgs,
    env: {
      ...process.env,
      YUNXIAO_ACCESS_TOKEN: config.accessToken,
      DEVOPS_TOOLSETS: config.toolsets,
      npm_config_cache: npmCache,
      NPM_CONFIG_CACHE: npmCache
    } as Record<string, string>
  });
}

export async function withYunxiaoClient<T>(
  config: YunxiaoEnvConfig,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({
    name: 'aperant-yunxiao',
    version: '1.0.0'
  });
  const transport = createYunxiaoTransport(config);
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function parseToolResult(result: unknown): unknown {
  const record = toRecord(result);
  if (!record) return result;

  if (record['isError']) {
    throw new Error('Yunxiao MCP returned an error');
  }

  const structured = record['structuredContent'];
  if (structured !== undefined) {
    return structured;
  }

  const content = record['content'];
  if (Array.isArray(content)) {
    const text = content
      .map(item => getString(toRecord(item), 'text'))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (text) {
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error(
          `Failed to parse Yunxiao MCP response: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }
  }

  return result;
}

export async function callYunxiaoTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const response = await client.callTool({ name, arguments: args });
  return parseToolResult(response) as T;
}

export async function resolveOrganization(
  client: Client,
  config: YunxiaoEnvConfig,
  preferredOrganizationId?: string
): Promise<{ organizationId: string; organizationName?: string }> {
  if (preferredOrganizationId) {
    return { organizationId: preferredOrganizationId };
  }
  if (config.organizationId) {
    return { organizationId: config.organizationId };
  }

  const currentOrg = await callYunxiaoTool<{ lastOrganization?: string; userName?: string }>(
    client,
    'get_current_organization_info',
    {}
  );

  if (!currentOrg?.lastOrganization) {
    throw new Error('Unable to resolve Yunxiao organization ID');
  }

  let organizationName: string | undefined;
  try {
    const orgs = await callYunxiaoTool<Array<{ id?: string; name?: string }>>(
      client,
      'get_user_organizations',
      {}
    );
    organizationName = orgs.find(org => org.id === currentOrg.lastOrganization)?.name;
  } catch {
    organizationName = undefined;
  }

  return {
    organizationId: currentOrg.lastOrganization,
    organizationName: organizationName || currentOrg.userName
  };
}

export function normalizeProjects(raw: unknown): YunxiaoProject[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(item => {
    const record = toRecord(item);
    const statusInfo = toRecord(record?.['statusInfo']);
    const status = getString(statusInfo, 'name') || getString(record, 'logicalStatus');
    return {
      id: getString(record, 'id') || '',
      name: getString(record, 'name') || 'Untitled Project',
      description: getString(record, 'description'),
      status
    };
  }).filter(project => Boolean(project.id));
}

export function normalizeWorkItems(raw: unknown): YunxiaoWorkItem[] {
  const rootRecord = toRecord(raw);
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(rootRecord?.['items'])
      ? rootRecord['items'] as unknown[]
      : [];

  return list.map(item => {
    const record = toRecord(item);
    const statusRecord = toRecord(record?.['status']);
    const workitemTypeRecord = toRecord(record?.['workitemType']);
    const assignedToRecord = toRecord(record?.['assignedTo']);
    const creatorRecord = toRecord(record?.['creator']);
    const spaceRecord = toRecord(record?.['space']);
    return {
      id: getString(record, 'id') || '',
      identifier: getString(record, 'identifier'),
      subject: getString(record, 'subject') || 'Untitled Work Item',
      description: normalizeYunxiaoDescriptionValue(record?.['description']),
      categoryId: getString(record, 'categoryId'),
      status: statusRecord ? {
        id: getString(statusRecord, 'id'),
        name: getString(statusRecord, 'name'),
        displayName: getString(statusRecord, 'displayName')
      } : undefined,
      priority: getString(record, 'priority'),
      workitemType: workitemTypeRecord ? {
        id: getString(workitemTypeRecord, 'id'),
        name: getString(workitemTypeRecord, 'name'),
        categoryId: getString(workitemTypeRecord, 'categoryId')
      } : undefined,
      assignedTo: assignedToRecord ? {
        id: getString(assignedToRecord, 'id'),
        name: getString(assignedToRecord, 'name')
      } : undefined,
      creator: creatorRecord ? {
        id: getString(creatorRecord, 'id'),
        name: getString(creatorRecord, 'name')
      } : undefined,
      space: spaceRecord ? {
        id: getString(spaceRecord, 'id'),
        name: getString(spaceRecord, 'name')
      } : undefined,
      gmtCreate: getNumber(record, 'gmtCreate'),
      gmtModified: getNumber(record, 'gmtModified'),
      url: getString(record, 'url')
    };
  }).filter(item => Boolean(item.id));
}

function isLikelyClosedStatus(rawStatus: string | undefined): boolean {
  if (!rawStatus) return false;
  const status = rawStatus.trim().toLowerCase().replace(/\s+/g, '');
  if (!status) return false;

  const explicitOpenTokensZh = ['待处理', '处理中', '进行中', '开发中'];
  if (explicitOpenTokensZh.some((token) => status.includes(token))) {
    return false;
  }

  const explicitClosedTokensZh = ['已关闭', '关闭', '已解决', '解决', '已完成', '完成', '已修复', '修复', '已取消', '取消'];
  if (explicitClosedTokensZh.some((token) => status.includes(token))) {
    return true;
  }

  const explicitOpenTokens = [
    'open',
    'todo',
    'new',
    'active',
    'inprogress',
    'processing',
    '鏈叧闂?',
    '鏈В鍐?',
    '鏈畬鎴?',
    '寰呰В鍐?',
    '澶勭悊涓?',
    '淇涓?',
    '瑙ｅ喅涓?',
    '鍏抽棴涓?',
    '瀹屾垚涓?'
  ];
  if (explicitOpenTokens.some((token) => status.includes(token))) {
    return false;
  }

  const exactClosedTokens = new Set([
    'closed',
    'resolved',
    'done',
    'completed',
    'complete',
    'fixed',
    'canceled',
    'cancelled',
    '宸插叧闂?',
    '鍏抽棴',
    '宸茶В鍐?',
    '宸插畬鎴?',
    '瀹屾垚',
    '宸蹭慨澶?'
  ]);
  if (exactClosedTokens.has(status)) {
    return true;
  }

  const partialClosedTokens = [
    'closed',
    'resolved',
    'completed',
    'cancelled',
    'canceled',
    'fixed',
    '宸插叧闂?',
    '宸茶В鍐?',
    '宸插畬鎴?',
    '宸蹭慨澶?',
    '楠屾敹閫氳繃'
  ];
  return partialClosedTokens.some((token) => status.includes(token));
}

function isClosedOrResolvedWorkItem(item: YunxiaoWorkItem): boolean {
  return isClosedYunxiaoStatus(item.status?.displayName) || isClosedYunxiaoStatus(item.status?.name);
}

async function fetchOpenYunxiaoBugWorkItems(
  config: YunxiaoEnvConfig,
  preferredOrganizationId?: string,
  preferredSpaceId?: string
): Promise<YunxiaoWorkItem[]> {
  return withYunxiaoClient(config, async (client) => {
    const org = await resolveOrganization(client, config, preferredOrganizationId);
    let spaceId = preferredSpaceId || config.projectId;
    if (!spaceId) {
      const projectsRaw = await callYunxiaoTool<unknown>(client, 'search_projects', {
        organizationId: org.organizationId,
        page: 1,
        perPage: 20,
        orderBy: 'gmtCreate',
        sort: 'desc'
      });
      const projects = normalizeProjects(projectsRaw);
      spaceId = projects[0]?.id;
      if (!spaceId) {
        return [];
      }
    }

    const merged = new Map<string, YunxiaoWorkItem>();
    let page = 1;
    while (page <= YUNXIAO_SYNC_MAX_PAGES) {
      const raw = await callYunxiaoTool<unknown>(client, 'search_workitems', {
        organizationId: org.organizationId,
        category: 'Bug',
        spaceId,
        page,
        perPage: YUNXIAO_SYNC_PER_PAGE,
        sort: 'desc',
        orderBy: 'gmtModified',
        includeDetails: true
      });

      const items = normalizeWorkItems(raw);
      if (items.length === 0) {
        break;
      }

      for (const item of items) {
        if (!item.id || isClosedOrResolvedWorkItem(item)) continue;
        if (!merged.has(item.id)) {
          merged.set(item.id, item);
        }
      }

      const pagination = toRecord(toRecord(raw)?.['pagination']);
      const total = getNumber(pagination, 'total');
      if (total !== undefined && page * YUNXIAO_SYNC_PER_PAGE >= total) {
        break;
      }
      if (items.length < YUNXIAO_SYNC_PER_PAGE) {
        break;
      }
      page += 1;
    }

    return Array.from(merged.values()).sort((a, b) => (b.gmtModified || 0) - (a.gmtModified || 0));
  });
}

/**
 * Register all Yunxiao-related IPC handlers.
 */
export function registerYunxiaoHandlers(
  agentManager: AgentManager,
  _getMainWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_CHECK_CONNECTION,
    async (_, projectId: string): Promise<IPCResult<YunxiaoSyncStatus>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getYunxiaoEnvConfig(project);
      if (!config) {
        return {
          success: true,
          data: {
            connected: false,
            error: 'No Yunxiao access token configured'
          }
        };
      }

      try {
        const data = await withYunxiaoClient(config, async (client) => {
          const org = await resolveOrganization(client, config);
          const projectsRaw = await callYunxiaoTool<unknown>(client, 'search_projects', {
            organizationId: org.organizationId,
            page: 1,
            perPage: 20,
            orderBy: 'gmtCreate',
            sort: 'desc'
          });
          const projects = normalizeProjects(projectsRaw);

          let workItemCount: number | undefined;
          let warning: string | undefined;
          const spaceId = config.projectId || projects[0]?.id;
          if (spaceId) {
            try {
              const workitemsRaw = await callYunxiaoTool<unknown>(client, 'search_workitems', {
                organizationId: org.organizationId,
                category: resolveWorkitemCategories(config.workitemCategory, DEFAULT_WORKITEM_CATEGORY)[0],
                spaceId,
                page: 1,
                perPage: 1,
                sort: 'desc',
                orderBy: 'gmtCreate'
              });
              const pagination = toRecord(toRecord(workitemsRaw)?.['pagination']);
              workItemCount = getNumber(pagination, 'total');
              if (workItemCount === undefined) {
                workItemCount = normalizeWorkItems(workitemsRaw).length;
              }
            } catch (error) {
              // Keep connection "connected" if org/project checks passed.
              // Missing work-item permission is common and should be surfaced as a warning.
              warning = formatYunxiaoError(error, 'workitems');
            }
          }

          return {
            connected: true,
            organizationId: org.organizationId,
            organizationName: org.organizationName,
            projectCount: projects.length,
            workItemCount,
            lastSyncedAt: new Date().toISOString(),
            error: warning
          } satisfies YunxiaoSyncStatus;
        });

        return { success: true, data };
      } catch (error) {
        return {
          success: true,
          data: {
            connected: false,
            error: formatYunxiaoError(error, 'connection')
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_GET_PROJECTS,
    async (_, projectId: string, preferredOrganizationId?: string): Promise<IPCResult<YunxiaoProject[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getYunxiaoEnvConfig(project);
      if (!config) {
        return { success: false, error: 'No Yunxiao access token configured' };
      }

      try {
        const projects = await withYunxiaoClient(config, async (client) => {
          const org = await resolveOrganization(client, config, preferredOrganizationId);
          const projectsRaw = await callYunxiaoTool<unknown>(client, 'search_projects', {
            organizationId: org.organizationId,
            page: 1,
            perPage: 100,
            orderBy: 'gmtCreate',
            sort: 'desc'
          });
          return normalizeProjects(projectsRaw);
        });

        return { success: true, data: projects };
      } catch (error) {
        return {
          success: false,
          error: formatYunxiaoError(error, 'projects')
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_GET_WORK_ITEMS,
    async (
      _,
      projectId: string,
      preferredOrganizationId?: string,
      preferredSpaceId?: string,
      preferredCategory?: string
    ): Promise<IPCResult<YunxiaoWorkItem[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getYunxiaoEnvConfig(project);
      if (!config) {
        return { success: false, error: 'No Yunxiao access token configured' };
      }

      try {
        const items = await withYunxiaoClient(config, async (client) => {
          const org = await resolveOrganization(client, config, preferredOrganizationId);
          const spaceId = preferredSpaceId || config.projectId;
          if (!spaceId) {
            throw new Error('Yunxiao project ID is required');
          }
          const categories = resolveWorkitemCategories(
            preferredCategory || config.workitemCategory,
            DEFAULT_WORKITEM_CATEGORY
          );

          const allItems = await Promise.all(categories.map(async (category) => {
            const raw = await callYunxiaoTool<unknown>(client, 'search_workitems', {
              organizationId: org.organizationId,
              category,
              spaceId,
              page: 1,
              perPage: 200,
              sort: 'desc',
              orderBy: 'gmtCreate',
              includeDetails: true
            });
            return normalizeWorkItems(raw);
          }));

          const mergedById = new Map<string, YunxiaoWorkItem>();
          for (const list of allItems) {
            for (const item of list) {
              if (!item.id) continue;
              if (!mergedById.has(item.id)) {
                mergedById.set(item.id, item);
              }
            }
          }

          return Array.from(mergedById.values()).sort((a, b) => (b.gmtModified || 0) - (a.gmtModified || 0));
        });

        return { success: true, data: items };
      } catch (error) {
        return {
          success: false,
          error: formatYunxiaoError(error, 'workitems')
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_GET_ISSUES,
    async (_, projectId: string): Promise<IPCResult<YunxiaoIssue[]>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      if (!project.autoBuildPath) {
        return { success: true, data: [] };
      }

      try {
        const issues = listYunxiaoIssues(project);
        return { success: true, data: issues };
      } catch (error) {
        return {
          success: false,
          error: formatYunxiaoError(error, 'workitems')
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_SYNC_ISSUES,
    async (_, projectId: string): Promise<IPCResult<YunxiaoIssueSyncResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      if (!project.autoBuildPath) {
        return { success: false, error: 'Project not initialized' };
      }

      const config = getYunxiaoEnvConfig(project);
      if (!config?.accessToken) {
        return { success: false, error: 'No Yunxiao access token configured' };
      }
      if (!config.enabled) {
        return { success: false, error: 'Yunxiao integration is disabled' };
      }

      try {
        const items = await fetchOpenYunxiaoBugWorkItems(config);
        const result = upsertYunxiaoIssuesFromWorkItems(project, items);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: formatYunxiaoError(error, 'workitems')
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_UPDATE_ISSUE,
    async (
      _,
      projectId: string,
      workItemId: string,
      updates: {
        localCategory?: string;
        localSeverity?: 'low' | 'medium' | 'high' | 'critical';
        localTags?: string[];
        localAnalysis?: string;
      }
    ): Promise<IPCResult<YunxiaoIssue>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      if (!project.autoBuildPath) {
        return { success: false, error: 'Project not initialized' };
      }

      try {
        const issue = updateYunxiaoIssueLocalFields(project, workItemId, updates || {});
        if (!issue) {
          return { success: false, error: 'Yunxiao issue not found' };
        }
        return { success: true, data: issue };
      } catch (error) {
        return {
          success: false,
          error: formatYunxiaoError(error, 'workitems')
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_ANALYZE_ISSUE,
    async (_, projectId: string, workItemId: string): Promise<IPCResult<string>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      if (!project.autoBuildPath) {
        return { success: false, error: 'Project not initialized' };
      }

      const safeWorkItemId = sanitizeText(workItemId || '', 120);
      if (!safeWorkItemId) {
        return { success: false, error: 'Missing Yunxiao work item id' };
      }

      try {
        const issues = listYunxiaoIssues(project);
        const issue = issues.find(item => item.workItemId === safeWorkItemId);
        if (!issue) {
          return { success: false, error: 'Yunxiao issue not found' };
        }

        const analysis = await generateYunxiaoIssueAnalysis(issue);
        return { success: true, data: analysis };
      } catch (error) {
        return {
          success: false,
          error: `Failed to generate issue analysis: ${normalizeErrorText(error)}`
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_LOAD_IMAGE,
    async (
      _,
      projectId: string,
      imageUrl: string,
      workItemId?: string
    ): Promise<IPCResult<string>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const config = getYunxiaoEnvConfig(project);
      if (!config) {
        return { success: false, error: 'No Yunxiao access token configured' };
      }

      const safeUrl = sanitizeUrl(imageUrl || '');
      if (!safeUrl) {
        return { success: false, error: 'Invalid image URL' };
      }

      try {
        const safeWorkItemId = sanitizeText(workItemId || '', 120);
        const dataUrl = await resolveYunxiaoImageToDataUrl(
          config,
          safeUrl,
          safeWorkItemId || undefined
        );
        return { success: true, data: dataUrl };
      } catch (error) {
        return {
          success: false,
          error: formatYunxiaoError(error, 'workitems')
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.YUNXIAO_IMPORT_WORK_ITEMS,
    async (
      _,
      projectId: string,
      workItemIds: string[],
      options?: { organizationId?: string; spaceId?: string; category?: string }
    ): Promise<IPCResult<YunxiaoImportResult>> => {
      const project = projectStore.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }
      if (!project.autoBuildPath) {
        return { success: false, error: 'Project not initialized' };
      }
      if (!Array.isArray(workItemIds) || workItemIds.length === 0) {
        return { success: false, error: 'No work items selected' };
      }

      const config = getYunxiaoEnvConfig(project);
      if (!config) {
        return { success: false, error: 'No Yunxiao access token configured' };
      }

      try {
        const details = await withYunxiaoClient(config, async (client) => {
          const org = await resolveOrganization(client, config, options?.organizationId);
          return Promise.all(
            workItemIds.map(async (workItemId) => {
              const raw = await callYunxiaoTool<unknown>(client, 'get_work_item', {
                organizationId: org.organizationId,
                workItemId
              });
              return normalizeWorkItems([raw])[0];
            })
          );
        });

        let imported = 0;
        let failed = 0;
        const errors: string[] = [];

        const specsBaseDir = getSpecsDir(project.autoBuildPath);
        const specsDir = path.join(project.path, specsBaseDir);
        if (!existsSync(specsDir)) {
          mkdirSync(specsDir, { recursive: true });
        }

        for (const item of details) {
          try {
            if (!item?.id) {
              throw new Error('Missing work item id');
            }

            const safeTitle = sanitizeText(item.subject || `Yunxiao ${item.id}`, 500);
            const safeIdentifier = sanitizeText(item.identifier || item.id, 120);
            const formattedDescription = formatYunxiaoDescriptionContent(item.description || '');
            const safeStatus = sanitizeText(item.status?.displayName || item.status?.name || '', 120);
            const safePriority = sanitizeText(item.priority || '', 120);
            const safeUrl = sanitizeUrl(item.url || '');

            const description = `# ${safeTitle}

**Yunxiao Work Item:** ${safeIdentifier}
${safeUrl ? `**Link:** ${safeUrl}` : ''}
${safePriority ? `**Priority:** ${safePriority}` : ''}
${safeStatus ? `**Status:** ${safeStatus}` : ''}

## Description

${formattedDescription}
`;

            let specNumber = 1;
            const existingDirs = readdirSync(specsDir, { withFileTypes: true })
              .filter(dir => dir.isDirectory())
              .map(dir => dir.name);
            const existingNumbers = existingDirs
              .map(name => {
                const match = name.match(/^(\d+)/);
                return match ? parseInt(match[1], 10) : 0;
              })
              .filter(num => num > 0);
            if (existingNumbers.length > 0) {
              specNumber = Math.max(...existingNumbers) + 1;
            }

            const specId = buildSpecId(specNumber, safeTitle, 'yunxiao');
            const specDir = path.join(specsDir, specId);
            mkdirSync(specDir, { recursive: true });

            const now = new Date().toISOString();
            const implementationPlan = {
              feature: safeTitle,
              description,
              created_at: now,
              updated_at: now,
              status: 'pending',
              phases: []
            };
            writeFileSync(
              path.join(specDir, AUTO_BUILD_PATHS.IMPLEMENTATION_PLAN),
              JSON.stringify(implementationPlan, null, 2),
              'utf-8'
            );

            const requirements = {
              task_description: description,
              workflow_type: 'feature'
            };
            writeFileSync(
              path.join(specDir, AUTO_BUILD_PATHS.REQUIREMENTS),
              JSON.stringify(requirements, null, 2),
              'utf-8'
            );

            const metadata: TaskMetadata = buildYunxiaoTaskMetadata({
              workItemId: sanitizeText(item.id, 120),
              identifier: safeIdentifier,
              url: safeUrl || undefined,
              workitemTypeName: item.workitemType?.name,
              workitemCategoryId: item.workitemType?.categoryId || item.categoryId,
              workitemCategoryName: item.workitemType?.name
            });
            writeFileSync(
              path.join(specDir, 'task_metadata.json'),
              JSON.stringify(metadata, null, 2),
              'utf-8'
            );

            agentManager.startSpecCreation(specId, project.path, description, specDir, metadata);
            imported++;
          } catch (error) {
            failed++;
            errors.push(
              `Failed to import ${item?.identifier || item?.id || 'work item'}: ${formatYunxiaoError(error, 'import')}`
            );
          }
        }

        return {
          success: true,
          data: {
            success: failed === 0,
            imported,
            failed,
            errors: errors.length > 0 ? errors : undefined
          }
        };
      } catch (error) {
        return {
          success: false,
          error: formatYunxiaoError(error, 'import')
        };
      }
    }
  );
}
