import { describe, expect, it } from "vitest";

import { rememberWorkspaceRoute, workspaceOf, workspaceTarget } from "./workspace-memory";

const memoryStore = (initial: string | null = null) => {
    let value = initial;

    return {
        getItem: () => value,
        setItem: (_key: string, next: string) => {
            value = next;
        },
    };
};

describe("workspace memory", () => {
    it("maps a pathname to its workspace", () => {
        expect(workspaceOf("/chat")).toBe("chat");
        expect(workspaceOf("/chat/abc")).toBe("chat");
        expect(workspaceOf("/code")).toBe("code");
        expect(workspaceOf("/codex")).toBeUndefined();
        expect(workspaceOf("/dashboard")).toBeUndefined();
    });

    it("falls back to the root with nothing remembered", () => {
        expect(workspaceTarget(memoryStore(), "chat")).toBe("/chat");
        expect(workspaceTarget(undefined, "code")).toBe("/code");
    });

    it("remembers each workspace separately", () => {
        const store = memoryStore();

        rememberWorkspaceRoute(store, "/chat/abc");
        rememberWorkspaceRoute(store, "/code/pr/7");
        rememberWorkspaceRoute(store, "/dashboard");

        expect(workspaceTarget(store, "chat")).toBe("/chat/abc");
        expect(workspaceTarget(store, "code")).toBe("/code/pr/7");
    });

    it("survives corrupt storage", () => {
        expect(workspaceTarget(memoryStore("{nope"), "chat")).toBe("/chat");
        expect(workspaceTarget(memoryStore('{"chat":"/code/x"}'), "chat")).toBe("/chat");
        // Valid JSON whose value is not a path must not throw at `startsWith`.
        expect(workspaceTarget(memoryStore('{"chat":123}'), "chat")).toBe("/chat");
        expect(workspaceTarget(memoryStore('{"chat":{"a":1}}'), "chat")).toBe("/chat");
    });
});
