import { describe, expect, it } from "vitest";

import { HOST_RUN_METADATA, isHostRunText } from "./host-run-text";

describe(isHostRunText, () => {
    it("recognises the text of a host reply, and only that", () => {
        expect(isHostRunText({ providerMetadata: HOST_RUN_METADATA, type: "text" })).toBe(true);
        expect(isHostRunText({ providerMetadata: { neore: { runner: "host" } }, type: "text" })).toBe(true);
        expect(isHostRunText({ type: "text" })).toBe(false);
        expect(isHostRunText({ providerMetadata: { neore: { pageContext: {} } }, type: "text" })).toBe(false);
        expect(isHostRunText({ providerMetadata: null, type: "text" })).toBe(false);
        expect(isHostRunText({ providerMetadata: HOST_RUN_METADATA, type: "reasoning" })).toBe(false);
    });
});
