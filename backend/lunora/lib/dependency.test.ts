import { LunoraError } from "lunorash/server";
import { describe, expect, it } from "vitest";

import { withDependency } from "./dependency";

describe("withDependency", () => {
    it("returns the value of a synchronous or asynchronous call", async () => {
        expect(await withDependency("file storage", () => "url")).toBe("url");
        expect(await withDependency("mail", async () => 42)).toBe(42);
    });

    it("rethrows a failure as SERVICE_UNAVAILABLE naming the dependency", async () => {
        const cause = new Error("socket reset");

        const failure = await withDependency("mail", async () => {
            throw cause;
        }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(LunoraError);
        expect(failure).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "mail failed", cause });
    });

    it("passes a coded error from the call through unchanged", async () => {
        const original = new LunoraError("NOT_FOUND", "gone");

        const failure = await withDependency("file storage", async () => {
            throw original;
        }).catch((error: unknown) => error);

        expect(failure).toBe(original);
    });
});
