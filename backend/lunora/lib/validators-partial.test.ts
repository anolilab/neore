/**
 * `partial` on the `pick(...)` record every patch procedure passes it. It used
 * to return a record unchanged, so `updateProject` refused any patch without a
 * `title` at runtime — the gallery fork-count bump and workflow content saves.
 */
import { v } from "lunorash/server";
import { describe, expect, it } from "vitest";

import { partial } from "./validators";

describe("partial", () => {
    it("makes every field of a picked record optional, keeping each field's type", () => {
        const patch = v.object(partial({ count: v.optional(v.number()), title: v.string() }));

        expect(patch.parse({})).toEqual({});
        expect(patch.parse({ count: 2 })).toEqual({ count: 2 });
        expect(() => patch.parse({ title: 3 })).toThrow();
    });
});
