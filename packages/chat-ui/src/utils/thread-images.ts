import { toolImageSource } from "./tool-image-source";

/**
 * The images of a thread, in reading order, for the image gallery: screenshots the browser tool took, images a code
 * run produced, and image files in messages (what a person attached and the agent then viewed, and generated images).
 *
 * A tool output the page left out (`outputRef`) is skipped: fetched on expand, it shows as text (`TrimmedToolOutput`),
 * not as an image. So is an image the NSFW check is still looking at or blocked.
 */

export interface ThreadImage {
    /** The image's own name (a page title, a file name), if it has one; the gallery words the rest by `kind`, translated. */
    alt?: string;
    /** Stable across re-renders: a tool image by its call (`tool:<call>[:<result>]`), a file by message and part. */
    key: string;
    kind: "browser" | "code" | "file";
    messageId: string;
    src: string;
}

/** The gallery key of a browser screenshot: by message too, since a provider can reuse a tool-call id in a later turn. */
export const browserImageKey = (messageId: string, toolCallId: string): string => `tool:${messageId}:${toolCallId}`;

/** The gallery key of the `index`-th result of a code run (by message too, as {@link browserImageKey}). */
export const codeImageKey = (messageId: string, toolCallId: string, index: number): string => `tool:${messageId}:${toolCallId}:${String(index)}`;

interface PartLike {
    data?: string;
    filename?: string;
    image?: unknown;
    mediaType?: string;
    nsfwStatus?: string;
    output?: unknown;
    prompt?: string;
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

// `generationPrompt` is the message's `metadata.prompt` (a generated image's): named first, as `DefaultImage` does.
const imagesOfPart = (messageId: string, part: PartLike, partIndex: number, generationPrompt: string | undefined): ThreadImage[] => {
    if (part.type === "tool-browser" && part.toolCallId) {
        const output = part.output as BrowserOutput | undefined;
        const src = output?.screenshotFormat
            ? toolImageSource({ inline: output.screenshot, mediaType: `image/${output.screenshotFormat}`, url: output.screenshotUrl })
            : undefined;

        return src
            ? [{ alt: output?.title || output?.url || undefined, key: browserImageKey(messageId, part.toolCallId), kind: "browser", messageId, src }]
            : [];
    }

    if (part.type === "tool-codeExecution" && part.toolCallId) {
        const { toolCallId } = part;
        const results = (part.output as CodeOutput | undefined)?.results ?? [];

        return results.flatMap((result, index) => {
            const src =
                result.type === "image" ? toolImageSource({ inline: result.value, mediaType: `image/${result.format || "png"}`, url: result.url }) : undefined;

            return src ? [{ key: codeImageKey(messageId, toolCallId, index), kind: "code", messageId, src }] : [];
        });
    }

    if (isHidden(part)) {
        return [];
    }

    const key = `${messageId}:${String(partIndex)}`;

    if (part.type === "image" && typeof part.image === "string" && part.image.length > 0) {
        return [{ alt: generationPrompt || part.prompt || part.filename || undefined, key, kind: "file", messageId, src: part.image }];
    }

    const fileUrl = part.url || part.data;

    if (part.type === "file" && part.mediaType?.startsWith("image/") === true && fileUrl) {
        return [{ alt: generationPrompt || part.filename || undefined, key, kind: "file", messageId, src: fileUrl }];
    }

    return [];
};

interface MessageLike {
    id: string;
    metadata?: unknown;
    parts: ReadonlyArray<unknown>;
}

// By message object: a streamed batch replaces only the streaming message (the web app shares unchanged ones), so only it is scanned again.
const imagesByMessage = new WeakMap<MessageLike, ThreadImage[]>();

const imagesOfMessage = (message: MessageLike): ThreadImage[] => {
    let images = imagesByMessage.get(message);

    if (!images) {
        const { prompt } = (message.metadata ?? {}) as { prompt?: unknown };

        images = message.parts.flatMap((part, partIndex) =>
            imagesOfPart(message.id, part as PartLike, partIndex, typeof prompt === "string" ? prompt : undefined),
        );
        imagesByMessage.set(message, images);
    }

    return images;
};

/** Every image of `messages`, in order. Pinned by `thread-images.test.ts`. */
export const collectThreadImages = (messages: ReadonlyArray<MessageLike>): ThreadImage[] => messages.flatMap((message) => imagesOfMessage(message));
