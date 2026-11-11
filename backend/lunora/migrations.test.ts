import { describe, expect, it } from "vitest";

import { dropThreadIsGroupChat, noteSkillSourcePlugin } from "./migrations";

/** The `up` of a migration, called as the migration runner calls it: one stored document in, the rewritten one out. */
const upOf = (migration: unknown) => (migration as { up: (document: Record<string, unknown>) => unknown }).up;

describe("dropThreadIsGroupChat", () => {
    it("removes the retired flag and keeps every other field", () => {
        const up = upOf(dropThreadIsGroupChat);

        expect(up({ _id: "t1", isGroupChat: true, title: "Panel", userId: "u1" })).toEqual({ _id: "t1", title: "Panel", userId: "u1" });
    });

    it("skips a row that never had the flag", () => {
        const up = upOf(dropThreadIsGroupChat);

        expect(up({ _id: "t2", title: "Plain", userId: "u1" })).toBeUndefined();
    });
});

describe("noteSkillSourcePlugin", () => {
    it("skips every row, since the new source member only adds a case", () => {
        const up = upOf(noteSkillSourcePlugin);

        expect(up({ _id: "s1", source: { type: "editor" }, userId: "u1" })).toBeUndefined();
        expect(up({ _id: "s2", source: { type: "plugin", version: "1.0.0" }, userId: "u1" })).toBeUndefined();
    });
});
