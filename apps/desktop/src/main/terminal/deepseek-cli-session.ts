/**
 * Built-in DeepSeek CLI session for smart terminals.
 *
 * This runs inside the Electron main process instead of spawning an external
 * executable. It reuses the AI SDK provider stack and the existing tool
 * registry, but does not enter the task/spec workflow.
 */

import { streamText, stepCountIs, smoothStream } from 'ai';
import type { ModelMessage } from 'ai';
import type { SharedV3ProviderOptions } from '@ai-sdk/provider';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync } from 'node:fs';

import { IPC_CHANNELS } from '../../shared/constants';
import { DEFAULT_FEATURE_THINKING } from '../../shared/constants/models';
import type { FeatureThinkingConfig, ThinkingLevel } from '../../shared/types/settings';
import type { ProviderAccount } from '../../shared/types/provider-account';
import type { DeepSeekCliState } from '../../shared/types/terminal';
import { buildThinkingProviderOptions } from '@autocode/core';
import { createProvider } from '../ai/providers/factory';
import { SupportedProvider } from '@autocode/core';
import { resolveAuth, resolveAuthFromQueue } from '../ai/auth/resolver';
import { buildToolRegistry } from '../ai/tools/build-registry';
import type { ToolContext } from '../ai/tools/types';
import { getSecurityProfile } from '../ai/security/security-profile';
import { getAppLanguage } from '../app-language';
import { readSettingsFileAsync } from '../settings-utils';
import { safeSendToRenderer } from '../ipc-handlers/utils';
import { debugError, } from '../../shared/utils/debug-logger';
import * as SessionHandler from './session-handler';
import type { TerminalProcess, WindowGetter } from './types';
import { getAutocodeDeepSeekSmartTerminalDir } from '@autocode/core/project/data-paths';

const PROMPT = '> ';
const CONTINUATION_PROMPT = '... ';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const KNOWN_DEEPSEEK_MODELS = ['deepseek-v4-pro', 'deepseek-v4-flash'] as const;
const DEFAULT_MAX_STEPS = 80;
const MAX_HISTORY_MESSAGES = 30;
const MAX_TOOL_OUTPUT_PREVIEW = 600;
const MAX_OUTPUT_BUFFER = 100000;
const STREAM_CHUNK_MAX_CHARS = 14;
const STREAM_CHUNK_DELAY_MS = 14;

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
} as const;

type DeepSeekMessage = ModelMessage;

interface DeepSeekSession {
  terminalId: string;
  cwd: string;
  projectDir: string;
  specDir: string;
  inputBuffer: string;
  cursor: number;
  messages: DeepSeekMessage[];
  busy: boolean;
  modelId: string;
  turnId: number;
  abortController?: AbortController;
  escapeSequence?: string;
}

interface DeepSeekModelConfig {
  model: ReturnType<typeof createProvider>;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

interface StreamingToolInputState {
  toolName: string;
  rawInput: string;
  printed: boolean;
  contentStarted: boolean;
  contentClosed: boolean;
  contentValue: string;
  renderedChars: number;
  decodedContentOffset: number;
  pendingEscape: string;
  truncated: boolean;
  rawContentEscapeActive: boolean;
}

interface MarkdownRenderState {
  lineBuffer: string;
  inCodeFence: boolean;
}

const sessions = new Map<string, DeepSeekSession>();

export function isDeepSeekTerminal(terminal: TerminalProcess | undefined): boolean {
  return terminal?.isCLIMode === true && terminal.activeCLI === 'deepseek';
}

export function startDeepSeekCli(
  terminal: TerminalProcess,
  cwd: string | undefined,
  getWindow: WindowGetter,
): void {
  const projectDir = resolveExistingDirectory(cwd || terminal.projectPath || terminal.cwd);
  const specDir = getAutocodeDeepSeekSmartTerminalDir(projectDir);

  terminal.isCLIMode = true;
  terminal.activeCLI = 'deepseek';
  terminal.claudeSessionId = undefined;
  terminal.claudeProfileId = undefined;
  terminal.title = 'DeepSeek';

  const existing = sessions.get(terminal.id);
  existing?.abortController?.abort();
  const restoredState = normalizeDeepSeekState(terminal.deepseekState);

  const session: DeepSeekSession = {
    terminalId: terminal.id,
    cwd: projectDir,
    projectDir,
    specDir,
    inputBuffer: '',
    cursor: 0,
    messages: restoredState.messages,
    busy: false,
    modelId: restoredState.modelId,
    turnId: 0,
  };
  sessions.set(terminal.id, session);
  syncTerminalDeepSeekState(terminal, session);

  writeToTerminal(
    terminal,
    getWindow,
    [
      `\r\n${colorize('DeepSeek built-in CLI', ANSI.bold, ANSI.cyan)}`,
      `${colorize('Project:', ANSI.gray)} ${projectDir}`,
      `${colorize('Model:', ANSI.gray)} ${colorize(session.modelId, ANSI.green)}`,
      colorize('Type /help for commands. Type /exit to return to the shell.', ANSI.dim),
      '',
      promptText(session),
    ].join('\r\n'),
  );
  safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_TITLE_CHANGE, terminal.id, 'DeepSeek');

  if (terminal.projectPath) {
    SessionHandler.persistSessionAsync(terminal);
  }
}

export function stopDeepSeekCli(
  terminal: TerminalProcess,
  getWindow: WindowGetter,
  options: { announce?: boolean } = {},
): void {
  const session = sessions.get(terminal.id);
  session?.abortController?.abort();
  sessions.delete(terminal.id);

  if (isDeepSeekTerminal(terminal)) {
    terminal.isCLIMode = false;
    terminal.activeCLI = undefined;
    terminal.deepseekState = undefined;
  }

  if (options.announce) {
    writeToTerminal(terminal, getWindow, `\r\n${colorize('Exited DeepSeek CLI.', ANSI.dim)}\r\n`);
  }

  safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_CLAUDE_EXIT, terminal.id);

  if (terminal.projectPath) {
    SessionHandler.persistSessionAsync(terminal);
  }
}

