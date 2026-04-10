import { spawn, type ChildProcess, type IOType } from 'node:child_process';
import { Stream } from 'node:stream';
import type { MCPTransport } from '@ai-sdk/mcp';
import { getNpmCommand, getNpxCommand, isWindows } from '../../platform';
import type { StdioTransportConfig } from './types';

type JsonRpcMessage = Record<string, unknown>;

interface HiddenStdioTransportConfig extends Omit<StdioTransportConfig, 'type'> {
  stderr?: IOType | Stream | number;
}

/**
 * Windows-specific stdio transport that forces MCP child processes to stay hidden.
 *
 * The upstream SDK only sets windowsHide when running inside an Electron process.
 * Our task workers are plain Node processes, so built-in stdio MCP servers such as
 * Context7 would otherwise pop up a console window on Windows/VM environments.
 */
export class HiddenWindowsStdioTransport implements MCPTransport {
  private process?: ChildProcess;
  private abortController = new AbortController();
  private buffer?: Buffer;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JsonRpcMessage) => void;

  constructor(private readonly serverParams: HiddenStdioTransportConfig) {}

  async start(): Promise<void> {
    if (this.process) {
      throw new Error('HiddenWindowsStdioTransport already started');
    }

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(
          normalizeWindowsCommand(this.serverParams.command),
          this.serverParams.args ?? [],
          {
            env: this.serverParams.env,
            stdio: ['pipe', 'pipe', this.serverParams.stderr ?? 'inherit'],
            shell: false,
            signal: this.abortController.signal,
            windowsHide: isWindows(),
            cwd: this.serverParams.cwd,
          },
        );

        this.process.on('error', (error) => {
          if (error.name === 'AbortError') {
            this.onclose?.();
            return;
          }

          reject(error);
          this.onerror?.(error);
        });

        this.process.on('spawn', () => {
          resolve();
        });

        this.process.on('close', () => {
          this.process = undefined;
          this.onclose?.();
        });

        this.process.stdin?.on('error', (error) => {
          this.onerror?.(error);
        });

        this.process.stdout?.on('data', (chunk) => {
          this.appendBuffer(chunk);
          this.processReadBuffer();
        });

        this.process.stdout?.on('error', (error) => {
          this.onerror?.(error);
        });
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        reject(wrapped);
        this.onerror?.(wrapped);
      }
    });
  }

  async close(): Promise<void> {
    this.abortController.abort();
    this.process = undefined;
    this.buffer = undefined;
  }

  send(message: JsonRpcMessage): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process?.stdin) {
        throw new Error('HiddenWindowsStdioTransport not connected');
      }

      const payload = `${JSON.stringify(message)}\n`;
      if (this.process.stdin.write(payload)) {
        resolve();
      } else {
        this.process.stdin.once('drain', resolve);
      }
    });
  }

  private appendBuffer(chunk: Buffer | string): void {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer ? Buffer.concat([this.buffer, nextChunk]) : nextChunk;
  }

  private processReadBuffer(): void {
    while (true) {
      const message = this.readMessage();
      if (!message) break;

      try {
        this.onmessage?.(JSON.parse(message) as JsonRpcMessage);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private readMessage(): string | null {
    if (!this.buffer) return null;

    const newlineIndex = this.buffer.indexOf('\n');
    if (newlineIndex === -1) return null;

    const line = this.buffer.toString('utf8', 0, newlineIndex).trim();
    this.buffer = this.buffer.subarray(newlineIndex + 1);
    return line.length > 0 ? line : null;
  }
}

function normalizeWindowsCommand(command: string): string {
  if (!isWindows()) return command;

  const normalized = command.trim().toLowerCase();
  if (normalized === 'npx') return getNpxCommand();
  if (normalized === 'npm') return getNpmCommand();

  return command;
}
