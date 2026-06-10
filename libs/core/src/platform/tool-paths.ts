import { existsSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OS, ShellType, type BinaryDirectories, type PathConfig, type ShellConfig } from './types.js';

export function getCurrentOS(): OS {
  const platform = process.platform;
  if (platform === OS.Windows || platform === OS.macOS || platform === OS.Linux) {
    return platform as OS;
  }
  return OS.Linux;
}

export function isWindows(): boolean {
  return process.platform === OS.Windows;
}

export function isMacOS(): boolean {
  return process.platform === OS.macOS;
}

export function isLinux(): boolean {
  return process.platform === OS.Linux;
}

export function isUnix(): boolean {
  return !isWindows();
}

export function getPathConfig(): PathConfig {
  if (isWindows()) {
    return {
      separator: path.sep,
      delimiter: ';',
      executableExtensions: ['.exe', '.cmd', '.bat', '.ps1'],
    };
  }

  return {
    separator: path.sep,
    delimiter: ':',
    executableExtensions: [''],
  };
}

export function getPathDelimiter(): string {
  return isWindows() ? ';' : ':';
}

export function getExecutableExtension(): string {
  return isWindows() ? '.exe' : '';
}

export function withExecutableExtension(baseName: string): string {
  if (!baseName) return baseName;

  const ext = path.extname(baseName);
  if (ext) return baseName;

  const exeExt = getExecutableExtension();
  return exeExt ? `${baseName}${exeExt}` : baseName;
}

export function getBinaryDirectories(): BinaryDirectories {
  const homeDir = os.homedir();

  if (isWindows()) {
    return {
      user: [
        path.join(homeDir, 'AppData', 'Local', 'Programs'),
        path.join(homeDir, 'AppData', 'Roaming', 'npm'),
        path.join(homeDir, '.local', 'bin'),
      ],
      system: [
        process.env.ProgramFiles || 'C:\\Program Files',
        process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
      ],
    };
  }

  if (isMacOS()) {
    return {
      user: [
        path.join(homeDir, '.local', 'bin'),
        path.join(homeDir, 'bin'),
      ],
      system: [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
      ],
    };
  }

  return {
    user: [
      path.join(homeDir, '.local', 'bin'),
      path.join(homeDir, 'bin'),
    ],
    system: [
      '/usr/bin',
      '/usr/local/bin',
      '/snap/bin',
    ],
  };
}

export function getHomebrewPath(): string | null {
  if (!isMacOS()) return null;

  const homebrewPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];

  for (const brewPath of homebrewPaths) {
    if (existsSync(brewPath)) {
      return brewPath;
    }
  }

  return homebrewPaths[0];
}

export function getShellConfig(preferredShell?: ShellType): ShellConfig {
  if (isWindows()) {
    return getWindowsShellConfig(preferredShell);
  }

  return getUnixShellConfig();
}

