import { describe, expect, it } from "vitest";

import { validateSlug } from "./validators";

describe(validateSlug, () => {
    it.each(["clear", "compact"])("refuses %s, the name of a composer command a skill would shadow", (slug) => {
        expect.assertions(1);

        expect(validateSlug(slug).valid).toBe(false);
    });

    it("accepts a slug that only starts with a command's name", () => {
        expect.assertions(1);

        expect(validateSlug("clear-notes").valid).toBe(true);
    });
});