export function disposeDeepSeekCli(terminalId: string): void {
  const session = sessions.get(terminalId);
  session?.abortController?.abort();
  sessions.delete(terminalId);
}

export function handleDeepSeekInput(
  terminal: TerminalProcess,
  data: string,
  getWindow: WindowGetter,
): boolean {
  if (!isDeepSeekTerminal(terminal)) {
    return false;
  }

  const session = sessions.get(terminal.id);
  if (!session) {
    startDeepSeekCli(terminal, terminal.cwd, getWindow);
    return true;
  }

  for (const char of data) {
    handleInputChar(terminal, session, char, getWindow);
  }

  return true;
}

function handleInputChar(
  terminal: TerminalProcess,
  session: DeepSeekSession,
  char: string,
  getWindow: WindowGetter,
): void {
  if (session.escapeSequence !== undefined) {
    session.escapeSequence += char;
    if (isCompleteTerminalEscapeSequence(session.escapeSequence) || session.escapeSequence.length > 64) {
      session.escapeSequence = undefined;
    }
    return;
  }

  if (char === '\u0003') {
    handleCtrlC(terminal, session, getWindow);
    return;
  }

  if (char === '\r' || char === '\n') {
    handleEnter(terminal, session, getWindow);
    return;
  }

  if (char === '\u007f' || char === '\b') {
    if (session.cursor > 0) {
      deletePreviousInputToken(session);
      redrawInputLine(terminal, session, getWindow);
    }
    return;
  }

  if (char === '\u001b') {
    // Ignore terminal control sequences such as focus in/out (ESC [ I / ESC [ O),
    // arrows, function keys, and bracketed paste markers. xterm sends them as
    // multiple bytes; swallowing only ESC leaves tails like "[O[I" in the prompt.
    session.escapeSequence = char;
    return;
  }

  if (char < ' ' && char !== '\t') {
    return;
  }

  if (session.busy) {
    return;
  }

  session.inputBuffer =
    session.inputBuffer.slice(0, session.cursor) +
    char +
    session.inputBuffer.slice(session.cursor);
  session.cursor += char.length;
  writeToTerminal(terminal, getWindow, char);
}

function deletePreviousInputToken(session: DeepSeekSession): void {
  const beforeCursor = session.inputBuffer.slice(0, session.cursor);
  const afterCursor = session.inputBuffer.slice(session.cursor);
  const beforeTokens = Array.from(beforeCursor);
  const removed = beforeTokens.pop();
  if (!removed) {
    return;
  }

  session.inputBuffer = beforeTokens.join('') + afterCursor;
  session.cursor = beforeCursor.length - removed.length;
}

function redrawInputLine(
  terminal: TerminalProcess,
  session: DeepSeekSession,
  getWindow: WindowGetter,
): void {
  writeToTerminal(terminal, getWindow, `\r\x1b[2K${promptText(session)}${session.inputBuffer}`);
}

function handleCtrlC(
  terminal: TerminalProcess,
  session: DeepSeekSession,
  getWindow: WindowGetter,
): void {
  if (session.busy) {
    session.abortController?.abort();
    session.abortController = undefined;
    session.busy = false;
    session.turnId += 1;
    syncAndPersistTerminalDeepSeekState(terminal, session);
    writeToTerminal(terminal, getWindow, `${colorize('^C', ANSI.yellow)}\r\n${colorize('Request cancelled.', ANSI.yellow)}\r\n${promptText(session)}`);
    return;
  }

  session.inputBuffer = '';
  session.cursor = 0;
  syncTerminalDeepSeekState(terminal, session);
  writeToTerminal(terminal, getWindow, `${colorize('^C', ANSI.yellow)}\r\n${promptText(session)}`);
}

function handleEnter(
  terminal: TerminalProcess,
  session: DeepSeekSession,
  getWindow: WindowGetter,
): void {
  writeToTerminal(terminal, getWindow, '\r\n');

  if (session.busy) {
    writeToTerminal(terminal, getWindow, `${colorize('DeepSeek is still responding. Press Ctrl+C to cancel.', ANSI.yellow)}\r\n`);
    writeToTerminal(terminal, getWindow, continuationPromptText());
    return;
  }

  const input = session.inputBuffer.trim();
  session.inputBuffer = '';
  session.cursor = 0;

  if (!input) {
    writeToTerminal(terminal, getWindow, promptText(session));
    return;
  }

  if (handleSlashCommand(terminal, session, input, getWindow)) {
    return;
  }

  void runDeepSeekTurn(terminal, session, input, getWindow);
}

function handleSlashCommand(
  terminal: TerminalProcess,
  session: DeepSeekSession,
  input: string,
  getWindow: WindowGetter,
): boolean {
  const [command, ...args] = input.split(/\s+/);

  switch (command) {
    case '/help': {
      writeToTerminal(
        terminal,
        getWindow,
        [
          colorize('Commands:', ANSI.bold, ANSI.cyan),
          `${colorize('/help', ANSI.green)}   Show this help`,
          `${colorize('/clear', ANSI.green)}  Clear this DeepSeek conversation`,
          `${colorize('/model', ANSI.green)}  Show or switch the DeepSeek model`,
          `${colorize('/exit', ANSI.green)}   Return to the shell`,
          '',
          promptText(session),
        ].join('\r\n'),
      );
      return true;
    }
    case '/clear': {
      session.messages = [];
      syncAndPersistTerminalDeepSeekState(terminal, session);
      writeToTerminal(terminal, getWindow, `${colorize('Conversation cleared.', ANSI.yellow)}\r\n${promptText(session)}`);
      return true;
    }
    case '/model': {
      handleModelCommand(terminal, session, args, getWindow);
      return true;
    }
    case '/exit': {
      stopDeepSeekCli(terminal, getWindow, { announce: true });
      return true;
    }
    default:
      if (input.startsWith('/')) {
        writeToTerminal(terminal, getWindow, `${colorize(`Unknown command: ${input}`, ANSI.red)}\r\n${promptText(session)}`);
        return true;
      }
      return false;
  }
}

