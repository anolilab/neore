import type { vi } from "vitest";

/**
 * The action or mutation context a harness test passes to a function that only calls `runMutation`, with the mock it records calls on.
 * Tests cast their fake context to this, rather than repeating the cast's shape in each file.
 */
export type MockRunContext = { runMutation: ReturnType<typeof vi.fn> };
