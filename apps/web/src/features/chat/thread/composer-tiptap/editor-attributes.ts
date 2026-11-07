import clsx from "clsx";

interface EditorAttributeOptions {
    /** Id of the element that describes the field (the over-the-cap notice); omitted when there is none. */
    describedBy?: string;
    /** The text in the field is not acceptable as it is. */
    invalid?: boolean;
}

/** The attributes of the editable element. Rebuilt whenever the description or validity changes. */
export const composerEditorAttributes = ({ describedBy, invalid = false }: EditorAttributeOptions = {}): Record<string, string> => {
    const attributes: Record<string, string> = {
        // The editable element is the composer's focus area for F6: the editor itself takes the focus.
        "data-focus-area": "composer",
        class: clsx("min-h-10 w-full resize-none border-none bg-transparent text-base outline-none", "text-gray-900 dark:text-gray-100", "focus:ring-0"),
        // Hebrew or Arabic typed into an LTR app lays out right to left. One direction for the whole message (the
        // first strong character decides), not per paragraph.
        dir: "auto",
    };

    if (describedBy) {
        attributes["aria-describedby"] = describedBy;
    }

    if (invalid) {
        attributes["aria-invalid"] = "true";
    }

    return attributes;
};