function handleModelCommand(
  terminal: TerminalProcess,
  session: DeepSeekSession,
  args: string[],
  getWindow: WindowGetter,
): void {
  const modelArg = args[0]?.trim();
  if (!modelArg || modelArg === 'current' || modelArg === 'list') {
    writeToTerminal(
      terminal,
      getWindow,
      [
        `${colorize('Current model:', ANSI.gray)} ${colorize(session.modelId, ANSI.green)}`,
        colorize('Available models:', ANSI.bold, ANSI.cyan),
        `  ${colorize('deepseek-v4-pro', ANSI.green)}    alias: pro`,
        `  ${colorize('deepseek-v4-flash', ANSI.green)}  alias: flash`,
        colorize('Use /model <model-id|alias> to switch. Any deepseek-* model id is accepted.', ANSI.dim),
        '',
        promptText(session),
      ].join('\r\n'),
    );
    return;
  }

  const nextModel = normalizeDeepSeekModelId(modelArg);
  if (!nextModel) {
    writeToTerminal(
      terminal,
      getWindow,
      `${colorize(`Unknown model: ${modelArg}. Use /model list to see supported models.`, ANSI.red)}\r\n${promptText(session)}`,
    );
    return;
  }

  session.modelId = nextModel;
  syncAndPersistTerminalDeepSeekState(terminal, session);
  writeToTerminal(terminal, getWindow, `${colorize('Model switched to', ANSI.gray)} ${colorize(nextModel, ANSI.green)}.\r\n${promptText(session)}`);
}

function normalizeDeepSeekModelId(model: string): string | null {
  const normalized = model.trim().toLowerCase();
  if (normalized === 'pro' || normalized === 'v4-pro') return 'deepseek-v4-pro';
  if (normalized === 'flash' || normalized === 'v4-flash') return 'deepseek-v4-flash';
  if ((KNOWN_DEEPSEEK_MODELS as readonly string[]).includes(normalized)) return normalized;
  if (normalized.startsWith('deepseek-')) return normalized;
  return null;
}

