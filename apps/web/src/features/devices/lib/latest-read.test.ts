import { describe, expect, it } from "vitest";

import { createLatestRead } from "./latest-read";

describe("createLatestRead", () => {
    it("ignores an older read that resolves after a newer one", async () => {
        const resolvers: ((value: string) => void)[] = [];
        const applied: string[] = [];
        const refresh = createLatestRead(
            () =>
                new Promise<string>((resolve) => {
                    resolvers.push(resolve);
                }),
            (value) => {
                applied.push(value);
            },
        );

        refresh();
        refresh();
        resolvers.at(1)?.("connected");
        await Promise.resolve();
        resolvers.at(0)?.("failed");
        await Promise.resolve();
        await Promise.resolve();

        expect(applied).toEqual(["connected"]);
    });
});
