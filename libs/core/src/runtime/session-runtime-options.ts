import type { AutocodeTaskWorkflowMode } from '../tasks/spec-store.js';

export type AutocodeRuntimePhaseStepBudgets = Partial<Record<'spec' | 'planning' | 'coding' | 'qa', number>>;

export interface AutocodeCustomMcpServer {
  id: string;
  name: string;
  type: 'command' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  description?: string;
}

export interface AutocodeSessionMcpOptions {
  context7Enabled?: boolean;
  memoryEnabled?: boolean;
  linearEnabled?: boolean;
  yunxiaoEnabled?: boolean;
  electronMcpEnabled?: boolean;
  puppeteerMcpEnabled?: boolean;
  projectCapabilities?: {
    is_electron?: boolean;
    is_web_frontend?: boolean;
  };
  agentMcpAdd?: string;
  agentMcpRemove?: string;
  customMcpServers?: AutocodeCustomMcpServer[];
  mcpEnv?: Record<string, string>;
}

export interface AutocodeSessionRuntimeOptions {
  maxSteps: number;
  phaseStepBudgets?: AutocodeRuntimePhaseStepBudgets;
  mcpOptions: AutocodeSessionMcpOptions;
}

export interface BuildAutocodeSessionRuntimeOptionsInput {
  workflowMode: AutocodeTaskWorkflowMode | string | undefined;
  agentType: string;
  env: Record<string, string>;
}

export const AUTOCODE_DEFAULT_SESSION_MAX_STEPS = 160;
export const AUTOCODE_DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS = {
  spec: 80,
  planning: 90,
  coding: 140,
  qa: 50,
} as const;

export const AUTOCODE_AGGRESSIVE_WORKFLOW_PHASE_STEP_BUDGETS = {
  spec: 50,
  planning: 55,
  coding: 80,
  qa: 30,
} as const;

export const AUTOCODE_DIRECT_WORKFLOW_PHASE_STEP_BUDGETS = {
  spec: 0,
  planning: 0,
  coding: 60,
  qa: 0,
} as const;

export function buildAutocodeSessionRuntimeOptions(
  input: BuildAutocodeSessionRuntimeOptionsInput,
): AutocodeSessionRuntimeOptions {
  const env = input.env;
  const context7Enabled = parseAutocodeBooleanEnv(env.CONTEXT7_ENABLED, true);
  const linearMcpEnabled = parseAutocodeBooleanEnv(env.LINEAR_MCP_ENABLED, true);
  const linearEnabled = Boolean(env.LINEAR_API_KEY) && linearMcpEnabled;
  const yunxiaoMcpEnabled = parseAutocodeBooleanEnv(env.YUNXIAO_MCP_ENABLED, true);
  const yunxiaoIntegrationEnabled = parseAutocodeBooleanEnv(
    env.YUNXIAO_ENABLED,
    Boolean(env.YUNXIAO_ACCESS_TOKEN),
  );
  const yunxiaoEnabled = Boolean(env.YUNXIAO_ACCESS_TOKEN)
    && yunxiaoIntegrationEnabled
    && yunxiaoMcpEnabled;
  const memoryToggleEnabled = parseAutocodeBooleanEnv(env.GRAPHITI_ENABLED, true);
  const memoryEnabled = memoryToggleEnabled && Boolean(env.GRAPHITI_MCP_URL);
  const electronMcpEnabled = parseAutocodeBooleanEnv(env.ELECTRON_MCP_ENABLED, false);
  const puppeteerMcpEnabled = parseAutocodeBooleanEnv(env.PUPPETEER_MCP_ENABLED, false);
  const agentMcpAdd = env[`AGENT_MCP_${input.agentType}_ADD`];
  const agentMcpRemove = env[`AGENT_MCP_${input.agentType}_REMOVE`];
  const customMcpServers = parseAutocodeCustomMcpServers(env.CUSTOM_MCP_SERVERS);

  if (input.workflowMode === 'aggressive') {
    return {
      maxSteps: AUTOCODE_AGGRESSIVE_WORKFLOW_PHASE_STEP_BUDGETS.coding,
      phaseStepBudgets: AUTOCODE_AGGRESSIVE_WORKFLOW_PHASE_STEP_BUDGETS,
      mcpOptions: {
        context7Enabled: false,
        memoryEnabled: false,
        linearEnabled: false,
        yunxiaoEnabled: false,
        electronMcpEnabled: false,
        puppeteerMcpEnabled: false,
        agentMcpAdd,
        agentMcpRemove,
        customMcpServers,
        mcpEnv: env,
      },
    };
  }

  if (input.workflowMode === 'off') {
    return {
      maxSteps: AUTOCODE_DIRECT_WORKFLOW_PHASE_STEP_BUDGETS.coding,
      phaseStepBudgets: AUTOCODE_DIRECT_WORKFLOW_PHASE_STEP_BUDGETS,
      mcpOptions: {
        context7Enabled: false,
        memoryEnabled: false,
        linearEnabled: false,
        yunxiaoEnabled: false,
        electronMcpEnabled: false,
        puppeteerMcpEnabled: false,
        customMcpServers: [],
        mcpEnv: env,
      },
    };
  }

  return {
    maxSteps: AUTOCODE_DEFAULT_SESSION_MAX_STEPS,
    phaseStepBudgets: AUTOCODE_DEFAULT_WORKFLOW_PHASE_STEP_BUDGETS,
    mcpOptions: {
      context7Enabled,
      memoryEnabled,
      linearEnabled,
      yunxiaoEnabled,
      electronMcpEnabled,
      puppeteerMcpEnabled,
      agentMcpAdd,
      agentMcpRemove,
      customMcpServers,
      mcpEnv: env,
    },
  };
}

export function parseAutocodeBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value === '') {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
}

export function parseAutocodeCustomMcpServers(raw: string | undefined): AutocodeCustomMcpServer[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry): AutocodeCustomMcpServer | null => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const candidate = entry as Partial<AutocodeCustomMcpServer>;
        if (!candidate.id || !candidate.name || !candidate.type) {
          return null;
        }

        if (candidate.type === 'command') {
          if (!candidate.command) {
            return null;
          }
          return {
            id: String(candidate.id),
            name: String(candidate.name),
            type: 'command',
            command: String(candidate.command),
            args: Array.isArray(candidate.args) ? candidate.args.map(String) : [],
            description: candidate.description ? String(candidate.description) : undefined,
          };
        }

        if (candidate.type === 'http') {
          if (!candidate.url) {
            return null;
          }
          return {
            id: String(candidate.id),
            name: String(candidate.name),
            type: 'http',
            url: String(candidate.url),
            headers: candidate.headers && typeof candidate.headers === 'object'
              ? Object.fromEntries(
                  Object.entries(candidate.headers).map(([key, value]) => [String(key), String(value)]),
                )
              : undefined,
            description: candidate.description ? String(candidate.description) : undefined,
          };
        }

        return null;
      })
      .filter((server): server is AutocodeCustomMcpServer => server !== null);
  } catch {
    return [];
  }
}