async function runDeepSeekTurn(
  terminal: TerminalProcess,
  session: DeepSeekSession,
  input: string,
  getWindow: WindowGetter,
): Promise<void> {
  session.busy = true;
  const abortController = new AbortController();
  const turnId = session.turnId + 1;
  session.turnId = turnId;
  session.abortController = abortController;

  const userMessage: DeepSeekMessage = { role: 'user', content: input };
  const requestMessages = trimHistory([...session.messages, userMessage]);
  let assistantText = '';
  let didPrintText = false;
  let didPrintReasoning = false;
  let isReasoningBlockOpen = false;
  const markdownState = createMarkdownRenderState();
  const toolNamesByCallId = new Map<string, string>();
  const toolInputsByCallId = new Map<string, StreamingToolInputState>();

  try {
    const modelConfig = await resolveDeepSeekModelConfig(session.modelId);
    const toolContext = buildToolContext(session, abortController.signal);
    const registry = buildToolRegistry();
    const tools = registry.getToolsForAgent('insights', toolContext);

    const thinkingOptions = buildThinkingProviderOptions(
      modelConfig.modelId,
      modelConfig.thinkingLevel,
    ) as SharedV3ProviderOptions | undefined;
    const result = streamText({
      model: modelConfig.model,
      system: buildSystemPrompt(session.projectDir, getAppLanguage()),
      messages: requestMessages,
      tools,
      stopWhen: stepCountIs(DEFAULT_MAX_STEPS),
      abortSignal: abortController.signal,
      experimental_transform: smoothStream({
        delayInMs: STREAM_CHUNK_DELAY_MS,
        chunking: detectDeepSeekStreamChunk,
      }),
      ...(thinkingOptions ? { providerOptions: thinkingOptions } : {}),
    });

    for await (const rawPart of result.fullStream) {
      if (!isActiveTurn(session, turnId, abortController)) {
        return;
      }

      const part = rawPart as { type: string; [key: string]: unknown };
      switch (part.type) {
        case 'reasoning-start': {
          if (!didPrintReasoning) {
            writeToTerminal(terminal, getWindow, '[thinking]\r\n');
            didPrintReasoning = true;
          }
          isReasoningBlockOpen = true;
          break;
        }
        case 'reasoning-delta': {
          const text = getTextDelta(part);
          if (!didPrintReasoning) {
            writeToTerminal(terminal, getWindow, '[thinking]\r\n');
            didPrintReasoning = true;
          }
          isReasoningBlockOpen = true;
          writeToTerminal(terminal, getWindow, normalizeNewlines(text));
          break;
        }
        case 'reasoning-end': {
          if (isReasoningBlockOpen) {
            writeToTerminal(terminal, getWindow, '\r\n');
            isReasoningBlockOpen = false;
          }
          break;
        }
        case 'text-delta': {
          if (isReasoningBlockOpen) {
            writeToTerminal(terminal, getWindow, '\r\n');
            isReasoningBlockOpen = false;
          }
          const text = getTextDelta(part);
          assistantText += text;
          didPrintText = true;
          writeMarkdownPreviewDelta(terminal, getWindow, markdownState, text);
          break;
        }
        case 'tool-call': {
          if (isReasoningBlockOpen) {
            writeToTerminal(terminal, getWindow, '\r\n');
            isReasoningBlockOpen = false;
          }
          const partRecord = part as { toolCallId?: unknown; toolName?: unknown; input?: unknown; args?: unknown };
          const toolName = String(partRecord.toolName ?? 'tool');
          rememberToolName(toolNamesByCallId, partRecord.toolCallId, toolName);
          const inputText = formatToolInput(toolName, partRecord.input ?? partRecord.args);
          writeToTerminal(terminal, getWindow, `\r\n${inputText || formatToolLine(toolName)}\r\n`);
          break;
        }
        case 'tool-input-available': {
          if (isReasoningBlockOpen) {
            writeToTerminal(terminal, getWindow, '\r\n');
            isReasoningBlockOpen = false;
          }
          const partRecord = part as { toolCallId?: unknown; toolName?: unknown; input?: unknown; args?: unknown };
          const toolName = String(partRecord.toolName ?? 'tool');
          rememberToolName(toolNamesByCallId, partRecord.toolCallId, toolName);
          const inputText = formatToolInput(toolName, partRecord.input ?? partRecord.args);
          writeToTerminal(terminal, getWindow, `\r\n${inputText || formatToolLine(toolName)}\r\n`);
          break;
        }
        case 'tool-input-start': {
          if (isReasoningBlockOpen) {
            writeToTerminal(terminal, getWindow, '\r\n');
            isReasoningBlockOpen = false;
          }
          const partRecord = part as { id?: unknown; toolCallId?: unknown; toolName?: unknown };
          const toolName = String(partRecord.toolName ?? 'tool');
          const toolCallId = getToolCallId(partRecord.toolCallId ?? partRecord.id);
          rememberToolName(toolNamesByCallId, toolCallId, toolName);
          if (toolCallId) {
            toolInputsByCallId.set(toolCallId, createStreamingToolInputState(toolName));
          }
          break;
        }
        case 'tool-input-delta': {
          const delta = getToolInputDelta(part);
          const toolCallId = getToolCallId(part.toolCallId ?? part.id);
          if (delta && toolCallId) {
            let inputState = toolInputsByCallId.get(toolCallId);
            if (!inputState) {
              inputState = createStreamingToolInputState(getToolName(toolNamesByCallId, toolCallId, part.toolName));
              toolInputsByCallId.set(toolCallId, inputState);
            }
            writeStreamingToolInput(terminal, getWindow, inputState, delta);
          }
          break;
        }
        case 'tool-input-end': {
          const partRecord = part as { id?: unknown; toolCallId?: unknown; toolName?: unknown };
          const toolCallId = getToolCallId(partRecord.toolCallId ?? partRecord.id);
          const toolName = getToolName(toolNamesByCallId, toolCallId, partRecord.toolName);
          const inputState = toolCallId ? toolInputsByCallId.get(toolCallId) : undefined;
          const inputText = inputState
            ? finishStreamingToolInput(inputState)
            : formatToolInput(toolName, undefined);
          if (toolCallId) {
            toolInputsByCallId.delete(toolCallId);
          }
          if (!inputState || !inputState.printed) {
            writeToTerminal(terminal, getWindow, `\r\n${inputText || formatToolLine(toolName)}\r\n`);
          } else if (inputText) {
            writeToTerminal(terminal, getWindow, `${inputText}\r\n`);
          } else {
            writeToTerminal(terminal, getWindow, '\r\n');
          }
          break;
        }
        case 'tool-result': {
          const partRecord = part as { toolCallId?: unknown; toolName?: unknown; output?: unknown };
          const toolName = getToolName(toolNamesByCallId, partRecord.toolCallId, partRecord.toolName);
          const preview = formatToolOutputPreview(partRecord.output);
          writeToTerminal(
            terminal,
            getWindow,
            preview
              ? `${formatToolLine(toolName)}: ${normalizeNewlines(preview)}\r\n`
              : `${formatToolLine(toolName)}\r\n`,
          );
          break;
        }
        case 'tool-output-available': {
          const partRecord = part as { toolCallId?: unknown; toolName?: unknown; output?: unknown };
          const toolName = getToolName(toolNamesByCallId, partRecord.toolCallId, partRecord.toolName);
          const preview = formatToolOutputPreview(partRecord.output);
          writeToTerminal(
            terminal,
            getWindow,
            preview
              ? `${formatToolLine(toolName)}: ${normalizeNewlines(preview)}\r\n`
              : `${formatToolLine(toolName)}\r\n`,
          );
          break;
        }
        case 'tool-error': {
          const errorPartRecord = part as { toolCallId?: unknown; toolName?: unknown; error?: unknown; errorText?: unknown };
          const toolName = getToolName(toolNamesByCallId, errorPartRecord.toolCallId, errorPartRecord.toolName);
          const errorText = getErrorText(errorPartRecord.error ?? errorPartRecord.errorText);
          writeToTerminal(terminal, getWindow, `${formatToolLine(toolName, true)}: ${colorize(errorText, ANSI.red)}\r\n`);
          break;
        }
        case 'tool-output-error': {
          const errorPartRecord = part as { toolCallId?: unknown; toolName?: unknown; error?: unknown; errorText?: unknown };
          const toolName = getToolName(toolNamesByCallId, errorPartRecord.toolCallId, errorPartRecord.toolName);
          const errorText = getErrorText(errorPartRecord.error ?? errorPartRecord.errorText);
          writeToTerminal(terminal, getWindow, `${formatToolLine(toolName, true)}: ${colorize(errorText, ANSI.red)}\r\n`);
          break;
        }
        case 'error': {
          if (isReasoningBlockOpen) {
            writeToTerminal(terminal, getWindow, '\r\n');
            isReasoningBlockOpen = false;
          }
          const errorText = getErrorText((part as { error?: unknown }).error);
          writeToTerminal(terminal, getWindow, `\r\n${colorize(`Error: ${errorText}`, ANSI.red)}\r\n`);
          break;
        }
      }
    }

    if (isActiveTurn(session, turnId, abortController)) {
      session.messages = trimHistory([
        ...requestMessages,
        ...(assistantText ? [{ role: 'assistant' as const, content: assistantText }] : []),
      ]);
      syncTerminalDeepSeekState(terminal, session);
    }

    if (isActiveTurn(session, turnId, abortController)) {
      if (isReasoningBlockOpen) {
        writeToTerminal(terminal, getWindow, '\r\n');
        isReasoningBlockOpen = false;
      }
      if (!didPrintText) {
        writeToTerminal(terminal, getWindow, '\r\n');
      } else {
        flushMarkdownPreview(terminal, getWindow, markdownState);
        if (!assistantText.endsWith('\n')) {
          writeToTerminal(terminal, getWindow, '\r\n');
        }
      }
    }
  } catch (error) {
    if (!isActiveTurn(session, turnId, abortController)) {
      return;
    }

    if (abortController.signal.aborted) {
      writeToTerminal(terminal, getWindow, `${colorize('Request cancelled.', ANSI.yellow)}\r\n`);
    } else {
      debugError('[DeepSeekCLI] Request failed:', error);
      writeToTerminal(terminal, getWindow, `${colorize(`Error: ${getErrorText(error)}`, ANSI.red)}\r\n`);
    }
  } finally {
    if (isActiveTurn(session, turnId, abortController)) {
      session.busy = false;
      session.abortController = undefined;
      syncTerminalDeepSeekState(terminal, session);
      writeToTerminal(terminal, getWindow, promptText(session));
      if (terminal.projectPath) {
        SessionHandler.persistSessionAsync(terminal);
      }
    }
  }
}

