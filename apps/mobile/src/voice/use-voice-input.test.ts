// @vitest-environment jsdom
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useVoiceInput } from "./use-voice-input";

/** A promise the test settles by hand: each await of a press is held at one of these while the screen goes. */
const deferred = <T>() => {
    let resolve: (value: T) => void = () => {};
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- `Promise.withResolvers` needs Node 22.11; the package allows 22.0
    const promise = new Promise<T>((_resolve) => {
        resolve = _resolve;
    });

    return { promise, resolve };
};

const native = vi.hoisted(() => {
    return {
        created: 0,
        /** The clip files deleted, by path. */
        deleted: [] as string[],
        prepare: undefined as Promise<void> | undefined,
        released: 0,
    };
});

const audio = vi.hoisted(() => {
    return {
        getRecordingPermissionsAsync: vi.fn(async () => {
            return { granted: true };
        }),
        requestRecordingPermissionsAsync: vi.fn(async () => {
            return { granted: true };
        }),
        setAudioModeAsync: vi.fn(async (_mode: { allowsRecording: boolean }) => {}),
    };
});

// The recorder and the audio session are native modules that cannot load in Node; these count what a press makes.
// eslint-disable-next-line no-restricted-syntax -- expo-audio is a native module; there is nothing to inject into the hook
vi.mock(import("expo-audio"), () => {
    // The hook calls it with `new`, so a function, not an arrow: the object it returns is the recorder.
    const AudioRecorder = function AudioRecorder() {
        native.created += 1;

        let isReleased = false;

        return {
            prepareToRecordAsync: async () => {
                await native.prepare;
            },
            record: () => {},
            release: () => {
                isReleased = true;
                native.released += 1;
            },
            stop: async () => {},
            // A released native object can refuse to answer: this one throws, as the worst case.
            get uri() {
                if (isReleased) {
                    throw new Error("The recorder was released.");
                }

                return "file:///clip.m4a";
            },
        };
    };

    return {
        AudioModule: { AudioRecorder },
        AudioQuality: { LOW: 0 },
        IOSOutputFormat: { MPEG4AAC: "aac " },
        ...audio,
    } as never;
});

// eslint-disable-next-line no-restricted-syntax -- part of the native expo-audio package, see above
vi.mock(import("expo-audio/build/utils/options"), () => ({ createRecordingOptions: (options: unknown) => options }) as never);

// eslint-disable-next-line no-restricted-syntax -- the file system is a native module; no clip is written here
vi.mock(import("expo-file-system"), () => {
    // Called with `new` by the hook, like the recorder above.
    const File = function File(uri: string) {
        return {
            delete: () => {
                native.deleted.push(uri);
            },
            exists: true,
        };
    };

    return { File } as never;
});

// eslint-disable-next-line no-restricted-syntax -- the client opens a socket on import; no request is made here
vi.mock(import("../lib/lunora"), () => {
    const client = {};

    return { getClient: () => client } as never;
});

const hook: { start?: () => Promise<void> } = {};

const Composer = () => {
    hook.start = useVoiceInput({ onText: () => {} }).start;

    return null;
};

describe(useVoiceInput, () => {
    const mounted: { root?: Root } = {};

    const mount = () => {
        act(() => {
            mounted.root?.render(createElement(Composer));
        });
    };

    const unmount = () => {
        act(() => {
            mounted.root?.unmount();
        });
    };

    beforeEach(() => {
        native.created = 0;
        native.released = 0;
        native.deleted = [];
        native.prepare = undefined;
        vi.clearAllMocks();
        // React reads this to allow `act` outside a testing library.
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
        mounted.root = createRoot(document.createElement("div"));
    });

    it("makes no recorder when the screen goes while the permission is read", async () => {
        const permission = deferred<{ granted: boolean }>();

        audio.getRecordingPermissionsAsync.mockReturnValueOnce(permission.promise);
        mount();

        const pressing = hook.start?.();

        unmount();
        permission.resolve({ granted: true });
        await pressing;

        expect(native.created).toBe(0);
        expect(audio.setAudioModeAsync).not.toHaveBeenCalled();
    });

    it("makes no recorder and gives the session back when the screen goes while it switches to recording", async () => {
        const switching = deferred<undefined>();

        audio.setAudioModeAsync.mockReturnValueOnce(switching.promise);
        mount();

        const pressing = hook.start?.();

        await act(async () => {
            await Promise.resolve();
        });
        unmount();
        switching.resolve(undefined);
        await pressing;

        expect(native.created).toBe(0);
        expect(audio.setAudioModeAsync.mock.calls.map(([mode]) => mode.allowsRecording)).toStrictEqual([true, false]);
    });

    it("releases a recorder the screen left mid-prepare once the prepare has settled, not before", async () => {
        const preparing = deferred<undefined>();

        native.prepare = preparing.promise;
        mount();

        const pressing = hook.start?.();

        await vi.waitFor(() => {
            expect(native.created).toBe(1);
        });
        unmount();

        expect(native.released).toBe(0);

        preparing.resolve(undefined);
        await pressing;

        expect(native.released).toBe(1);
        expect(audio.setAudioModeAsync.mock.calls.at(-1)?.[0].allowsRecording).toBe(false);
    });

    it("deletes the clip of a press whose screen went mid-prepare, though the released recorder no longer answers", async () => {
        const preparing = deferred<undefined>();

        native.prepare = preparing.promise;
        mount();

        const pressing = hook.start?.();

        await vi.waitFor(() => {
            expect(native.created).toBe(1);
        });
        unmount();
        preparing.resolve(undefined);
        await pressing;

        expect(native.released).toBe(1);
        expect(native.deleted).toStrictEqual(["file:///clip.m4a"]);
    });

    it("releases the recorder of a screen that goes after it was made, as before", async () => {
        mount();
        await hook.start?.();

        expect(native.created).toBe(1);

        unmount();

        expect(native.released).toBe(1);
    });
});
