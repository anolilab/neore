import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendTelegramMessage } from "./telegram";

const { fetchWithDeadline } = vi.hoisted(() => {
    return { fetchWithDeadline: vi.fn() };
});

vi.mock("../../lib/fetch-timeout", () => {
    return { FETCH_TIMEOUT_LONG_MS: 1, FETCH_TIMEOUT_SHORT_MS: 1, fetchOk: vi.fn(), fetchWithDeadline };
});

const reply = (status: number) => new Response(status === 200 ? "{}" : '{"description":"can\'t parse entities"}', { status });

describe("sendTelegramMessage", () => {
    beforeEach(() => {
        fetchWithDeadline.mockReset();
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("counts a chunk as sent once its plain-text retry succeeds", async () => {
        fetchWithDeadline.mockResolvedValueOnce(reply(400)).mockResolvedValueOnce(reply(200));

        await expect(sendTelegramMessage("token", 1, "plain **bold** text")).resolves.toBe(true);
        expect(fetchWithDeadline).toHaveBeenCalledTimes(2);
    });

    it("reports failure when the plain-text retry is rejected", async () => {
        fetchWithDeadline.mockResolvedValueOnce(reply(400)).mockResolvedValueOnce(reply(500));

        await expect(sendTelegramMessage("token", 1, "plain text")).resolves.toBe(false);
    });
});

describe("sendTelegramMessage with an empty reply", () => {
    it("reports nothing sent when there is nothing to send", async () => {
        fetchWithDeadline.mockReset();

        await expect(sendTelegramMessage("token", 1, " ".repeat(3))).resolves.toBe(false);
        expect(fetchWithDeadline).not.toHaveBeenCalled();
    });
});
