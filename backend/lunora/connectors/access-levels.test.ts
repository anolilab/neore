import { describe, expect, it } from "vitest";

import { DEFAULT_CONNECTOR_ACCESS, levelOfConnection, strictestLevel, toolOfferedAt } from "./access-levels";

const READ = { readOnlyHint: true };
const WRITE = {};

describe("toolOfferedAt", () => {
    it("offers nothing on a connection set to none", () => {
        expect(toolOfferedAt("none", READ)).toBe(false);
        expect(toolOfferedAt("none", WRITE)).toBe(false);
        expect(toolOfferedAt("none", undefined)).toBe(false);
    });

    it("offers only the tools the server marks read only on a read-only connection", () => {
        expect(toolOfferedAt("read_only", READ)).toBe(true);
        expect(toolOfferedAt("read_only", WRITE)).toBe(false);
        expect(toolOfferedAt("read_only", { readOnlyHint: false })).toBe(false);
        expect(toolOfferedAt("read_only", undefined)).toBe(false);
    });

    it("offers every tool on a read and write connection, as before this existed", () => {
        expect(toolOfferedAt("read_write", READ)).toBe(true);
        expect(toolOfferedAt("read_write", WRITE)).toBe(true);
        expect(toolOfferedAt("read_write", undefined)).toBe(true);
    });
});

describe("levelOfConnection", () => {
    const settings = [
        { connectorSlug: "calendar", level: "read_only" as const },
        { connectorSlug: "mail", level: "none" as const },
    ];

    it("gives a connection its own setting", () => {
        expect(levelOfConnection(settings, "calendar")).toBe("read_only");
        expect(levelOfConnection(settings, "mail")).toBe("none");
    });

    it("gives a connection with no setting the default, read and write", () => {
        expect(levelOfConnection(settings, "crm")).toBe(DEFAULT_CONNECTOR_ACCESS);
        expect(DEFAULT_CONNECTOR_ACCESS).toBe("read_write");
        expect(levelOfConnection([], "calendar")).toBe("read_write");
    });
});

describe("strictestLevel", () => {
    it("is none when any teammate has none", () => {
        expect(strictestLevel(["read_write", "none", "read_only"])).toBe("none");
    });

    it("is read only when none has none but one has read only", () => {
        expect(strictestLevel(["read_write", "read_only"])).toBe("read_only");
    });

    it("is read and write when every teammate has read and write, or there is no teammate", () => {
        expect(strictestLevel(["read_write", "read_write"])).toBe("read_write");
        expect(strictestLevel([])).toBe(DEFAULT_CONNECTOR_ACCESS);
    });
});