function isActiveTurn(
  session: DeepSeekSession,
  turnId: number,
  abortController: AbortController,
): boolean {
  return (
    session.turnId === turnId &&
    session.abortController === abortController &&
    !abortController.signal.aborted
  );
}

async function resolveDeepSeekModelConfig(modelId: string): Promise<DeepSeekModelConfig> {
  const settings = await readSettingsFileAsync();
  const model = modelId || DEFAULT_MODEL;
  const thinkingLevel = resolveConfiguredThinking(settings);
  const queue = buildDeepSeekQueue(settings);
  const userModelOverrides = settings?.modelOverrides as Record<string, unknown> | undefined;

  let auth = queue.length
    ? await resolveAuthFromQueue(model, queue, {
        userModelOverrides: userModelOverrides as never,
        executionMode: 'agentic',
      })
    : null;

  if (!auth) {
    const directAuth = await resolveAuth({ provider: SupportedProvider.DeepSeek });
    if (directAuth) {
      auth = {
        ...directAuth,
        accountId: 'deepseek-direct',
        resolvedProvider: SupportedProvider.DeepSeek,
        resolvedModelId: model,
        reasoningConfig: { type: 'reasoning_effort', level: thinkingLevel },
      };
    }
  }

  if (!auth || auth.resolvedProvider !== SupportedProvider.DeepSeek) {
    throw new Error('DeepSeek account is not configured. Add a DeepSeek API key in Settings > AI Providers, or set DEEPSEEK_API_KEY.');
  }

  return {
    model: createProvider({
      config: {
        provider: SupportedProvider.DeepSeek,
        apiKey: auth.apiKey,
        baseURL: auth.baseURL,
        headers: auth.headers,
      },
      modelId: auth.resolvedModelId,
    }),
    modelId: auth.resolvedModelId,
    thinkingLevel,
  };
}

function resolveConfiguredThinking(settings: Record<string, unknown> | undefined): ThinkingLevel {
  const providerConfig = getDeepSeekProviderConfig(settings);
  const perProviderThinking = providerConfig?.featureThinking as FeatureThinkingConfig | undefined;
  const globalThinking = settings?.featureThinking as FeatureThinkingConfig | undefined;
  return (
    perProviderThinking?.insights ??
    globalThinking?.insights ??
    DEFAULT_FEATURE_THINKING.insights ??
    'medium'
  ) as ThinkingLevel;
}

function getDeepSeekProviderConfig(settings: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return (settings?.providerAgentConfig as Record<string, Record<string, unknown>> | undefined)?.deepseek;
}

function buildDeepSeekQueue(settings: Record<string, unknown> | undefined): ProviderAccount[] {
  const accounts = (settings?.providerAccounts as ProviderAccount[] | undefined)?.filter(
    (account) => account.provider === 'deepseek' && account.authType === 'api-key',
  ) ?? [];
  const priorityOrder = (settings?.globalPriorityOrder as string[] | undefined) ?? [];

  return [...accounts].sort((a, b) => {
    const aIndex = priorityOrder.indexOf(a.id);
    const bIndex = priorityOrder.indexOf(b.id);
    return (aIndex === -1 ? Number.POSITIVE_INFINITY : aIndex) -
      (bIndex === -1 ? Number.POSITIVE_INFINITY : bIndex);
  });
}

function buildToolContext(session: DeepSeekSession, abortSignal: AbortSignal): ToolContext {
  const securityProfile = getSecurityProfile(session.projectDir);
  return {
    cwd: session.cwd,
    projectDir: session.projectDir,
    specDir: session.specDir,
    allowedPathRoots: [session.projectDir],
    securityProfile,
    abortSignal,
    workflowMode: 'balanced',
  };
}

function buildSystemPrompt(projectDir: string, language: string): string {
  return [
    'DeepSeek smart terminal assistant. Answer directly and concisely.',
    `Project directory: ${projectDir}`,
    getDeepSeekLanguageInstruction(language),
    'Use available tools to inspect or modify the project when useful.',
    'Do not use Autocode task/spec/subtask workflow or update task statuses.',
    'Prefer precise, scoped edits. Mention files changed and verification performed when you make changes.',
  ].join('\n');
}

function getDeepSeekLanguageInstruction(language: string): string {
  const normalizedLanguage = language.toLowerCase();
  if (normalizedLanguage.startsWith('zh')) {
    return 'Use Simplified Chinese for prose unless the user asks otherwise. Keep code, commands, identifiers, and paths unchanged.';
  }
  if (normalizedLanguage.startsWith('fr')) {
    return 'Use French for prose unless the user asks otherwise. Keep code, commands, identifiers, and paths unchanged.';
  }
  if (normalizedLanguage.startsWith('ja')) {
    return 'Use Japanese for prose unless the user asks otherwise. Keep code, commands, identifiers, and paths unchanged.';
  }
  if (normalizedLanguage.startsWith('ko')) {
    return 'Use Korean for prose unless the user asks otherwise. Keep code, commands, identifiers, and paths unchanged.';
  }
  if (normalizedLanguage.startsWith('de')) {
    return 'Use German for prose unless the user asks otherwise. Keep code, commands, identifiers, and paths unchanged.';
  }
  if (normalizedLanguage.startsWith('es')) {
    return 'Use Spanish for prose unless the user asks otherwise. Keep code, commands, identifiers, and paths unchanged.';
  }
  if (normalizedLanguage.startsWith('ru')) {
    return 'Use Russian for prose unless the user asks otherwise. Keep code, commands, identifiers, and paths unchanged.';
  }
  return 'Use English for prose unless the user asks otherwise. Keep code, commands, identifiers, and paths unchanged.';
}

