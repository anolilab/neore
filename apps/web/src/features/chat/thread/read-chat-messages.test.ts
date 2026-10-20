import { describe, expect, it, vi } from "vitest";

import { readChatMessages } from "./read-chat-messages";

const message = (order: number, stepOrder = 0) => {
    return { order, role: "user", stepOrder, text: `m${order}.${stepOrder}` };
};

/** A fake page query serving the given pages in order, newest first as the server does. */
const pagesServing = (pages: { isDone: boolean; page: ReturnType<typeof message>[] }[]) => {
    const query = vi.fn(async (_arguments: { paginationOpts: { cursor: null | string } }) => {
        const index = query.mock.calls.length - 1;

        return { ...pages[index]!, continueCursor: `cursor-${index + 1}` };
    });

    return { fetchPage: query as never, query };
};

describe(readChatMessages, () => {
    it("follows the cursor until the chat is done and returns oldest first", async () => {
        const { fetchPage, query } = pagesServing([
            { isDone: false, page: [message(4), message(3)] },
            { isDone: true, page: [message(2), message(1)] },
        ]);

        const messages = await readChatMessages(fetchPage, "thread-1");

        expect(messages.map((item) => item.text)).toStrictEqual(["m1.0", "m2.0", "m3.0", "m4.0"]);
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls[0]![0].paginationOpts.cursor).toBeNull();
        expect(query.mock.calls[1]![0].paginationOpts.cursor).toBe("cursor-1");
    });

    it("orders the steps of one turn", async () => {
        const { fetchPage } = pagesServing([{ isDone: true, page: [message(1, 1), message(1, 0)] }]);

        const messages = await readChatMessages(fetchPage, "thread-1");

        expect(messages.map((item) => item.text)).toStrictEqual(["m1.0", "m1.1"]);
    });

    it("stops after five pages of a long chat", async () => {
        const { fetchPage, query } = pagesServing(
            Array.from({ length: 8 }, (_, index) => {
                return { isDone: false, page: [message(index)] };
            }),
        );

        await readChatMessages(fetchPage, "thread-1");

        expect(query).toHaveBeenCalledTimes(5);
    });

    it("lets a refusal through, so a locked chat attaches nothing", async () => {
        const fetchPage = vi.fn(async () => {
            throw new Error("locked");
        }) as never;

        await expect(readChatMessages(fetchPage, "thread-1")).rejects.toThrow("locked");
    });
});
