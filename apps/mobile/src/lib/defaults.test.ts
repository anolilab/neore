import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_CHAT_MODEL } from "./defaults";

const SHARED_DEFAULT = /export const DEFAULT_CHAT_MODEL = "([^"]+)";/;

describe("DEFAULT_CHAT_MODEL", () => {
    it("matches the shared default in packages/ai, which the app mirrors instead of bundling the registry", () => {
        const source = readFileSync(new URL("../../../../packages/ai/src/constants.ts", import.meta.url), "utf8");
        const shared = SHARED_DEFAULT.exec(source)?.[1];

        expect(shared).toBeDefined();
        expect(DEFAULT_CHAT_MODEL).toBe(shared);
    });
});
