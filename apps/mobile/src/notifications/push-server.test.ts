import { describe, expect, it, vi } from "vitest";

import { pushServerFor } from "./push-server";

const TOKEN = "ExponentPushToken[a]";

/** A task check that answers `isRegistered`. */
const answers = (isRegistered: boolean) => async (): Promise<boolean> => isRegistered;

/** The arguments `register` sent to the server's `registerPushDevice`. */
const registeredWith = async (platform: "android" | "ios", isRegistered: () => Promise<boolean>, language?: string) => {
    const mutation = vi.fn(async (_procedure: unknown, _args: unknown, _options: unknown) => {
        return { registered: true };
    });

    await pushServerFor({ mutation } as never, isRegistered).register(platform, TOKEN, language);

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
        const isRegistered = vi.fn(async (): Promise<boolean> => true);

        const args = await registeredWith("ios", isRegistered, "en");

        expect(args).toStrictEqual({ language: "en", platform: "ios", token: TOKEN });
        expect(args).not.toHaveProperty("buildsAlert");
        expect(isRegistered).not.toHaveBeenCalled();
    });
});
