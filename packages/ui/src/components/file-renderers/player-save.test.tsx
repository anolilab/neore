// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import AudioWaveformPlayer from "./audio-waveform-player";
import VideoPlayer from "./video-player";

const { saveFromUrl, waveHandlers } = vi.hoisted(() => {
    return {
        saveFromUrl: vi.fn((_url: string, _filename?: string, _fallbackName?: string) => Promise.resolve()),
        waveHandlers: new Map<string, () => void>(),
    };
});

// eslint-disable-next-line no-restricted-syntax -- vi.mock is hoisted; the download call is the thing under test
vi.mock("@ui/utils/save-from-url", () => {
    return { saveFromUrl };
});

// eslint-disable-next-line no-restricted-syntax -- vi.mock is hoisted; there is nothing to inject into
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                t: (strings: TemplateStringsArray, ...values: unknown[]) =>
                    strings.reduce((out, part, index) => `${out}${part}${index < values.length ? String(values[index]) : ""}`, ""),
            };
        },
    };
});

// The player chrome is not under test: the controls render nothing, and the bar passes its children through.
// eslint-disable-next-line no-restricted-syntax -- vi.mock is hoisted; the player chrome is not under test
vi.mock("media-chrome/react", () => {
    const none = () => null;
    const passThrough = (props: { children?: unknown }) => props.children ?? null;

    return {
        MediaControlBar: passThrough,
        MediaController: passThrough,
        MediaDurationDisplay: none,
        MediaFullscreenButton: none,
        MediaMuteButton: none,
        MediaPlayButton: none,
        MediaTimeDisplay: none,
        MediaTimeRange: none,
        MediaVolumeRange: none,
    };
});

// jsdom has no media pipeline; HLS attaches to nothing and only needs the calls the player makes.
// eslint-disable-next-line no-restricted-syntax -- vi.mock is hoisted; HLS needs no real media pipeline here
vi.mock("hls.js", () => {
    class HlsStub {
        static isSupported() {
            return true;
        }

        attachMedia() {}

        destroy() {}

        loadSource() {}

        on() {}
    }

    return { default: HlsStub, Events: { ERROR: "hlsError" } };
});

// The waveform is not under test: a stub that records its event handlers, so a test can raise an error.
// eslint-disable-next-line no-restricted-syntax -- vi.mock is hoisted; the waveform is not under test
vi.mock("wavesurfer.js", () => {
    const create = () => {
        return {
            destroy() {},
            getDuration: () => 0,
            on(name: string, handler: () => void) {
                waveHandlers.set(name, handler);
            },
            playPause() {},
        };
    };

    return { default: { create } };
});

// React only batches updates inside `act` when this flag is set.
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const host = document.createElement("div");

document.body.append(host);

const root = createRoot(host);

const render = (element: React.ReactElement): void => {
    act(() => root.render(element));
};

const saveButton = (name: string): HTMLButtonElement | null =>
    [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === `Download ${name}`) ?? null;

afterEach(() => {
    act(() => root.render(<></>));
    saveFromUrl.mockClear();
});

describe("video player save control", () => {
    it("saves the video under its name", () => {
        render(<VideoPlayer filename="clip.mp4" mediaType="video/mp4" url="https://files.test/clip.mp4" />);

        const save = saveButton("clip.mp4");

        expect(save).not.toBeNull();

        act(() => save?.click());

        expect(saveFromUrl).toHaveBeenCalledWith("https://files.test/clip.mp4", "clip.mp4", "video");
    });

    it("offers no save for an HLS stream, which saves as its playlist", () => {
        render(<VideoPlayer filename="live.m3u8" mediaType="application/vnd.apple.mpegurl" url="https://files.test/live.m3u8" />);

        expect(host.querySelector("button[aria-label^='Download']")).toBeNull();
        expect(host.textContent).toContain("live.m3u8");
    });

    it("offers no save for a signed HLS playlist, whose query string follows the .m3u8 ending", () => {
        render(<VideoPlayer filename="live.m3u8" url="https://files.test/live.m3u8?token=abc" />);

        expect(host.querySelector("button[aria-label^='Download']")).toBeNull();
    });
});

describe("audio player save control", () => {
    it("saves the audio under its name", () => {
        render(<AudioWaveformPlayer filename="voice.mp3" url="https://files.test/voice.mp3" />);

        const save = saveButton("voice.mp3");

        expect(save).not.toBeNull();

        act(() => save?.click());

        expect(saveFromUrl).toHaveBeenCalledWith("https://files.test/voice.mp3", "voice.mp3", "audio");
    });

    it("still offers the save when the audio fails to load", () => {
        render(<AudioWaveformPlayer filename="voice.mp3" url="https://files.test/voice.mp3" />);

        act(() => waveHandlers.get("error")?.());

        const save = saveButton("voice.mp3");

        expect(save).not.toBeNull();

        act(() => save?.click());

        expect(saveFromUrl).toHaveBeenCalledWith("https://files.test/voice.mp3", "voice.mp3", "audio");
    });
});
