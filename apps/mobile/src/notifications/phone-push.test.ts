import { isTaskRegisteredAsync } from "expo-task-manager";
import { afterEach, describe, expect, it, vi } from "vitest";

import { backendPushServer } from "./phone-push";

const mocks = vi.hoisted(() => ({
    pushTaskRegistration: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { easConfig: undefined, expoConfig: undefined } }));
vi.mock("expo-crypto", () => ({ CryptoDigestAlgorithm: { SHA256: "SHA-256" }, digestStringAsync: vi.fn() }));
vi.mock("expo-notifications", () => ({
    AndroidImportance: { HIGH: 4 },
    cancelAllScheduledNotificationsAsync: vi.fn(),
    dismissAllNotificationsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    setNotificationChannelAsync: vi.fn(),
    setNotificationHandler: vi.fn(),
}));
vi.mock("expo-secure-store", () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn() }));
vi.mock("expo-task-manager", () => ({ isTaskRegisteredAsync: vi.fn(async () => true) }));
vi.mock("@neore/backend/api", () => ({
    api: {
        notifications: {
            native_push: {
                getNativePushConfig: "getNativePushConfig",
                registerPushDevice: "registerPushDevice",
                unregisterPushDevice: "unregisterPushDevice",
            },
        },
    },
}));
vi.mock("../auth/secure-store", () => ({ sharedKeychainOps: {} }));
vi.mock("../auth/shared-keychain", () => ({ writeIfDifferent: vi.fn() }));
vi.mock("../lib/config", () => ({ loadConfig: () => ({ lunoraUrl: "https://api.test" }) }));
vi.mock("./approval-actions", () => ({ registerApprovalActions: vi.fn() }));
vi.mock("./background-task", () => ({ pushTaskRegistration: mocks.pushTaskRegistration }));
vi.mock("./pending-tap", () => ({ clearTapRoute: vi.fn() }));

const TOKEN = "ExponentPushToken[a]";

/** The arguments `register` sent to the server's `registerPushDevice`. */
const registeredWith = async (platform: "android" | "ios", language?: string) => {
    const mutation = vi.fn(async (_procedure: unknown, _args: unknown, _options: unknown) => ({ registered: true }));

    await backendPushServer({ mutation, query: vi.fn() } as never).register(platform, TOKEN, language);

    return mutation.mock.calls[0]?.[1];
};

afterEach(() => {
    vi.mocked(isTaskRegisteredAsync).mockReset();
    vi.mocked(isTaskRegisteredAsync).mockResolvedValue(true);
});

describe("backendPushServer.register", () => {
    it("tells the server an Android phone builds its own alert while its task is registered", async () => {
        expect(await registeredWith("android", "de-DE")).toStrictEqual({ buildsAlert: true, language: "de-DE", platform: "android", token: TOKEN });
    });

    it("tells the server an Android phone does not build its alert while its task is not registered", async () => {
        vi.mocked(isTaskRegisteredAsync).mockResolvedValueOnce(false);

        expect(await registeredWith("android")).toStrictEqual({ buildsAlert: false, platform: "android", token: TOKEN });
    });

    it("tells the server an Android phone does not build its alert when the task check fails", async () => {
        vi.mocked(isTaskRegisteredAsync).mockRejectedValueOnce(new Error("task manager unavailable"));

        expect(await registeredWith("android")).toStrictEqual({ buildsAlert: false, platform: "android", token: TOKEN });
    });

    it("waits for the task's registration before it checks the task", async () => {
        const order: string[] = [];

        mocks.pushTaskRegistration.mockImplementationOnce(async () => {
            order.push("registered");
        });
        vi.mocked(isTaskRegisteredAsync).mockImplementationOnce(async () => {
            order.push("checked");

            return true;
        });

        await registeredWith("android");

        expect(order).toStrictEqual(["registered", "checked"]);
    });

    it("sends no buildsAlert for an iOS phone, which has no background task", async () => {
        const args = await registeredWith("ios", "en");

        expect(args).toStrictEqual({ language: "en", platform: "ios", token: TOKEN });
        expect(args).not.toHaveProperty("buildsAlert");
    });
});
