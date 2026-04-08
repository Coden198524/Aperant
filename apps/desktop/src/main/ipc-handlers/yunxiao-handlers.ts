import { ipcMain, app } from 'electron';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS, getSpecsDir, AUTO_BUILD_PATHS } from '../../shared/constants';
import type {
  IPCResult,
  Project,
  TaskMetadata,
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
import { AgentManager } from '../agent';

const DEFAULT_TOOLSETS = 'organization-management,project-management';
const DEFAULT_WORKITEM_CATEGORY = 'Task';
const DEFAULT_MCP_COMMAND = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const DEFAULT_MCP_ARGS = ['-y', 'alibabacloud-devops-mcp-server'];
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

interface YunxiaoEnvConfig {
  accessToken: string;
  organizationId?: string;
  projectId?: string;
  workitemCategory: string;
  toolsets: string;
  mcpCommand: string;
  mcpArgs: string[];
  mcpNpmCache?: string;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function getString(record: Record<string, unknown> | null, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeErrorText(error: unknown): string {
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

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isPermissionError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('insufficient permissions')
    || lower.includes('permission denied')
    || lower.includes('forbidden')
    || lower.includes('status code 403')
    || /\b403\b/.test(lower);
}

function isUnauthorizedError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('unauthorized')
    || lower.includes('invalid token')
    || lower.includes('authentication')
    || lower.includes('status code 401')
    || /\b401\b/.test(lower);
}

function isNetworkError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('timeout')
    || lower.includes('timed out')
    || lower.includes('econnreset')
    || lower.includes('enotfound')
    || lower.includes('network')
    || lower.includes('fetch failed')
    || lower.includes('socket hang up');
}

function parseMcpArgs(raw?: string): string[] {
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

function normalizeToolsets(raw?: string): string {
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

function formatYunxiaoError(
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

function getYunxiaoEnvConfig(project: Project): YunxiaoEnvConfig | null {
  if (!project.autoBuildPath) return null;
  const envPath = path.join(project.path, project.autoBuildPath, '.env');
  if (!existsSync(envPath)) return null;

  try {
    const content = readFileSync(envPath, 'utf-8');
    const vars = parseEnvFile(content);
    const accessToken = vars['YUNXIAO_ACCESS_TOKEN']?.trim();
    if (!accessToken) return null;

    return {
      accessToken,
      organizationId: vars['YUNXIAO_ORGANIZATION_ID']?.trim() || undefined,
      projectId: vars['YUNXIAO_PROJECT_ID']?.trim() || undefined,
      workitemCategory: vars['YUNXIAO_WORKITEM_CATEGORY']?.trim() || DEFAULT_WORKITEM_CATEGORY,
      toolsets: normalizeToolsets(vars['DEVOPS_TOOLSETS']),
      mcpCommand: vars['YUNXIAO_MCP_COMMAND']?.trim() || DEFAULT_MCP_COMMAND,
      mcpArgs: parseMcpArgs(vars['YUNXIAO_MCP_ARGS']),
      mcpNpmCache: vars['YUNXIAO_MCP_NPM_CACHE']?.trim() || undefined
    };
  } catch {
    return null;
  }
}

function createYunxiaoTransport(config: YunxiaoEnvConfig): StdioClientTransport {
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

async function withYunxiaoClient<T>(
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

function parseToolResult(result: unknown): unknown {
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

async function callYunxiaoTool<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const response = await client.callTool({ name, arguments: args });
  return parseToolResult(response) as T;
}

async function resolveOrganization(
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

function normalizeProjects(raw: unknown): YunxiaoProject[] {
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

function normalizeWorkItems(raw: unknown): YunxiaoWorkItem[] {
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
      description: getString(record, 'description'),
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

function safeSlugFromTitle(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
  return slug || fallback;
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
                category: config.workitemCategory || DEFAULT_WORKITEM_CATEGORY,
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

          const raw = await callYunxiaoTool<unknown>(client, 'search_workitems', {
            organizationId: org.organizationId,
            category: preferredCategory || config.workitemCategory || DEFAULT_WORKITEM_CATEGORY,
            spaceId,
            page: 1,
            perPage: 200,
            sort: 'desc',
            orderBy: 'gmtCreate',
            includeDetails: true
          });

          return normalizeWorkItems(raw);
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
            const safeDescription = sanitizeText(item.description || '', 50000, true);
            const safeStatus = sanitizeText(item.status?.displayName || item.status?.name || '', 120);
            const safePriority = sanitizeText(item.priority || '', 120);
            const safeUrl = sanitizeUrl(item.url || '');

            const description = `# ${safeTitle}

**Yunxiao Work Item:** ${safeIdentifier}
${safeUrl ? `**Link:** ${safeUrl}` : ''}
${safePriority ? `**Priority:** ${safePriority}` : ''}
${safeStatus ? `**Status:** ${safeStatus}` : ''}

## Description

${safeDescription || 'No description provided.'}
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

            const slugFallback = `yunxiao-${String(specNumber).padStart(3, '0')}`;
            const slugifiedTitle = safeSlugFromTitle(safeTitle, slugFallback);
            const specId = `${String(specNumber).padStart(3, '0')}-${slugifiedTitle}`;
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

            const metadata: TaskMetadata = {
              sourceType: 'yunxiao',
              yunxiaoWorkItemId: sanitizeText(item.id, 120),
              yunxiaoIdentifier: safeIdentifier,
              yunxiaoUrl: safeUrl || undefined,
              category: 'feature'
            };
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
