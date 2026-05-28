/**
 * Project Analysis Types
 * ======================
 *
 * Data structures for representing technology stacks,
 * custom scripts, and security profiles for project analysis.
 *
 * See apps/desktop/src/main/ai/project/types.ts for the TypeScript implementation.
 */

// ---------------------------------------------------------------------------
// Technology Stack
// ---------------------------------------------------------------------------

export interface TechnologyStack {
  languages: string[];
  packageManagers: string[];
  frameworks: string[];
  databases: string[];
  infrastructure: string[];
  cloudProviders: string[];
  codeQualityTools: string[];
  versionManagers: string[];
}

export function createTechnologyStack(): TechnologyStack {
  return {
    languages: [],
    packageManagers: [],
    frameworks: [],
    databases: [],
    infrastructure: [],
    cloudProviders: [],
    codeQualityTools: [],
    versionManagers: [],
  };
}

// ---------------------------------------------------------------------------
// Custom Scripts
// ---------------------------------------------------------------------------

export interface CustomScripts {
  npmScripts: string[];
  makeTargets: string[];
  poetryScripts: string[];
  cargoAliases: string[];
  shellScripts: string[];
}

export function createCustomScripts(): CustomScripts {
  return {
    npmScripts: [],
    makeTargets: [],
    poetryScripts: [],
    cargoAliases: [],
    shellScripts: [],
  };
}

// ---------------------------------------------------------------------------
// Security Profile (for project analyzer output)
// ---------------------------------------------------------------------------

export interface ProjectSecurityProfile {
  baseCommands: Set<string>;
  stackCommands: Set<string>;
  scriptCommands: Set<string>;
  customCommands: Set<string>;
  detectedStack: TechnologyStack;
  customScripts: CustomScripts;
  projectDir: string;
  createdAt: string;
  projectHash: string;
  inheritedFrom: string;
  getAllAllowedCommands(): Set<string>;
}

export function createProjectSecurityProfile(): ProjectSecurityProfile {
  return {
    baseCommands: new Set<string>(),
    stackCommands: new Set<string>(),
    scriptCommands: new Set<string>(),
    customCommands: new Set<string>(),
    detectedStack: createTechnologyStack(),
    customScripts: createCustomScripts(),
    projectDir: '',
    createdAt: '',
    projectHash: '',
    inheritedFrom: '',
    getAllAllowedCommands(): Set<string> {
      return new Set([
        ...this.baseCommands,
        ...this.stackCommands,
        ...this.scriptCommands,
        ...this.customCommands,
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// Serialized form for disk storage
// ---------------------------------------------------------------------------

export interface SerializedSecurityProfile {
  base_commands: string[];
  stack_commands: string[];
  script_commands: string[];
  custom_commands: string[];
  detected_stack: {
    languages: string[];
    package_managers: string[];
    frameworks: string[];
    databases: string[];
    infrastructure: string[];
    cloud_providers: string[];
    code_quality_tools: string[];
    version_managers: string[];
  };
  custom_scripts: {
    npm_scripts: string[];
    make_targets: string[];
    poetry_scripts: string[];
    cargo_aliases: string[];
    shell_scripts: string[];
  };
  project_dir: string;
  created_at: string;
  project_hash: string;
  inherited_from?: string;
}

// ---------------------------------------------------------------------------
// Project index
// ---------------------------------------------------------------------------

export interface ProjectIndex {
  project_root: string;
  project_type: 'single' | 'monorepo';
  services: Record<string, ServiceInfo>;
  infrastructure: InfrastructureInfo;
  conventions: ConventionsInfo;
  source_summary?: ProjectSourceSummary;
}

export interface ProjectSourceSummary {
  source_file_count?: number;
  total_file_count?: number;
  languages?: string[];
  build_files?: string[];
  project_files?: string[];
  config_files?: string[];
  root_directories?: string[];
}

export interface ServiceInfo {
  name: string;
  path: string;
  language?: string;
  languages?: string[];
  framework?: string;
  type?: 'backend' | 'frontend' | 'worker' | 'scraper' | 'library' | 'proxy' | 'mobile' | 'desktop' | 'unknown';
  package_manager?: string;
  default_port?: number;
  entry_point?: string;
  key_directories?: Record<string, { path: string; purpose: string }>;
  dependencies?: string[];
  dev_dependencies?: string[];
  testing?: string;
  e2e_testing?: string;
  test_directory?: string;
  orm?: string;
  task_queue?: string;
  styling?: string;
  state_management?: string;
  build_tool?: string;
  apple_frameworks?: string[];
  spm_dependencies?: string[];
  dockerfile?: string;
  consumes?: string[];
  environment?: {
    detected_count: number;
    variables: Record<string, {
      type: string;
      sensitive: boolean;
      required: boolean;
    }>;
  };
  api?: {
    total_routes: number;
    routes: Array<{
      path: string;
      methods: string[];
      requires_auth?: boolean;
    }>;
  };
  database?: {
    total_models: number;
    model_names: string[];
    models: Record<string, {
      orm: string;
      fields: Record<string, unknown>;
    }>;
  };
  services?: {
    databases?: Array<{
      type?: string;
      client?: string;
    }>;
    email?: Array<{
      provider?: string;
      client?: string;
    }>;
    payments?: Array<{
      provider?: string;
      client?: string;
    }>;
    cache?: Array<{
      type?: string;
      client?: string;
    }>;
  };
  monitoring?: {
    metrics_endpoint?: string;
    metrics_type?: string;
    health_checks?: string[];
  };
}

export interface InfrastructureInfo {
  docker_compose?: string;
  docker_services?: string[];
  dockerfile?: string;
  docker_directory?: string;
  dockerfiles?: string[];
  ci?: string;
  ci_workflows?: string[];
  deployment?: string;
}

export interface ConventionsInfo {
  python_linting?: string;
  python_formatting?: string;
  js_linting?: string;
  formatting?: string;
  typescript?: boolean;
  git_hooks?: string;
}
