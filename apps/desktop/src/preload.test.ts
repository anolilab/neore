/**
 * The site preload's menu-command subscription, with `electron` mocked: the main process is told when the page starts
 * listening and when its last subscriber leaves.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { CAPABILITIES_ARG, CHANNEL, SITE_ORIGIN_ARG } from "./channels.js";

const SITE = "http://localhost:5173";

const electron = vi.hoisted(() => {
    return {
        exposed: {} as Record<string, unknown>,
        listeners: new Map<string, Set<unknown>>(),
        sent: [] as string[],
    };
});

vi.mock("electron", () => {
    return {
        contextBridge: {
            exposeInMainWorld: (key: string, api: unknown) => {
                electron.exposed[key] = api;
            },
        },
        ipcRenderer: {
            invoke: () => Promise.resolve(),
            on: (channel: string, listener: unknown) => {
                const set = electron.listeners.get(channel) ?? new Set();

                set.add(listener);
                electron.listeners.set(channel, set);
            },
            removeListener: (channel: string, listener: unknown) => {
                electron.listeners.get(channel)?.delete(listener);
            },
            send: (channel: string) => {
                electron.sent.push(channel);
            },
        },
    };
});

type Subscribe = (handler: (command: string) => void) => () => void;

const onMenuCommand = (): Subscribe => (electron.exposed.neoreNative as { onMenuCommand: Subscribe }).onMenuCommand;
const menuListeners = (): number => electron.listeners.get(CHANNEL.menuCommand)?.size ?? 0;

describe("onMenuCommand", () => {
    beforeAll(async () => {
        process.argv.push(`${SITE_ORIGIN_ARG}${SITE}`, `${CAPABILITIES_ARG}menu-commands`);
        vi.stubGlobal("document", { location: { origin: SITE } });

        await import("./preload.js");
    });

    it("says ready on each subscribe, and unready only when the last subscriber leaves, once", () => {
        const first = onMenuCommand()(() => {});
        const second = onMenuCommand()(() => {});

        expect(electron.sent).toStrictEqual([CHANNEL.menuCommandsReady, CHANNEL.menuCommandsReady]);
        expect(menuListeners()).toBe(2);

        first();
        first();
        expect(electron.sent).toStrictEqual([CHANNEL.menuCommandsReady, CHANNEL.menuCommandsReady]);
        expect(menuListeners()).toBe(1);

        second();
        expect(electron.sent).toStrictEqual([CHANNEL.menuCommandsReady, CHANNEL.menuCommandsReady, CHANNEL.menuCommandsUnready]);
        expect(menuListeners()).toBe(0);

        onMenuCommand()(() => {});
        expect(electron.sent.at(-1)).toBe(CHANNEL.menuCommandsReady);
    });
});
