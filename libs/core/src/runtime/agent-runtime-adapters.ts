import type {
  AgentRuntimeAdapter,
  NotificationAdapter,
  ProcessAdapter,
  TerminalAdapter,
} from '../platform/interfaces/index.js';
import type {
  AutocodeAgentRuntimeStartRequest,
  AutocodeAgentRuntimeStartResult,
  AutocodeAgentRuntimeStartStatus,
} from './agent-runtime.js';

export interface CreateTerminalAgentRuntimeAdapterInput {
  terminal: TerminalAdapter;
  notification?: NotificationAdapter;
}

export interface CreateProcessAgentRuntimeAdapterInput {
  process: ProcessAdapter;
  notification?: NotificationAdapter;
}

export function createTerminalAgentRuntimeAdapter(
  input: CreateTerminalAgentRuntimeAdapterInput,
): AgentRuntimeAdapter {
  const terminalNamesByTask = new Map<string, string>();

  return {
    async startRuntime(request: AutocodeAgentRuntimeStartRequest): Promise<AutocodeAgentRuntimeStartResult> {
      const terminalCommand = request.runner?.terminal;
      if (!terminalCommand) {
        throw new Error('Agent runtime start request does not include a terminal command.');
      }

      await input.notification?.info(request.messages.starting);
      await input.terminal.runCommand(terminalCommand);
      rememberRuntimeTerminal(terminalNamesByTask, request, terminalCommand.name);
      await input.notification?.info(request.messages.started);

      return {
        runtimeId: request.runtimeId,
        status: 'started',
        message: request.messages.started,
        terminalName: terminalCommand.name,
      };
    },

    async stopRuntime(taskId: string): Promise<void> {
      const terminalName = terminalNamesByTask.get(taskId);
      if (!terminalName) {
        return;
      }

      await input.terminal.dispose?.(terminalName);
      deleteMapEntriesByValue(terminalNamesByTask, terminalName);
    },

    isRuntimeRunning(taskId: string): boolean {
      return terminalNamesByTask.has(taskId);
    },
  };
}

export function createProcessAgentRuntimeAdapter(
  input: CreateProcessAgentRuntimeAdapterInput,
): AgentRuntimeAdapter {
  const runningRuntimeIds = new Set<string>();
  const runtimeIdsByTask = new Map<string, string>();

  return {
    async startRuntime(request: AutocodeAgentRuntimeStartRequest): Promise<AutocodeAgentRuntimeStartResult> {
      const processCommand = request.runner?.process;
      if (!processCommand) {
        throw new Error('Agent runtime start request does not include a process command.');
      }

      runningRuntimeIds.add(request.runtimeId);
      runtimeIdsByTask.set(request.plan.taskId, request.runtimeId);
      runtimeIdsByTask.set(request.plan.specId, request.runtimeId);
      let keepRuntimeRunning = false;

      try {
        await input.notification?.info(request.messages.starting);
        const processResult = await input.process.startProcess({
          runtimeId: request.runtimeId,
          taskId: request.plan.taskId,
          command: processCommand.command,
          args: processCommand.args,
          cwd: processCommand.cwd,
          shell: processCommand.shell,
          shellCommand: processCommand.shellCommand,
        });
        const status = normalizeProcessStatus(processResult.status, processResult.exitCode);
        keepRuntimeRunning = status === 'started';
        const message = status === 'failed'
          ? formatFailedMessage(request, processResult.message, processResult.exitCode, processResult.signal)
          : status === 'completed'
            ? request.messages.completed
            : request.messages.started;

        if (status === 'failed') {
          await input.notification?.error(message);
        } else {
          await input.notification?.info(message);
        }

        return {
          runtimeId: request.runtimeId,
          status,
          message,
          process: {
            status,
            exitCode: processResult.exitCode,
            signal: processResult.signal,
            message: processResult.message,
          },
        };
      } finally {
        if (!keepRuntimeRunning) {
          runningRuntimeIds.delete(request.runtimeId);
          deleteMapEntriesByValue(runtimeIdsByTask, request.runtimeId);
        }
      }
    },

    async stopRuntime(taskId: string): Promise<void> {
      const runtimeId = runtimeIdsByTask.get(taskId);
      if (!runtimeId) {
        return;
      }

      await input.process.stopProcess?.(runtimeId);
      runningRuntimeIds.delete(runtimeId);
      deleteMapEntriesByValue(runtimeIdsByTask, runtimeId);
    },

    isRuntimeRunning(taskId: string): boolean {
      const runtimeId = runtimeIdsByTask.get(taskId);
      return runtimeId ? runningRuntimeIds.has(runtimeId) : false;
    },
  };
}

function deleteMapEntriesByValue(map: Map<string, string>, value: string): void {
  for (const [key, entryValue] of map.entries()) {
    if (entryValue === value) {
      map.delete(key);
    }
  }
}

function rememberRuntimeTerminal(
  terminalNamesByTask: Map<string, string>,
  request: AutocodeAgentRuntimeStartRequest,
  terminalName: string,
): void {
  terminalNamesByTask.set(request.plan.taskId, terminalName);
  terminalNamesByTask.set(request.plan.specId, terminalName);
}

function normalizeProcessStatus(
  status: AutocodeAgentRuntimeStartStatus,
  exitCode: number | null | undefined,
): AutocodeAgentRuntimeStartStatus {
  if (status === 'failed' || exitCode !== undefined && exitCode !== null && exitCode !== 0) {
    return 'failed';
  }
  return status;
}

function formatFailedMessage(
  request: AutocodeAgentRuntimeStartRequest,
  message: string | undefined,
  exitCode: number | null | undefined,
  signal: string | null | undefined,
): string {
  if (message) {
    return `${request.messages.failed} ${message}`;
  }
  if (signal) {
    return `${request.messages.failed} Signal: ${signal}.`;
  }
  if (exitCode !== undefined && exitCode !== null) {
    return `${request.messages.failed} Exit code: ${exitCode}.`;
  }
  return request.messages.failed;
}
