/**
 * A global crash report names what the browser stored, never the values: drafts and queued prompts are unsent text.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analytics/posthog-client", () => {
    return { captureException: vi.fn() };
});

const { storageKeys } = await import("./global-error-boundary-provider");

describe(storageKeys, () => {
    afterEach(() => {
        localStorage.clear();
    });

    it("lists the keys a storage holds, and none of its values", () => {
        localStorage.setItem("neore-draft:thread-1", "my unsent message");

        const keys = storageKeys(() => localStorage);

        expect(keys).toStrictEqual(["neore-draft:thread-1"]);
        expect(JSON.stringify(keys)).not.toContain("my unsent message");
    });

    it("answers no keys for a storage that cannot be read", () => {
        expect(
            storageKeys(() => {
                throw new DOMException("blocked", "SecurityError");
            }),
        ).toStrictEqual([]);
    });
});