function trimHistory(messages: DeepSeekMessage[]): DeepSeekMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) {
    return messages;
  }
  return messages.slice(-MAX_HISTORY_MESSAGES);
}

function normalizeDeepSeekState(state: DeepSeekCliState | undefined): {
  modelId: string;
  messages: DeepSeekMessage[];
} {
  return {
    modelId: normalizeDeepSeekModelId(state?.modelId ?? '') ?? DEFAULT_MODEL,
    messages: normalizeDeepSeekMessages(state?.messages),
  };
}

function normalizeDeepSeekMessages(messages: unknown[] | undefined): DeepSeekMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  return trimHistory(messages.filter(isDeepSeekMessage));
}

function isDeepSeekMessage(message: unknown): message is DeepSeekMessage {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const record = message as { role?: unknown; content?: unknown };
  const role = record.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') {
    return false;
  }
  return typeof record.content === 'string' || Array.isArray(record.content);
}

function toDeepSeekCliState(session: DeepSeekSession): DeepSeekCliState {
  return {
    modelId: session.modelId,
    messages: trimHistory(session.messages),
  };
}

function syncTerminalDeepSeekState(
  terminal: TerminalProcess,
  session: DeepSeekSession,
): void {
  terminal.deepseekState = toDeepSeekCliState(session);
}

function syncAndPersistTerminalDeepSeekState(
  terminal: TerminalProcess,
  session: DeepSeekSession,
): void {
  syncTerminalDeepSeekState(terminal, session);
  if (terminal.projectPath) {
    SessionHandler.persistSessionAsync(terminal);
  }
}

function resolveExistingDirectory(candidate: string | undefined): string {
  if (candidate && existsSync(candidate)) {
    return path.resolve(candidate);
  }
  return os.homedir();
}

function writeToTerminal(
  terminal: TerminalProcess,
  getWindow: WindowGetter,
  text: string,
): void {
  terminal.outputBuffer = (terminal.outputBuffer + text).slice(-MAX_OUTPUT_BUFFER);
  safeSendToRenderer(getWindow, IPC_CHANNELS.TERMINAL_OUTPUT, terminal.id, text);
}

function colorize(text: string, ...codes: string[]): string {
  return `${codes.join('')}${text}${ANSI.reset}`;
}

function promptText(session: DeepSeekSession): string {
  return `${colorize(PROMPT, ANSI.bold, ANSI.cyan)}\x1b[s\r\n\x1b[2K${promptStatusText(session)}\x1b[u`;
}

function promptStatusText(session: DeepSeekSession): string {
  return colorize(`${session.modelId} · ${session.projectDir}`, ANSI.gray);
}

function continuationPromptText(): string {
  return colorize(CONTINUATION_PROMPT, ANSI.cyan);
}

function formatToolLine(toolName: string, isError = false): string {
  const toolColor = isError ? ANSI.red : ANSI.yellow;
  return colorize(toolName, ANSI.bold, toolColor);
}

function detectDeepSeekStreamChunk(buffer: string): string | null {
  if (!buffer) {
    return null;
  }

  const newlineIndex = buffer.search(/\r?\n/);
  if (newlineIndex >= 0) {
    const hasCrLf = buffer[newlineIndex] === '\r' && buffer[newlineIndex + 1] === '\n';
    return buffer.slice(0, newlineIndex + (hasCrLf ? 2 : 1));
  }

  const whitespaceMatch = /\s/.exec(buffer);
  if (whitespaceMatch && whitespaceMatch.index > 0) {
    return buffer.slice(0, whitespaceMatch.index + whitespaceMatch[0].length);
  }

  const chars = Array.from(buffer);
  if (chars.length >= STREAM_CHUNK_MAX_CHARS) {
    return chars.slice(0, STREAM_CHUNK_MAX_CHARS).join('');
  }

  return null;
}

function isCompleteTerminalEscapeSequence(sequence: string): boolean {
  if (!sequence.startsWith('\u001b')) {
    return true;
  }

  if (sequence.length < 2) {
    return false;
  }

  const second = sequence.charCodeAt(1);

  // CSI: ESC [ ... final-byte, where final is 0x40-0x7E.
  // Covers focus events (ESC [ I / ESC [ O), arrows, delete, bracketed paste.
  if (second === 0x5b) {
    if (sequence.length < 3) {
      return false;
    }
    const final = sequence.charCodeAt(sequence.length - 1);
    return final >= 0x40 && final <= 0x7e;
  }

  // SS3: ESC O final-byte. Common for application cursor/function keys.
  if (second === 0x4f) {
    return sequence.length >= 3;
  }

  // Other ESC-prefixed sequences are two-byte controls for our purposes.
  return true;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

function createMarkdownRenderState(): MarkdownRenderState {
  return {
    lineBuffer: '',
    inCodeFence: false,
  };
}

function writeMarkdownPreviewDelta(
  terminal: TerminalProcess,
  getWindow: WindowGetter,
  state: MarkdownRenderState,
  delta: string,
): void {
  if (!delta) {
    return;
  }

  state.lineBuffer += delta.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let newlineIndex = state.lineBuffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = state.lineBuffer.slice(0, newlineIndex);
    state.lineBuffer = state.lineBuffer.slice(newlineIndex + 1);
    writeToTerminal(terminal, getWindow, `${renderMarkdownPreviewLine(state, line)}\r\n`);
    newlineIndex = state.lineBuffer.indexOf('\n');
  }

  if (canStreamMarkdownPreviewPartial(state)) {
    writeToTerminal(terminal, getWindow, state.lineBuffer);
    state.lineBuffer = '';
  }
}

