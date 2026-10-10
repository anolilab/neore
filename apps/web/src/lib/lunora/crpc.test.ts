import { describe, expect, it } from "vitest";

import type { ApiPath } from "./crpc";

describe("ApiPath (the type NEVER_LIVE is keyed by)", () => {
    it("accepts a generated procedure path and rejects a typo at typecheck", () => {
        const known: ApiPath = "chat_functions:searchThreads";
        // @ts-expect-error — not a procedure: a renamed or misspelled NEVER_LIVE key fails `pnpm lint:types`.
        const typo: ApiPath = "chat_functions:serchThreads";

        expect([known, typo]).toHaveLength(2);
    });
});
