import { MAX_THREAD_TITLE_INSTRUCTIONS_LENGTH } from "@neore/ai/constants";
import { v } from "lunorash/server";
import { describe, expect, it } from "vitest";

import { validate } from "../lib/validators";
import { userSettingsFieldsWithoutUserId } from "./fields";

const settings = v.object(userSettingsFieldsWithoutUserId);

describe("userSettings.threadTitleInstructions", () => {
    it("is optional", () => {
        expect(validate(settings, {})).toBe(true);
    });

    it("accepts text up to the cap", () => {
        expect(validate(settings, { threadTitleInstructions: "x".repeat(MAX_THREAD_TITLE_INSTRUCTIONS_LENGTH) })).toBe(true);
    });

    it("accepts an empty string, which is how a client clears it", () => {
        expect(validate(settings, { threadTitleInstructions: "" })).toBe(true);
    });

    it("rejects text over the cap", () => {
        expect(validate(settings, { threadTitleInstructions: "x".repeat(MAX_THREAD_TITLE_INSTRUCTIONS_LENGTH + 1) })).toBe(false);
    });
});
