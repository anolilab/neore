import { describe, expect, it } from "vitest";

import { linkKey, pickStatusReads } from "./status-reads";

const link = (number: number, statusReadAt?: number) => {
    return { number, repository: "owner/repo", ...(statusReadAt !== undefined && { statusReadAt }) };
};

describe("pickStatusReads", () => {
    it("reads the links never read first, then the least recently read", () => {
        const links = [link(1, 500), link(2), link(3, 100), link(4, 300), link(5, 200), link(6)];

        expect([...pickStatusReads(links, 3)]).toStrictEqual([linkKey(link(2)), linkKey(link(6)), linkKey(link(3))]);
    });

    it("keeps the list's order for links that were never read", () => {
        const links = [link(1), link(2), link(3)];

        expect([...pickStatusReads(links, 2)]).toStrictEqual([linkKey(link(1)), linkKey(link(2))]);
    });

    it("reaches a link past the first few over the views of one chat", () => {
        let links = [link(1), link(2), link(3), link(4), link(5), link(6), link(7)];
        const readOnViews: string[] = [];

        // Each view reads the picked links and stamps them, as the status read does.
        for (let view = 1; view <= 2; view += 1) {
            const reads = pickStatusReads(links, 5);

            readOnViews.push(...reads);
            links = links.map((item) => (reads.has(linkKey(item)) ? { ...item, statusReadAt: view } : item));
        }

        expect(readOnViews).toContain(linkKey(link(6)));
        expect(readOnViews).toContain(linkKey(link(7)));
    });

    it("reads nothing when the list is empty", () => {
        expect(pickStatusReads([], 5).size).toBe(0);
    });
});
