import { describe, expect, it } from "vitest";

import { promptHeading, promptOrigin } from "./prompt-origin";

describe("prompt origin", () => {
    it("never says the agent asked for a global instruction read, whatever title the call carries", () => {
        expect(promptOrigin("instructions_read", "Import into a project's rule files")).toBe("Requested from a project's settings in Neore, not by the agent.");
        expect(promptOrigin("instructions_list", "")).toBe("Requested from a project's settings in Neore, not by the agent.");
        expect(promptHeading("instructions_read", undefined)).toBe("Send global instruction files to Neore?");
    });

    it("keeps the agent's wording for every other tool", () => {
        expect(promptOrigin("fs_read", "Build")).toBe("Requested by the agent in “Build”.");
        expect(promptOrigin("fs_read", "")).toBe("Requested by the agent.");
        expect(promptHeading("fs_read", "box")).toBe("Allow “fs_read” on box?");
    });
});
