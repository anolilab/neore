import { describe, expect, it } from "vitest";

import { hostProblemOf } from "./event-webhook-host-input";

describe("hostProblemOf", () => {
    it.each([
        ["", "empty"],
        [" ".repeat(3), "empty"],
        ["https://hooks.example.com", "scheme"],
        ["hooks.example.com/neore", "path"],
        ["hooks.example.com?x=1", "path"],
        ["user@hooks.example.com", "path"],
        ["hooks.example.com:8443", "port"],
        ["192.0.2.10", "ip_address"],
        ["[2001:db8::1]", "port"],
        ["hooks_example.com", "invalid_characters"],
        [`${"a".repeat(64)}.${"b".repeat(64)}.${"c".repeat(64)}.${"d".repeat(64)}`, "long"],
    ])("refuses %j as %s", (value, problem) => {
        expect(hostProblemOf(value)).toBe(problem);
    });

    it.each(["hooks.example.com", "  Hooks.Example.COM  ", "a-b.example.org", "localhost-hook.dev"])("accepts %j", (value) => {
        expect(hostProblemOf(value)).toBeNull();
    });
});
