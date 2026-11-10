import { serializeError, type Logger } from "../logger.js";

export interface ShutdownStep {
  readonly name: string;
  run(): Promise<void> | void;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function withTimeout(step: ShutdownStep, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Shutdown step "${step.name}" timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref();

    Promise.resolve()
      .then(() => step.run())
      .then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

/**
 * Runs every shutdown step in order. A failing or hung step is logged and the
 * remaining steps still run, so one unhealthy service cannot strand the rest.
 */
export async function runShutdown(
  steps: readonly ShutdownStep[],
  logger: Logger,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const budget = Math.max(1, timeoutMs);
  for (const step of steps) {
    try {
      await withTimeout(step, budget);
    } catch (error) {
      logger.warn("Shutdown step failed", {
        step: step.name,
        ...serializeError(error),
      });
    }
  }
}
