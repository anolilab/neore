import { describe, expect, it } from "vitest";

import { imageOrdinals } from "./image-ordinals";

describe(imageOrdinals, () => {
    it("numbers the parts that render as images, in order, skipping text, other files and sourceless files", () => {
        const ordinals = imageOrdinals([
            { text: "Here.", type: "text" },
            { filename: "fox.png", mediaType: "image/png", type: "file", url: "https://files.example/fox.png" },
            { filename: "notes.pdf", mediaType: "application/pdf", type: "file", url: "https://files.example/notes.pdf" },
            { image: "https://files.example/owl.png", type: "image" },
            { mediaType: "image/png", type: "file" },
            { data: "https://files.example/stored.png", mediaType: "image/png", type: "file" },
        ]);

        expect([...ordinals]).toEqual([
            [1, 0],
            [3, 1],
            [5, 2],
        ]);
    });

    it("gives an image the same index after an edit drops the text around it", () => {
        const image = { image: "https://files.example/a.png", type: "image" };

        expect(imageOrdinals([{ text: "a", type: "text" }, image, { text: "b", type: "text" }]).get(1)).toBe(0);
        expect(imageOrdinals([image, { text: "edited", type: "text" }]).get(0)).toBe(0);
    });
});
