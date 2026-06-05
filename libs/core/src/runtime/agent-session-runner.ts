import type {
  AutocodeSessionEventCallback,
  AutocodeSessionResult,
} from './agent-session-types.js';

export interface AutocodeAgentSessionRunnerOptions {
  onEvent?: AutocodeSessionEventCallback;
}

export type AutocodeAgentSessionRunnerFunction<
  Config,
  Options extends AutocodeAgentSessionRunnerOptions = AutocodeAgentSessionRunnerOptions,
> = (config: Config, options?: Options) => Promise<AutocodeSessionResult>;

export interface AutocodeAgentSessionRunner<
  Config,
  Options extends AutocodeAgentSessionRunnerOptions = AutocodeAgentSessionRunnerOptions,
> {
  runAgentSession(config: Config, options?: Options): Promise<AutocodeSessionResult>;
}

export function createAutocodeAgentSessionRunner<
  Config,
  Options extends AutocodeAgentSessionRunnerOptions = AutocodeAgentSessionRunnerOptions,
>(
  runAgentSession: AutocodeAgentSessionRunnerFunction<Config, Options>,
): AutocodeAgentSessionRunner<Config, Options> {
  return { runAgentSession };
}

export function runAutocodeAgentSessionWithRunner<
  Config,
  Options extends AutocodeAgentSessionRunnerOptions = AutocodeAgentSessionRunnerOptions,
>(
  runner: AutocodeAgentSessionRunner<Config, Options>,
  config: Config,
  options?: Options,
): Promise<AutocodeSessionResult> {
  return runner.runAgentSession(config, options);
}
