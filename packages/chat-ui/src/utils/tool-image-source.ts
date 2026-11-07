import { safeHttpUrl } from "./citation-marker";

/**
 * The `src` for an image a tool returned, or `undefined` when there is none to show. A tool reports the image as
 * base64 (`inline`); a saved result past a size budget has it in storage instead, and the server alone writes the
 * signed link into a separate field (`url`), so a string the tool chose is only ever a data URL, never a link.
 */
export const toolImageSource = ({ inline, mediaType, url }: { inline?: string; mediaType: string; url?: string }): string | undefined => {
    if (url !== undefined) {
        return safeHttpUrl(url);
    }

    return inline ? `data:${mediaType};base64,${inline}` : undefined;
};
