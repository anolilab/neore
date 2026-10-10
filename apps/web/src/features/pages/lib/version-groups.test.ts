import { describe, expect, it } from "vitest";

import { dayKind, groupVersionsByDay } from "./version-groups";

const at = (iso: string) => new Date(iso).getTime();
const version = (id: string, iso: string) => {
    return { _id: id, createdAt: at(iso), updatedAt: at(iso) };
};

describe("groupVersionsByDay", () => {
    it("groups newest first by local day", () => {
        const groups = groupVersionsByDay([version("a", "2026-09-20T09:00:00"), version("b", "2026-09-21T10:00:00"), version("c", "2026-09-21T08:00:00")]);

        expect(groups.map((group) => group.versions.map((entry) => entry._id))).toEqual([["b", "c"], ["a"]]);
    });

    it("labels today and yesterday", () => {
        const now = at("2026-09-21T12:00:00");
        const [today, yesterday, earlier] = groupVersionsByDay([
            version("a", "2026-09-21T09:00:00"),
            version("b", "2026-09-20T09:00:00"),
            version("c", "2026-09-01T09:00:00"),
        ]);

        expect(dayKind(today!.day, now)).toBe("today");
        expect(dayKind(yesterday!.day, now)).toBe("yesterday");
        expect(dayKind(earlier!.day, now)).toBe("earlier");
    });
});