function getWindowsShellConfig(preferredShell?: ShellType): ShellConfig {
  const homeDir = os.homedir();

  const shellPaths: Record<ShellType, string[]> = {
    [ShellType.PowerShell]: [
      path.join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      path.join(homeDir, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ],
    [ShellType.CMD]: [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    ],
    [ShellType.Bash]: [
      path.join('C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join('C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      path.join('C:\\msys64', 'usr', 'bin', 'bash.exe'),
      path.join('C:\\cygwin64', 'bin', 'bash.exe'),
    ],
    [ShellType.Zsh]: [],
    [ShellType.Fish]: [],
    [ShellType.Unknown]: [],
  };

  const shellType = preferredShell || ShellType.PowerShell;
  const candidates = shellPaths[shellType] || shellPaths[ShellType.PowerShell];

  for (const shellPath of candidates) {
    if (existsSync(shellPath)) {
      return {
        executable: shellPath,
        args: shellType === ShellType.Bash ? ['--login'] : [],
        env: {},
      };
    }
  }

  return {
    executable: process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: [],
    env: {},
  };
}

function getUnixShellConfig(): ShellConfig {
  const shellPath = process.env.SHELL || '/bin/zsh';

  return {
    executable: shellPath,
    args: ['-l'],
    env: {},
  };
}

export function requiresShell(command: string): boolean {
  if (!isWindows()) return false;

  const ext = path.extname(command).toLowerCase();
  return ['.cmd', '.bat', '.ps1'].includes(ext);
}

export function getNpmCommand(): string {
  return isWindows() ? 'npm.cmd' : 'npm';
}

export function getNpxCommand(): string {
  return isWindows() ? 'npx.cmd' : 'npx';
}

export function isSecurePath(candidatePath: string): boolean {
  if (!candidatePath || !candidatePath.trim()) return false;

  const dangerousPatterns = [
    /[;&|`${}[\]<>!"^]/,
    /%[^%]+%/,
    /\.\.\//,
    /\.\.\\/,
    /[\r\n\x00]/,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(candidatePath)) {
      return false;
    }
  }

  if (isWindows()) {
    const basename = path.basename(candidatePath, getExecutableExtension());
    return /^[\w.-]+$/.test(basename);
  }

  return true;
}

export function normalizePath(inputPath: string): string {
  return path.normalize(inputPath);
}

export function joinPaths(...parts: string[]): string {
  return path.join(...parts);
}

export function getEnvVar(name: string): string | undefined {
  if (isWindows()) {
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase() === name.toLowerCase()) {
        return process.env[key];
      }
    }
    return undefined;
  }

  return process.env[name];
}

export function findExecutable(name: string, additionalPaths: string[] = []): string | null {
  const config = getPathConfig();
  const searchPaths: string[] = [];

  const pathEnv = getEnvVar('PATH') || '';
  searchPaths.push(...pathEnv.split(config.delimiter).filter(Boolean));

  const bins = getBinaryDirectories();
  searchPaths.push(...bins.user, ...bins.system);

  searchPaths.push(...additionalPaths);

  const extensions = [...config.executableExtensions];

  for (const searchDir of searchPaths) {
    for (const ext of extensions) {
      const fullPath = path.join(searchDir, `${name}${ext}`);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

export function getPlatformDescription(): string {
  const currentOS = getCurrentOS();
  const osName = {
    [OS.Windows]: 'Windows',
    [OS.macOS]: 'macOS',
    [OS.Linux]: 'Linux',
  }[currentOS] || process.platform;

  const arch = os.arch();
  return `${osName} (${arch})`;
}

export function getClaudeExecutablePath(): string[] {
  const homeDir = os.homedir();
  const paths: string[] = [];

  if (isWindows()) {
    paths.push(
      joinPaths(homeDir, 'AppData', 'Local', 'Programs', 'claude', `claude${getExecutableExtension()}`),
      joinPaths(homeDir, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
      joinPaths(homeDir, '.local', 'bin', `claude${getExecutableExtension()}`),
      joinPaths('C:\\Program Files', 'Claude', `claude${getExecutableExtension()}`),
      joinPaths('C:\\Program Files (x86)', 'Claude', `claude${getExecutableExtension()}`),
    );
  } else {
    paths.push(
      joinPaths(homeDir, '.local', 'bin', 'claude'),
      joinPaths(homeDir, 'bin', 'claude'),
    );

    if (isMacOS()) {
      const brewPath = getHomebrewPath();
      if (brewPath) {
        paths.push(joinPaths(brewPath, 'claude'));
      }
    }
  }

  return paths;
}

export function getPythonCommands(): string[][] {
  if (isWindows()) {
    return [['py', '-3'], ['python'], ['python3'], ['py']];
  }
  return [['python3'], ['python']];
}

function expandDirPattern(parentDir: string, pattern: string): string[] {
  if (!existsSync(parentDir)) {
    return [];
  }

  try {
    const regexPattern = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`, 'i');
    const entries = readdirSync(parentDir, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory() && regexPattern.test(entry.name))
      .map((entry) => joinPaths(parentDir, entry.name));
  } catch {
    return [];
  }
}

export function getPythonPaths(): string[] {
  const homeDir = os.homedir();
  const paths: string[] = [];

  if (isWindows()) {
    const userPythonPath = joinPaths(homeDir, 'AppData', 'Local', 'Programs', 'Python');
    if (existsSync(userPythonPath)) {
      paths.push(userPythonPath);
    }

    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    paths.push(...expandDirPattern(programFiles, 'Python3*'));
    paths.push(...expandDirPattern(programFilesX86, 'Python3*'));
  } else if (isMacOS()) {
    const brewPath = getHomebrewPath();
    if (brewPath) {
      paths.push(brewPath);
    }
  }

  return paths;
}

export function getGitExecutablePath(): string {
  if (isWindows()) {
    const candidates = [
      joinPaths('C:\\Program Files', 'Git', 'bin', 'git.exe'),
      joinPaths('C:\\Program Files (x86)', 'Git', 'bin', 'git.exe'),
      joinPaths(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'git.exe'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return 'git';
}

export function getNodeExecutablePath(): string {
  return isWindows() ? 'node.exe' : 'node';
}

export function getWindowsShellPaths(): Record<string, string[]> {
  if (!isWindows()) {
    return {};
  }

  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';

  return {
    powershell: [
      path.join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ],
    windowsterminal: [
      path.join('C:\\Program Files', 'WindowsApps', 'Microsoft.WindowsTerminal_*', 'WindowsTerminal.exe'),
    ],
    cmd: [
      path.join(systemRoot, 'System32', 'cmd.exe'),
    ],
    gitbash: [
      path.join('C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join('C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    ],
    cygwin: [
      path.join('C:\\cygwin64', 'bin', 'bash.exe'),
    ],
    msys2: [
      path.join('C:\\msys64', 'usr', 'bin', 'bash.exe'),
    ],
    wsl: [
      path.join(systemRoot, 'System32', 'wsl.exe'),
    ],
  };
}

export function expandWindowsEnvVars(pathPattern: string): string {
  if (!isWindows()) {
    return pathPattern;
  }

  const homeDir = os.homedir();
  const envVars: Record<string, string | undefined> = {
    '%PROGRAMFILES%': process.env.ProgramFiles || 'C:\\Program Files',
    '%PROGRAMFILES(X86)%': process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    '%LOCALAPPDATA%': process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'),
    '%APPDATA%': process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'),
    '%USERPROFILE%': process.env.USERPROFILE || homeDir,
    '%SYSTEMROOT%': process.env.SystemRoot || 'C:\\Windows',
    '%TEMP%': process.env.TEMP || process.env.TMP || path.join(homeDir, 'AppData', 'Local', 'Temp'),
    '%TMP%': process.env.TMP || process.env.TEMP || path.join(homeDir, 'AppData', 'Local', 'Temp'),
  };

  let expanded = pathPattern;
  for (const [pattern, value] of Object.entries(envVars)) {
    if (value) {
      expanded = expanded.replace(new RegExp(pattern, 'gi'), value);
    }
  }

  return expanded;
}

export function getOllamaExecutablePaths(): string[] {
  const homeDir = os.homedir();
  const paths: string[] = [];

  if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA || joinPaths(homeDir, 'AppData', 'Local');
    paths.push(
      joinPaths(localAppData, 'Programs', 'Ollama', 'ollama.exe'),
      joinPaths(localAppData, 'Ollama', 'ollama.exe'),
      joinPaths('C:\\Program Files', 'Ollama', 'ollama.exe'),
      joinPaths('C:\\Program Files (x86)', 'Ollama', 'ollama.exe'),
    );
  } else if (isMacOS()) {
    paths.push(
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      joinPaths(homeDir, '.local', 'bin', 'ollama'),
    );
  } else {
    paths.push(
      '/usr/local/bin/ollama',
      '/usr/bin/ollama',
      joinPaths(homeDir, '.local', 'bin', 'ollama'),
    );
  }

  return paths;
}

export function getOllamaInstallCommand(): string {
  if (isWindows()) {
    return 'winget install --id Ollama.Ollama --accept-source-agreements';
  }
  if (isMacOS()) {
    return 'brew install ollama';
  }
  return 'curl -fsSL https://ollama.com/install.sh | sh';
}

export function getWhichCommand(): string {
  return isWindows() ? getWhereExePath() : 'which';
}

export function getWindowsToolPath(toolName: string, subPath?: string): string[] {
  if (!isWindows()) {
    return [];
  }

  const homeDir = os.homedir();
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const appData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');

  const paths: string[] = [];

  if (subPath) {
    paths.push(
      path.join(programFiles, subPath),
      path.join(programFilesX86, subPath),
    );
  } else {
    paths.push(
      path.join(programFiles, toolName),
      path.join(programFilesX86, toolName),
    );
  }

  paths.push(path.join(appData, toolName));

  const roamingAppData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  paths.push(path.join(roamingAppData, 'npm'));

  return paths;
}

export function getSystemRoot(): string {
  return process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
}

export function getWhereExePath(): string {
  return path.join(getSystemRoot(), 'System32', 'where.exe');
}

export function getTaskkillExePath(): string {
  return path.join(getSystemRoot(), 'System32', 'taskkill.exe');
}
