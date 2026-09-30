import { env } from '../config/env.js';

export interface JitterInterval {
  minutes: number;
  seconds: number;
  totalMs: number;
  nextExecutionTime: Date;
}

/**
 * Calculates a randomized, jitter-infused interval to mimic human sporadic behavior.
 */
export function calculateNextInterval(
  minMinutes = env.MIN_CHECK_INTERVAL_MINUTES,
  maxMinutes = env.MAX_CHECK_INTERVAL_MINUTES
): JitterInterval {
  // Base random minute interval
  const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
  // Add second-level jitter (0 to 59 seconds)
  const randomSeconds = Math.floor(Math.random() * 60);

  const totalMs = (randomMinutes * 60 + randomSeconds) * 1000;
  const nextExecutionTime = new Date(Date.now() + totalMs);

  return {
    minutes: randomMinutes,
    seconds: randomSeconds,
    totalMs,
    nextExecutionTime,
  };
}

/**
 * Interruptible sleep supporting AbortSignal for immediate graceful termination.
 */
export async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error('Aborted'));
    }

    const timer = setTimeout(() => {
      resolve();
    }, ms);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      },
      { once: true }
    );
  });
}
