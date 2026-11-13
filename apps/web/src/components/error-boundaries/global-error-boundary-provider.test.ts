/**
 * A global crash report says how much the browser stored, never what: values are unsent text, and keys name accounts
 * and chats.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics/posthog-client", () => {
    return { captureException: vi.fn() };
});

const { storageSize } = await import("./global-error-boundary-provider");

describe(storageSize, () => {
    afterEach(() => {
        localStorage.clear();
    });

    it("counts a storage's entries, and reports neither a key nor a value", () => {
        localStorage.setItem("neore-draft:user-123:chat-456", "my unsent message");

        const size = storageSize(() => localStorage);

        expect(size).toBe(1);

        const report = JSON.stringify({ localStorageSize: size });

        expect(report).not.toContain("user-123");
        expect(report).not.toContain("chat-456");
        expect(report).not.toContain("my unsent message");
    });

    it("answers undefined for a storage that cannot be read", () => {
        expect(
            storageSize(() => {
                throw new DOMException("blocked", "SecurityError");
            }),
        ).toBeUndefined();
    });
});
