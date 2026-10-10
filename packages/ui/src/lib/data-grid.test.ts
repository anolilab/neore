import { describe, expect, it } from "vitest";

import {
    getCellKey,
    getColumnVariant,
    getIsFileCellData,
    getLineCount,
    getRowHeightValue,
    getScrollDirection,
    matchSelectOption,
    parseCellKey,
} from "./data-grid";

describe("getCellKey", () => {
    it("should create cell key from row index and column id", () => {
        expect(getCellKey(0, "name")).toBe("0:name");
        expect(getCellKey(5, "email")).toBe("5:email");
        expect(getCellKey(100, "col-1")).toBe("100:col-1");
    });
});

describe("parseCellKey", () => {
    it("should parse valid cell key", () => {
        expect(parseCellKey("0:name")).toEqual({ columnId: "name", rowIndex: 0 });
        expect(parseCellKey("5:email")).toEqual({ columnId: "email", rowIndex: 5 });
    });

    it("should return defaults for invalid cell key", () => {
        expect(parseCellKey("")).toEqual({ columnId: "", rowIndex: 0 });
        expect(parseCellKey("invalid")).toEqual({ columnId: "", rowIndex: 0 });
        expect(parseCellKey("abc:name")).toEqual({ columnId: "", rowIndex: 0 });
    });

    it("should round-trip with getCellKey", () => {
        const key = getCellKey(42, "test-col");
        const parsed = parseCellKey(key);

        expect(parsed).toEqual({ columnId: "test-col", rowIndex: 42 });
    });
});

describe("getRowHeightValue", () => {
    it("should return correct pixel values for row heights", () => {
        expect(getRowHeightValue("short")).toBe(36);
        expect(getRowHeightValue("medium")).toBe(56);
        expect(getRowHeightValue("tall")).toBe(76);
        expect(getRowHeightValue("extra-tall")).toBe(96);
    });
});

describe("getLineCount", () => {
    it("should return correct line counts for row heights", () => {
        expect(getLineCount("short")).toBe(1);
        expect(getLineCount("medium")).toBe(2);
        expect(getLineCount("tall")).toBe(3);
        expect(getLineCount("extra-tall")).toBe(4);
    });
});

describe("getScrollDirection", () => {
    it("should return valid directions as-is", () => {
        expect(getScrollDirection("left")).toBe("left");
        expect(getScrollDirection("right")).toBe("right");
        expect(getScrollDirection("home")).toBe("home");
        expect(getScrollDirection("end")).toBe("end");
    });

    it("should map pageleft to left", () => {
        expect(getScrollDirection("pageleft")).toBe("left");
    });

    it("should map pageright to right", () => {
        expect(getScrollDirection("pageright")).toBe("right");
    });

    it("should return undefined for unknown directions", () => {
        expect(getScrollDirection("up")).toBeUndefined();
        expect(getScrollDirection("down")).toBeUndefined();
        expect(getScrollDirection("")).toBeUndefined();
    });
});

describe("matchSelectOption", () => {
    const options = [
        { label: "Active", value: "active" },
        { label: "Inactive", value: "inactive" },
        { label: "Pending Review", value: "pending" },
    ];

    it("should match by exact value", () => {
        expect(matchSelectOption("active", options)).toBe("active");
    });

    it("should match by case-insensitive value", () => {
        expect(matchSelectOption("ACTIVE", options)).toBe("active");
        expect(matchSelectOption("Active", options)).toBe("active");
    });

    it("should match by case-insensitive label", () => {
        expect(matchSelectOption("pending review", options)).toBe("pending");
    });

    it("should return undefined for no match", () => {
        expect(matchSelectOption("unknown", options)).toBeUndefined();
    });
});

describe("getIsFileCellData", () => {
    it("should return true for valid file cell data", () => {
        expect(getIsFileCellData({ id: "1", name: "file.txt", size: 100, type: "text/plain" })).toBe(true);
    });

    it("should return false for non-object values", () => {
        expect(getIsFileCellData(null)).toBe(false);
        expect(getIsFileCellData(undefined)).toBe(false);
        expect(getIsFileCellData("string")).toBe(false);
        expect(getIsFileCellData(42)).toBe(false);
    });

    it("should return false for objects missing required fields", () => {
        expect(getIsFileCellData({ id: "1", name: "file.txt" })).toBe(false);
        expect(getIsFileCellData({ id: "1" })).toBe(false);
        expect(getIsFileCellData({})).toBe(false);
    });
});

describe("getColumnVariant", () => {
    it("should return correct info for known variants", () => {
        expect(getColumnVariant("short-text")).toEqual(expect.objectContaining({ label: "Short text" }));
        expect(getColumnVariant("long-text")).toEqual(expect.objectContaining({ label: "Long text" }));
        expect(getColumnVariant("number")).toEqual(expect.objectContaining({ label: "Number" }));
        expect(getColumnVariant("url")).toEqual(expect.objectContaining({ label: "URL" }));
        expect(getColumnVariant("checkbox")).toEqual(expect.objectContaining({ label: "Checkbox" }));
        expect(getColumnVariant("select")).toEqual(expect.objectContaining({ label: "Select" }));
        expect(getColumnVariant("multi-select")).toEqual(expect.objectContaining({ label: "Multi-select" }));
        expect(getColumnVariant("date")).toEqual(expect.objectContaining({ label: "Date" }));
        expect(getColumnVariant("file")).toEqual(expect.objectContaining({ label: "File" }));
    });

    it("should return null for unknown variant", () => {
        expect(getColumnVariant("unknown" as any)).toBeNull();
        expect(getColumnVariant(undefined)).toBeNull();
    });

    it("should include an icon component for each variant", () => {
        const result = getColumnVariant("short-text");

        expect(result).not.toBeNull();
        expect(result!.icon).toBeTruthy();
    });
});
