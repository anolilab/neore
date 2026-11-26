import type { vi } from "vitest";

/** A fake action or mutation context whose `runMutation` is a mock that records its calls. */
export type MockRunContext = { runMutation: ReturnType<typeof vi.fn> };
