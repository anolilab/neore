import { describe, expect, it, vi } from "vitest";

import { pushServerFor } from "./push-server";

const TOKEN = "ExponentPushToken[a]";

/** A task check that answers `isRegistered`. */
const answers = (isRegistered: boolean) => async (): Promise<boolean> => isRegistered;

/** The arguments `register` sent to the server's `registerPushDevice`, after `isEnabled` as the registration flow calls it. */
const registeredWith = async (platform: "android" | "ios", isRegistered: () => Promise<boolean>, language?: string) => {
    const query = vi.fn(async (_procedure: unknown, _args: unknown) => {
        return { enabled: true };
    });
    const mutation = vi.fn(async (_procedure: unknown, _args: unknown, _options: unknown) => {
        return { registered: true };
    });
    const server = pushServerFor({ mutation, query } as never, isRegistered);

    await server.isEnabled();
    await server.register(platform, TOKEN, language);

    return mutation.mock.calls[0]?.[1];
};

describe("pushServerFor's register", () => {
    it("tells the server an Android phone builds its own alert while its task is registered", async () => {
        expect(await registeredWith("android", answers(true), "de-DE")).toStrictEqual({
            buildsAlert: true,
            language: "de-DE",
            platform: "android",
            token: TOKEN,
        });
    });

    it("tells the server an Android phone does not build its alert while its task is not registered", async () => {
        expect(await registeredWith("android", answers(false))).toStrictEqual({ buildsAlert: false, platform: "android", token: TOKEN });
    });

    it("sends no buildsAlert for an iOS phone, which has no background task", async () => {
        const args = await registeredWith("ios", answers(true), "en");

        expect(args).toStrictEqual({ language: "en", platform: "ios", token: TOKEN });
        expect(args).not.toHaveProperty("buildsAlert");
    });

    it("reads the task check before register, so no await sits between the sign-out checks and the send", async () => {
        const order: string[] = [];
        const query = vi.fn(async (_procedure: unknown, _args: unknown) => {
            return { enabled: true };
        });
        const mutation = vi.fn(async (_procedure: unknown, _args: unknown, _options: unknown) => {
            order.push("sent");

            return { registered: true };
        });
        const isRegistered = vi.fn(async (): Promise<boolean> => {
            order.push("checked");

            return true;
        });
        const server = pushServerFor({ mutation, query } as never, isRegistered);

        await server.isEnabled();
        order.push("signed-in check");
        await server.register("android", TOKEN, undefined);

        expect(order).toStrictEqual(["checked", "signed-in check", "sent"]);
    });
});
