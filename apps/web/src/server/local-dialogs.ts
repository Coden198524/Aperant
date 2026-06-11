import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SelectDirectoryOptions {
  title?: string;
  defaultPath?: string;
}

export async function selectLocalDirectory(options: SelectDirectoryOptions = {}): Promise<string | null> {
  const title = options.title?.trim() || 'Select Project Directory';
  const defaultPath = options.defaultPath?.trim();

  if (process.platform === 'win32') {
    return selectDirectoryWindows(title, defaultPath);
  }

  if (process.platform === 'darwin') {
    return selectDirectoryMacOS(title, defaultPath);
  }

  return selectDirectoryLinux(title, defaultPath);
}

async function selectDirectoryWindows(title: string, defaultPath?: string): Promise<string | null> {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = ${toPowerShellString(title)}
$dialog.ShowNewFolderButton = $true
$defaultPath = ${toPowerShellString(defaultPath ?? '')}
if ($defaultPath -and (Test-Path -LiteralPath $defaultPath)) {
  $dialog.SelectedPath = $defaultPath
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.SelectedPath
}
$dialog.Dispose()
`;

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );

  return normalizeDialogOutput(stdout);
}

async function selectDirectoryMacOS(title: string, defaultPath?: string): Promise<string | null> {
  const defaultLocation = defaultPath
    ? ` default location POSIX file "${escapeAppleScript(defaultPath)}"`
    : '';
  const script = `POSIX path of (choose folder with prompt "${escapeAppleScript(title)}"${defaultLocation})`;

  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { encoding: 'utf8' });
    return normalizeDialogOutput(stdout);
  } catch {
    return null;
  }
}

async function selectDirectoryLinux(title: string, defaultPath?: string): Promise<string | null> {
  const attempts: Array<{ command: string; args: string[] }> = [
    {
      command: 'zenity',
      args: [
        '--file-selection',
        '--directory',
        `--title=${title}`,
        ...(defaultPath ? [`--filename=${defaultPath.replace(/\/?$/, '/')}`] : []),
      ],
    },
    {
      command: 'kdialog',
      args: ['--getexistingdirectory', defaultPath ?? '.', title],
    },
    {
      command: 'yad',
      args: [
        '--file-selection',
        '--directory',
        `--title=${title}`,
        ...(defaultPath ? [`--filename=${defaultPath.replace(/\/?$/, '/')}`] : []),
      ],
    },
  ];

  for (const attempt of attempts) {
    try {
      const { stdout } = await execFileAsync(attempt.command, attempt.args, { encoding: 'utf8' });
      return normalizeDialogOutput(stdout);
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code !== 'ENOENT') return null;
    }
  }

  throw new Error('No supported directory picker is available. Install zenity, kdialog, or yad.');
}

function normalizeDialogOutput(stdout: string | Buffer): string | null {
  const value = stdout.toString('utf8').trim();
  return value || null;
}

function toPowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
