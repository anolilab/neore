import { describe, expect, it } from "vitest";

import { offeredModels, resolveModel, SMALL, unsupportedReason } from "./catalog.js";

describe("unsupportedReason", () => {
    it.each([
        ["darwin", "arm64"],
        ["linux", "x64"],
        ["linux", "arm64"],
        ["win32", "x64"],
        ["win32", "arm64"],
    ] as const)("offers on-device dictation on %s %s", (platform, arch) => {
        expect(unsupportedReason(platform, arch)).toBeUndefined();
    });

    it.each([
        ["darwin", "x64", "Intel Macs"],
        ["freebsd", "x64", "this system"],
        ["linux", "ia32", "this system"],
    ] as const)("marks %s %s unsupported, with a reason a person can read", (platform, arch, mention) => {
        expect(unsupportedReason(platform, arch)).toContain(mention);
    });

    // The runner this suite runs on says what it must be: a platform that CI cannot prove is marked unsupported, and CI asserts it.
    it.runIf(process.env.NEORE_DICTATION_EXPECT !== undefined)("agrees with what CI expects of this runner", () => {
        const reason = unsupportedReason(process.platform, process.arch);

        expect(reason === undefined ? "supported" : "unsupported").toBe(process.env.NEORE_DICTATION_EXPECT);
    });
});

describe("the default model without a GPU", () => {
    it.each([
        ["linux", "x64"],
        ["linux", "arm64"],
        ["win32", "x64"],
        ["win32", "arm64"],
    ] as const)("is small on %s %s", (platform, arch) => {
        expect(resolveModel(undefined, platform, arch)).toBe(SMALL);
        expect(offeredModels(platform, arch).find(({ isDefault }) => isDefault)?.spec).toBe(SMALL);
    });
});
