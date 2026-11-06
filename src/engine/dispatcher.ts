import { RETRY_CONFIG } from "./config.js";
import type {
  AlertPayload,
  AlertSink,
  DispatchAttempt,
  DispatchResult,
  RandomSource,
  RetryConfig,
  Sleeper,
} from "./types.js";

export class DispatchError extends Error {
  constructor(
    message: string,
    readonly options: { statusCode?: number; kind?: "timeout" | "network" | "http" } = {},
  ) {
    super(message);
    this.name = "DispatchError";
  }
}

export function isRetryableDispatchError(error: unknown): boolean {
  if (!(error instanceof DispatchError)) {
    return true;
  }
  if (error.options.kind === "timeout" || error.options.kind === "network") {
    return true;
  }
  const statusCode = error.options.statusCode;
  return statusCode === undefined || statusCode === 408 || statusCode >= 500;
}

export function calculateRetryDelay(
  failedAttempt: number,
  random: RandomSource,
  config: Readonly<RetryConfig> = RETRY_CONFIG,
): number {
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1) {
    throw new RangeError("failedAttempt must be a positive integer");
  }
  const exponentialCeiling = Math.min(
    config.maxDelayMs,
    config.baseDelayMs * 2 ** (failedAttempt - 1),
  );
  const sample = Math.min(Math.max(random.next(), 0), 1 - Number.EPSILON);
  return Math.floor(sample * exponentialCeiling);
}

export interface DispatcherDependencies {
  sink: AlertSink;
  sleeper: Sleeper;
  random: RandomSource;
  retryConfig?: Readonly<RetryConfig>;
}

export class ResilientDispatcher {
  private readonly delivered = new Set<string>();
  private readonly retryConfig: Readonly<RetryConfig>;

  constructor(private readonly deps: DispatcherDependencies) {
    this.retryConfig = deps.retryConfig ?? RETRY_CONFIG;
  }

  async dispatch(payload: AlertPayload): Promise<DispatchResult> {
    if (this.delivered.has(payload.alert_id)) {
      return { final_status: "delivered", attempts: [] };
    }

    const attempts: DispatchAttempt[] = [];
    let delayBeforeAttempt = 0;

    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt += 1) {
      if (delayBeforeAttempt > 0) {
        await this.deps.sleeper.sleep(delayBeforeAttempt);
      }
      try {
        await this.deps.sink.deliver(payload);
        this.delivered.add(payload.alert_id);
        attempts.push({
          attempt,
          delay_ms: delayBeforeAttempt,
          outcome: "delivered",
        });
        return { final_status: "delivered", attempts };
      } catch (error) {
        const retryable = isRetryableDispatchError(error);
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({
          attempt,
          delay_ms: delayBeforeAttempt,
          outcome: retryable ? "retryable_error" : "non_retryable_error",
          error: message,
        });
        if (!retryable || attempt === this.retryConfig.maxAttempts) {
          return { final_status: "failed_after_retries", attempts };
        }
        delayBeforeAttempt = calculateRetryDelay(
          attempt,
          this.deps.random,
          this.retryConfig,
        );
      }
    }

    // The loop returns from success or terminal failure; this guards future edits.
    return { final_status: "failed_after_retries", attempts };
  }
}
