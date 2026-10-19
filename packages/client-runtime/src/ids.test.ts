import { describe, expect, it } from "vitest";

import { isLunoraId, LUNORA_ID_SOURCE } from "./ids";

describe(isLunoraId, () => {
    it("accepts the UUID a new thread actually gets", () => {
        expect(isLunoraId("1d0e2944-748e-4cd8-b8f4-7cd88273786a")).toBe(true);
    });

    it("rejects the legacy 32-char shape, uppercase, and path junk", () => {
        expect(isLunoraId("jd7a2k9x1m3n5p7q9r1s3t5v7w9y1z3b")).toBe(false);
        expect(isLunoraId("1D0E2944-748E-4CD8-B8F4-7CD88273786A")).toBe(false);
        expect(isLunoraId("1d0e2944-748e-4cd8-b8f4-7cd88273786a/../x")).toBe(false);
    });

    it("embeds into a path pattern with its own anchors", () => {
        const path = new RegExp(`^/chat/(${LUNORA_ID_SOURCE})$`);

        expect("/chat/1d0e2944-748e-4cd8-b8f4-7cd88273786a".match(path)?.[1]).toBe("1d0e2944-748e-4cd8-b8f4-7cd88273786a");
    });
});
