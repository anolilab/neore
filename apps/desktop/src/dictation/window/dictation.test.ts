import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe("the dictation page", () => {
    it("lets go of the microphone and reports a failure when the audio graph cannot be built", async () => {
        const stop = vi.fn();
        const api = { audio: vi.fn(), ended: vi.fn(), failed: vi.fn(), onStop: vi.fn() };

        vi.stubGlobal("neoreDictation", api);
        vi.stubGlobal("document", { querySelector: () => null });
        vi.stubGlobal("navigator", {
            mediaDevices: {
                getUserMedia: async () => {
                    return { getTracks: () => [{ stop }] };
                },
            },
        });
        vi.stubGlobal(
            "AudioContext",
            vi.fn(() => {
                return {
                    close: async () => {},
                    createMediaStreamSource: () => {
                        throw new Error("no graph");
                    },
                };
            }),
        );

        await import("./dictation");

        await vi.waitFor(() => expect(api.failed).toHaveBeenCalledWith("error"));

        expect(stop).toHaveBeenCalledOnce();
    });
});
