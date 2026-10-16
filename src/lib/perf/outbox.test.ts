import { expect, test, vi } from "vitest";
import { installId } from "./outbox";

test("installId is created once, then read back", async () => {
  const stored: Record<string, unknown> = {};
  const set = vi.fn(
    async (items: Record<string, unknown>) => void Object.assign(stored, items),
  );
  vi.stubGlobal("chrome", {
    storage: {
      local: { get: async (key: string) => ({ [key]: stored[key] }), set },
    },
  });
  const [a, b] = await Promise.all([installId(), installId()]);
  expect(a).toMatch(/^[0-9a-f-]{36}$/);
  expect(b).toBe(a);
  expect(stored.installId).toBe(a);
  expect(set).toHaveBeenCalledTimes(1);

  // an existing id (older install, other context) is kept
  vi.resetModules();
  const fresh = await import("./outbox");
  expect(await fresh.installId()).toBe(a);
  expect(set).toHaveBeenCalledTimes(1);
});
