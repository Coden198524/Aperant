export interface TaskExecutionAdapter {
  startTask(options: {
    taskId: string;
    command: string;
    cwd?: string;
  }): Promise<void>;
  stopTask(taskId: string): Promise<void>;
}
