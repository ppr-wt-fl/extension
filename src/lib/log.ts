import { flags } from "@/lib/flags";

export const LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];

// console.trace prints a stack per call, too noisy for per-request logs
const METHOD = { trace: "debug", debug: "debug", info: "info", warn: "warn", error: "error" } as const;

const noop = () => {};

/**
 * Console methods prefixed with `[scope]`, below `flags.log` they do nothing. Bound, so DevTools shows the caller's
 * line, not this file's.
 */
export function logger(scope: string): Record<Level, (...args: unknown[]) => void> {
  const min = flags.log === "silent" ? LEVELS.length : LEVELS.indexOf(flags.log);
  return Object.fromEntries(
    LEVELS.map((level, i) => [
      level,
      i >= min ? console[METHOD[level]].bind(console, `[${scope}]`) : noop,
    ]),
  ) as Record<Level, (...args: unknown[]) => void>;
}
