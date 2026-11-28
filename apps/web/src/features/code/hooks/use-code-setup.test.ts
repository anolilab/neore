import { describe, expect, it } from "vitest";

import { codeSetupState } from "./use-code-setup";

const paired = { lastSeenAt: 1 };
const withAgent = { acpOffers: [{}], lastSeenAt: 1 };
const server = { lastSeenAt: 1, transport: "ssh" as const };
const base = { devicesFailed: false, settingsFailed: false };

describe("codeSetupState", () => {
    it("waits for both reads", () => {
        expect(codeSetupState({ ...base, devices: undefined, skipped: {} })).toBe("loading");
        expect(codeSetupState({ ...base, devices: [], skipped: undefined })).toBe("loading");
    });

    it("needs setup when nothing is paired, also for an account with no settings row", () => {
        expect(codeSetupState({ ...base, devices: [], skipped: null })).toBe("needed");
    });

    it("stays needed while a step is open", () => {
        expect(codeSetupState({ ...base, devices: [paired], skipped: { setupStepsSkipped: ["ssh"] } })).toBe("needed");
    });

    it("is ready when every step is done or skipped", () => {
        expect(codeSetupState({ ...base, devices: [withAgent, server], skipped: {} })).toBe("ready");
        expect(codeSetupState({ ...base, devices: [], skipped: { setupStepsSkipped: ["pair", "ssh", "agent"] } })).toBe("ready");
    });

    it("shows the checklist, with its retry, when a read failed", () => {
        expect(codeSetupState({ ...base, devices: undefined, devicesFailed: true, skipped: undefined })).toBe("needed");
        expect(codeSetupState({ ...base, devices: [withAgent, server], settingsFailed: true, skipped: undefined })).toBe("needed");
    });
});