function flushMarkdownPreview(
  terminal: TerminalProcess,
  getWindow: WindowGetter,
  state: MarkdownRenderState,
): void {
  if (!state.lineBuffer) {
    return;
  }
  writeToTerminal(terminal, getWindow, renderMarkdownPreviewLine(state, state.lineBuffer));
  state.lineBuffer = '';
}

function renderMarkdownPreviewLine(state: MarkdownRenderState, line: string): string {
  if (/^\s*```/.test(line)) {
    state.inCodeFence = !state.inCodeFence;
    return colorize('────────', ANSI.gray);
  }

  if (state.inCodeFence) {
    return line ? colorize(line, ANSI.cyan) : '';
  }

  const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    return colorize(stripMarkdownInline(headingMatch[2]).toUpperCase(), ANSI.bold, ANSI.cyan);
  }

  const quoteMatch = line.match(/^\s{0,3}>\s?(.*)$/);
  if (quoteMatch) {
    return `${colorize('│', ANSI.gray)} ${stripMarkdownInline(quoteMatch[1])}`;
  }

  const unorderedListMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
  if (unorderedListMatch) {
    return `${unorderedListMatch[1]}• ${stripMarkdownInline(unorderedListMatch[2])}`;
  }

  const orderedListMatch = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
  if (orderedListMatch) {
    return `${orderedListMatch[1]}• ${stripMarkdownInline(orderedListMatch[2])}`;
  }

  return stripMarkdownInline(line);
}

function canStreamMarkdownPreviewPartial(state: MarkdownRenderState): boolean {
  return state.lineBuffer.length > 0
    && !state.inCodeFence
    && !/[`*_#[\]()!>~\-+]/.test(state.lineBuffer);
}

function stripMarkdownInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, (_match, code: string) => colorize(code, ANSI.yellow))
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/___([^_]+)___/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');
}

function getTextDelta(part: Record<string, unknown>): string {
  if (typeof part.text === 'string') return part.text;
  if (typeof part.delta === 'string') return part.delta;
  return '';
}

function getToolInputDelta(part: Record<string, unknown>): string {
  if (typeof part.delta === 'string') return part.delta;
  if (typeof part.text === 'string') return part.text;
  return '';
}

