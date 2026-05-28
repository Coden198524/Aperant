export interface ProcessStartOptions {
  runtimeId: string;
  taskId: string;
  command: string;
  args: string[];
  cwd?: string;
  shell?: boolean;
  shellCommand?: string;
}

export type ProcessStartStatus = 'started' | 'completed' | 'failed';

export interface ProcessStartResult {
  status: ProcessStartStatus;
  exitCode?: number | null;
  signal?: string | null;
  message?: string;
}

export interface ProcessAdapter {
  startProcess(options: ProcessStartOptions): Promise<ProcessStartResult> | ProcessStartResult;
  stopProcess?(runtimeId: string): Promise<void> | void;
  isProcessRunning?(runtimeId: string): boolean;
}
