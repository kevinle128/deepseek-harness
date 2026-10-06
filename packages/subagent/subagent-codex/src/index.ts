/**
 * Profile-named Codex one-shot subagent provider. Every accepted run starts a
 * fresh official package-local Codex wrapper with `app-server --stdio` in the
 * delegating Session's workspace and publishes only after an ephemeral thread exists.
 * Request model and reasoning effort override provider defaults independently;
 * omission at both levels preserves native Codex settings. Other Agent options
 * are rejected before startup. Permissions remain fixed per provider.
 *
 * @module @deepseek-ai/dsh-subagent-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  CODEX_PERMISSION_MODES,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  codexStartupFailure,
  startCodexRun,
  type CodexPermissionMode,
  type CodexRunSpec,
} from './run.ts'

export const name = 'subagent-codex'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'codex'

/** Deployment-owned model and effort defaults, permissions, environment, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `codex`). */
  providerName?: string
  /** Native model default; per-call `agentOptions.model` takes precedence. Omit for Codex settings. */
  model?: string
  /** Native effort default; per-call `agentOptions.reasoningEffort` takes precedence. Omit for Codex settings. */
  reasoningEffort?: string
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Native non-interactive permission mode fixed for this Provider instance. */
  permissionMode?: CodexPermissionMode
  /** Grace in milliseconds between app-server managed-range termination tiers. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...CODEX_PERMISSION_MODES])
    .default(DEFAULT_CODEX_PERMISSION_MODE),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Omit<Required<Config>, 'model' | 'reasoningEffort'>
  & Pick<Config, 'model' | 'reasoningEffort'>

function assertSelection(value: string | undefined, field: string): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
    throw new Error(`subagent-codex: ${field} must be a non-empty string`)
  }
}

class CodexProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { ...NO_START_CAPABILITIES, agentOptions: true }
  readonly inheritsParentContext = false
  readonly agentOptionsRoute = 'native-product' as const

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  start(request: ResolvedSubagentStartRequest) {
    const options = request.agentOptions
    for (const [field, value] of Object.entries(options ?? {})) {
      if (value !== undefined && field !== 'model' && field !== 'reasoningEffort') {
        throw new Error(`subagent-codex: unsupported agentOptions field ${field}`)
      }
    }
    assertSelection(options?.model, 'agentOptions.model')
    assertSelection(options?.reasoningEffort, 'agentOptions.reasoningEffort')
    const model = options?.model ?? this.config.model
    const reasoningEffort = options?.reasoningEffort ?? this.config.reasoningEffort
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-codex: no working directory for the child — delegate from a parent session that has one',
      )
    }
    let cwd: string
    try {
      cwd = resolveChildCwd(
        'subagent-codex',
        undefined,
        parentCwd,
      )
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-codex: request was aborted before app-server startup',
        )
      }
      throw codexStartupFailure(error)
    }
    const spec: CodexRunSpec = {
      cwd,
      ...model === undefined ? {} : { model },
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      permissionMode: this.config.permissionMode,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-codex "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startCodexRun(request, spec)
  }
}

/**
 * Register one Profile-named Codex provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, optional model and effort defaults, permission mode, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  assertSelection(config.model, 'model')
  assertSelection(config.reasoningEffort, 'reasoningEffort')
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    ...config.model === undefined ? {} : { model: config.model },
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    env: config.env as Record<string, string>,
    permissionMode: config.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
    disposeGraceMs: config.disposeGraceMs as number,
  }
  assertPositiveFinite(
    'subagent-codex',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-codex: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new CodexProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
}