function getToolCallId(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function rememberToolName(
  toolNamesByCallId: Map<string, string>,
  toolCallId: unknown,
  toolName: string,
): void {
  if (typeof toolCallId === 'string') {
    toolNamesByCallId.set(toolCallId, toolName);
  }
}

function getToolName(
  toolNamesByCallId: Map<string, string>,
  toolCallId: unknown,
  fallback: unknown,
): string {
  if (typeof fallback === 'string') {
    return fallback;
  }
  if (typeof toolCallId === 'string') {
    return toolNamesByCallId.get(toolCallId) ?? 'tool';
  }
  return 'tool';
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function parseToolInput(input: unknown): Record<string, unknown> | undefined {
  if (!input) {
    return undefined;
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  if (typeof input !== 'string') {
    return undefined;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function getStringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function formatToolInput(toolName: string, input: unknown): string {
  const parsed = parseToolInput(input);
  if (!parsed) {
    return formatToolLine(toolName);
  }

  const filePath = getStringField(parsed, 'file_path', 'path');
  if (toolName === 'Write') {
    const content = getStringField(parsed, 'content');
    return [
      `${formatToolLine(toolName)}${filePath ? ` ${filePath}` : ''}`,
      ...(content ? [formatToolContent(content)] : []),
    ].join('\r\n');
  }

  if (toolName === 'Edit') {
    const newString = getStringField(parsed, 'new_string');
    return [
      `${formatToolLine(toolName)}${filePath ? ` ${filePath}` : ''}`,
      ...(newString ? [formatToolContent(newString)] : []),
    ].join('\r\n');
  }

  const command = getStringField(parsed, 'command');
  if (toolName === 'Bash' && command) {
    return `${formatToolLine(toolName)} ${command}`;
  }

  const query = getStringField(parsed, 'query', 'pattern', 'glob');
  if (filePath || query) {
    return `${formatToolLine(toolName)} ${filePath ?? query}`;
  }

  return formatToolLine(toolName);
}

function createStreamingToolInputState(toolName: string): StreamingToolInputState {
  return {
    toolName,
    rawInput: '',
    printed: false,
    contentStarted: false,
    contentClosed: false,
    contentValue: '',
    renderedChars: 0,
    decodedContentOffset: 0,
    pendingEscape: '',
    truncated: false,
    rawContentEscapeActive: false,
  };
}

function writeStreamingToolInput(
  terminal: TerminalProcess,
  getWindow: WindowGetter,
  state: StreamingToolInputState,
  delta: string,
): void {
  if (state.printed && state.contentStarted && !state.contentClosed && isStreamingContentTool(state.toolName)) {
    streamJsonStringFieldContent(
      terminal,
      getWindow,
      state,
      getStreamingContentFieldName(state.toolName),
      undefined,
      delta,
    );
    return;
  }

  state.rawInput += delta;
  const parsed = state.printed && isStreamingContentTool(state.toolName)
    ? undefined
    : parseToolInput(state.rawInput);

  if (!state.printed) {
    const filePath = parsed
      ? getStringField(parsed, 'file_path', 'path')
      : extractJsonStringFieldValue(state.rawInput, 'file_path') ?? extractJsonStringFieldValue(state.rawInput, 'path');
    if (state.toolName !== 'Write' && state.toolName !== 'Edit') {
      writeToTerminal(terminal, getWindow, `\r\n${formatToolInput(state.toolName, parsed ?? state.rawInput)}\r\n`);
      state.printed = true;
      return;
    }
    if (filePath) {
      writeToTerminal(terminal, getWindow, `\r\n${formatToolLine(state.toolName)} ${filePath}\r\n`);
      state.printed = true;
    }
  }

  if (state.toolName === 'Write') {
    streamJsonStringFieldContent(terminal, getWindow, state, 'content', parsed);
  } else if (state.toolName === 'Edit') {
    streamJsonStringFieldContent(terminal, getWindow, state, 'new_string', parsed);
  }
}

function isStreamingContentTool(toolName: string): boolean {
  return toolName === 'Write' || toolName === 'Edit';
}

function getStreamingContentFieldName(toolName: string): string {
  return toolName === 'Edit' ? 'new_string' : 'content';
}

function finishStreamingToolInput(state: StreamingToolInputState): string {
  if (!state.printed) {
    return formatToolInput(state.toolName, state.rawInput);
  }
  if (!state.pendingEscape) {
    return '';
  }
  const decoded = decodeJsonStringFragment(state.pendingEscape);
  state.pendingEscape = '';
  return formatToolContentDelta(state, decoded.text);
}

function streamJsonStringFieldContent(
  terminal: TerminalProcess,
  getWindow: WindowGetter,
  state: StreamingToolInputState,
  fieldName: string,
  parsedInput?: Record<string, unknown>,
  incrementalRawDelta?: string,
): void {
  const parsedContent = parsedInput ? getStringField(parsedInput, fieldName) : undefined;
  if (parsedContent !== undefined) {
    const delta = parsedContent.slice(state.decodedContentOffset);
    state.decodedContentOffset = parsedContent.length;
    const text = formatToolContentDelta(state, delta);
    if (text) {
      writeToTerminal(terminal, getWindow, text);
    }
    return;
  }

  if (state.contentStarted && incrementalRawDelta !== undefined) {
    const rawContentDelta = readJsonStringContentDelta(state, incrementalRawDelta);
    if (!rawContentDelta) {
      return;
    }
    const decoded = decodeJsonStringFragment(`${state.pendingEscape}${rawContentDelta}`, !state.contentClosed);
    state.pendingEscape = decoded.pending;
    const text = formatToolContentDelta(state, decoded.text);
    if (text) {
      writeToTerminal(terminal, getWindow, text);
    }
    return;
  }

  const rawContent = extractPartialJsonStringField(state.rawInput, fieldName);
  if (!rawContent) {
    return;
  }

  state.contentStarted = true;
  state.contentClosed = rawContent.closed;
  const rawDelta = rawContent.value.slice(state.contentValue.length);
  state.contentValue = rawContent.value;
  if (!rawDelta) {
    return;
  }

  const decoded = decodeJsonStringFragment(`${state.pendingEscape}${rawDelta}`, !rawContent.closed);
  state.pendingEscape = decoded.pending;
  const text = formatToolContentDelta(state, decoded.text);
  if (text) {
    writeToTerminal(terminal, getWindow, text);
  }
}

function readJsonStringContentDelta(state: StreamingToolInputState, delta: string): string {
  let value = '';
  for (const char of delta) {
    if (state.rawContentEscapeActive) {
      value += `\\${char}`;
      state.rawContentEscapeActive = false;
      continue;
    }
    if (char === '\\') {
      state.rawContentEscapeActive = true;
      continue;
    }
    if (char === '"') {
      state.contentClosed = true;
      break;
    }
    value += char;
  }
  if (state.rawContentEscapeActive && state.contentClosed) {
    value += '\\';
    state.rawContentEscapeActive = false;
  }
  return value;
}

function formatToolContentDelta(state: StreamingToolInputState, delta: string): string {
  if (!delta) {
    return '';
  }

  state.renderedChars += Array.from(delta).length;
  return normalizeNewlines(delta);
}

function extractJsonStringFieldValue(json: string, fieldName: string): string | undefined {
  const field = extractPartialJsonStringField(json, fieldName);
  return field?.closed === true
    ? decodeJsonStringFragment(field.value).text
    : undefined;
}

function extractPartialJsonStringField(json: string, fieldName: string): { value: string; closed: boolean } | undefined {
  const keyIndex = json.indexOf(`"${fieldName}"`);
  if (keyIndex < 0) {
    return undefined;
  }
  const colonIndex = json.indexOf(':', keyIndex + fieldName.length + 2);
  if (colonIndex < 0) {
    return undefined;
  }
  let quoteIndex = colonIndex + 1;
  while (quoteIndex < json.length && /\s/.test(json[quoteIndex])) {
    quoteIndex++;
  }
  if (json[quoteIndex] !== '"') {
    return undefined;
  }

  let value = '';
  let escaped = false;
  for (let index = quoteIndex + 1; index < json.length; index++) {
    const char = json[index];
    if (escaped) {
      value += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return { value, closed: true };
    }
    value += char;
  }
  if (escaped) {
    value += '\\';
  }
  return { value, closed: false };
}

function decodeJsonStringFragment(
  fragment: string,
  keepIncompleteEscape = false,
): { text: string; pending: string } {
  let text = '';
  let pending = '';
  for (let index = 0; index < fragment.length; index++) {
    const char = fragment[index];
    if (char !== '\\') {
      text += char;
      continue;
    }

    const next = fragment[index + 1];
    if (next === undefined) {
      pending = keepIncompleteEscape ? '\\' : '';
      break;
    }
    if (next === 'u') {
      const hex = fragment.slice(index + 2, index + 6);
      if (hex.length < 4) {
        pending = keepIncompleteEscape ? fragment.slice(index) : '';
        break;
      }
      text += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
      continue;
    }
    const escapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    text += escapes[next] ?? next;
    index++;
  }
  return { text, pending };
}

function formatToolContent(content: string): string {
  return normalizeNewlines(content);
}

function formatToolOutputPreview(output: unknown): string {
  if (output === undefined || output === null) return '';
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  if (!text) return '';
  const normalized = normalizeNewlines(text.trim());
  if (normalized.length <= MAX_TOOL_OUTPUT_PREVIEW) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TOOL_OUTPUT_PREVIEW)}...`;
}

export function getDeepSeekSessionForTest(terminalId: string): DeepSeekSession | undefined {
  return sessions.get(terminalId);
}

export function resetDeepSeekSessionsForTest(): void {
  for (const session of sessions.values()) {
    session.abortController?.abort();
  }
  sessions.clear();
}
