import { toolImageSource } from "./tool-image-source";

/**
 * The images of a thread, in reading order, for the image gallery: screenshots the browser tool took, images a code
 * run produced, and image files in messages (what a person attached and the agent then viewed, and generated images).
 *
 * A tool output the page left out (`outputRef`) is skipped: fetched on expand, it shows as text (`TrimmedToolOutput`),
 * not as an image. So is an image the NSFW check is still looking at or blocked.
 */

export interface ThreadImage {
    alt: string;
    /** Stable across re-renders: a tool image by its call (`tool:<call>[:<result>]`), a file by message and part. */
    key: string;
    messageId: string;
    src: string;
}

/** The gallery key of a browser screenshot. */
export const browserImageKey = (toolCallId: string): string => `tool:${toolCallId}`;

/** The gallery key of the `index`-th result of a code run. */
export const codeImageKey = (toolCallId: string, index: number): string => `tool:${toolCallId}:${String(index)}`;

interface PartLike {
    data?: string;
    filename?: string;
    image?: unknown;
    mediaType?: string;
    nsfwStatus?: string;
    output?: unknown;
    toolCallId?: string;
    type: string;
    url?: string;
}

interface BrowserOutput {
    screenshot?: string;
    screenshotFormat?: string;
    screenshotUrl?: string;
    title?: string;
    url?: string;
}

interface CodeOutput {
    results?: { format?: string; type?: string; url?: string; value?: string }[];
}

const isHidden = (part: PartLike): boolean => part.nsfwStatus === "blocked" || part.nsfwStatus === "checking";

const imagesOfPart = (messageId: string, part: PartLike, partIndex: number): ThreadImage[] => {
    if (part.type === "tool-browser" && part.toolCallId) {
        const output = part.output as BrowserOutput | undefined;
        const src = output?.screenshotFormat
            ? toolImageSource({ inline: output.screenshot, mediaType: `image/${output.screenshotFormat}`, url: output.screenshotUrl })
            : undefined;

        return src ? [{ alt: output?.title || output?.url || "Browser screenshot", key: browserImageKey(part.toolCallId), messageId, src }] : [];
    }

    if (part.type === "tool-codeExecution" && part.toolCallId) {
        const { toolCallId } = part;
        const results = (part.output as CodeOutput | undefined)?.results ?? [];

        return results.flatMap((result, index) => {
            const src =
                result.type === "image" ? toolImageSource({ inline: result.value, mediaType: `image/${result.format || "png"}`, url: result.url }) : undefined;

            return src ? [{ alt: "Code output image", key: codeImageKey(toolCallId, index), messageId, src }] : [];
        });
    }

    if (isHidden(part)) {
        return [];
    }

    const key = `${messageId}:${String(partIndex)}`;

    if (part.type === "image" && typeof part.image === "string" && part.image.length > 0) {
        return [{ alt: part.filename || "Image", key, messageId, src: part.image }];
    }

    const fileUrl = part.url || part.data;

    if (part.type === "file" && part.mediaType?.startsWith("image/") === true && fileUrl) {
        return [{ alt: part.filename || "Image", key, messageId, src: fileUrl }];
    }

    return [];
};

interface MessageLike {
    id: string;
    parts: ReadonlyArray<unknown>;
}

// By message object: a streamed batch replaces only the streaming message (the web app shares unchanged ones), so only it is scanned again.
const imagesByMessage = new WeakMap<MessageLike, ThreadImage[]>();

const imagesOfMessage = (message: MessageLike): ThreadImage[] => {
    let images = imagesByMessage.get(message);

    if (!images) {
        images = message.parts.flatMap((part, partIndex) => imagesOfPart(message.id, part as PartLike, partIndex));
        imagesByMessage.set(message, images);
    }

    return images;
};

/** Every image of `messages`, in order. Pinned by `thread-images.test.ts`. */
export const collectThreadImages = (messages: ReadonlyArray<MessageLike>): ThreadImage[] => messages.flatMap((message) => imagesOfMessage(message));
