import { getFileRendererType } from "@neore/ui/components/file-renderers/file-type-utilities";

interface PartLike {
    data?: string;
    filename?: string;
    mediaType?: string;
    type: string;
    url?: string;
}

/** Whether a message part renders as an image: an image part, or a file with a source whose type is an image. */
const rendersAsImage = (part: PartLike): boolean => {
    if (part.type === "image") {
        return true;
    }

    return part.type === "file" && Boolean(part.url || part.data) && getFileRendererType(part.mediaType, part.filename) === "image";
};

/**
 * Each image part's place among the message's images (part index → image index). An image pin names its image this
 * way, not by part index: editing a reply removes text parts and keeps its images, so the image index stays put.
 * Pure; pinned by `image-ordinals.test.ts`.
 */
export const imageOrdinals = (parts: ReadonlyArray<unknown>): Map<number, number> => {
    const ordinals = new Map<number, number>();

    for (const [partIndex, part] of parts.entries()) {
        if (rendersAsImage(part as PartLike)) {
            ordinals.set(partIndex, ordinals.size);
        }
    }

    return ordinals;
};
