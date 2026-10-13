import { flags } from "@/flags";

// Counters surviving SW + offscreen restarts. Separate from src/perf: needs chrome, tests don't have it.

export async function bumpSessionCounter(name: string): Promise<void> {
  if (!flags.perf.enabled) return;
  const { [name]: value = 0 } = await chrome.storage.session.get(name);
  await chrome.storage.session.set({ [name]: (value as number) + 1 });
}

/** Reset on browser restart. */
export const SESSION_COUNTERS = ["sw.starts", "offscreen.creations"] as const;
