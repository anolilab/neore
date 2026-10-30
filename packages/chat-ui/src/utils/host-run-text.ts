/**
 * A text part a coding agent wrote on the user's computer (`backend/lunora/acp/lib/reply.ts` marks the parts of its
 * reply, and the streaming view marks the text it shows while the turn runs). The text is the agent's and untrusted,
 * so its Markdown images are not loaded (`hostMarkdownComponents` in `@neore/ui`).
 */
interface PartLike {
    providerMetadata?: unknown;
    type: string;
}

const isObject = (value: unknown): value is { neore?: unknown; runner?: unknown } => typeof value === "object" && value !== null && !Array.isArray(value);

/** The `providerMetadata` that marks a part, as the backend writes it. */
export const HOST_RUN_METADATA = { neore: { runner: "host" } } as const;

export const isHostRunText = (part: PartLike): boolean => {
    if ((part.type !== "text" && part.type !== "reasoning") || !isObject(part.providerMetadata)) {
        return false;
    }

    const { neore } = part.providerMetadata;

    return isObject(neore) && neore.runner === "host";
};
