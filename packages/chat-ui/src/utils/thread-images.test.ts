import { describe, expect, it } from "vitest";

import { browserImageKey, codeImageKey, collectThreadImages } from "./thread-images";

const PNG = "iVBORw0KGgo=";

describe(collectThreadImages, () => {
    it("collects screenshots, code images and image files in reading order", () => {
        const images = collectThreadImages([
            {
                id: "m1",
                parts: [{ filename: "sketch.png", mediaType: "image/png", type: "file", url: "https://api.test/files/sketch?sig=1" }],
            },
            {
                id: "m2",
                parts: [
                    { text: "Looking at the page.", type: "text" },
                    { output: { screenshot: PNG, screenshotFormat: "png", title: "Pricing" }, toolCallId: "call-1", type: "tool-browser" },
                    {
                        output: {
                            results: [
                                { type: "text", value: "done" },
                                { format: "png", type: "image", url: "https://api.test/files/chart?sig=1" },
                            ],
                        },
                        toolCallId: "call-2",
                        type: "tool-codeExecution",
                    },
                    { image: "https://api.test/files/owl?sig=1", type: "image" },
                ],
            },
        ]);

        expect(images).toEqual([
            { alt: "sketch.png", key: "m1:0", kind: "file", messageId: "m1", src: "https://api.test/files/sketch?sig=1" },
            { alt: "Pricing", key: browserImageKey("call-1"), kind: "browser", messageId: "m2", src: `data:image/png;base64,${PNG}` },
            { key: codeImageKey("call-2", 1), kind: "code", messageId: "m2", src: "https://api.test/files/chart?sig=1" },
            { alt: undefined, key: "m2:3", kind: "file", messageId: "m2", src: "https://api.test/files/owl?sig=1" },
        ]);
    });

    it("leaves out images not shown: still checked, blocked, or a tool output the page has not loaded", () => {
        expect(
            collectThreadImages([
                {
                    id: "m1",
                    parts: [
                        { mediaType: "image/png", nsfwStatus: "checking", type: "file", url: "https://api.test/a" },
                        { image: "https://api.test/b", nsfwStatus: "blocked", type: "image" },
                        { outputRef: { messageId: "m1", threadId: "t1", toolCallId: "call-3" }, toolCallId: "call-3", type: "tool-browser" },
                    ],
                },
            ]),
        ).toEqual([]);
    });

    it("leaves out files that are not images, and a tool image link the server did not sign", () => {
        expect(
            collectThreadImages([
                {
                    id: "m1",
                    parts: [
                        { filename: "notes.pdf", mediaType: "application/pdf", type: "file", url: "https://api.test/notes" },
                        { output: { screenshotFormat: "png", screenshotUrl: "ftp://files.example/shot.png" }, toolCallId: "call-4", type: "tool-browser" },
                    ],
                },
            ]),
        ).toEqual([]);
    });

    it("scans a message again only when it is a new object, as a streamed batch makes only of the streaming one", () => {
        const done = { id: "m1", parts: [{ image: "https://api.test/files/owl?sig=1", type: "image" }] };
        const [first] = collectThreadImages([done]);
        const streaming = { id: "m2", parts: [{ image: "https://api.test/files/cat?sig=1", type: "image" }] };
        const [again, next] = collectThreadImages([done, streaming]);

        expect(again).toBe(first);
        expect(next?.key).toBe("m2:0");
    });
});
