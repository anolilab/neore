import { composerModelOf } from "./composer-model";

/** A model the composer's picker offers, as far as a prompt link needs to know it: its id, and what kind of model and who serves it. */
export interface LinkableModel {
    id: string;
    /** The picker's mode for the model. A text model may leave it unset. */
    mode?: string;
    provider?: string;
}

/**
 * Whether opening a link on `model` selects it for the new chat. This is the one rule the link's open applies (the draft hook) and
 * its copy checks, and it reads the picker's own entries: the model is in the list the picker offers this user, it is a text model
 * and not an external one, and the composer would send with it (an anonymous visitor's text chat sends the free model). A link always
 * opens a text chat, so the mode the composer was last in (an image chat's, say) does not decide it: opening the link sets the new chat
 * to text. A copy names a model only when this holds, so a link opens on exactly the model the copy showed.
 */
export const linkModelAppliesOnOpen = ({
    isAnonymous,
    linkable,
    model,
}: {
    isAnonymous: boolean;
    linkable: ReadonlyMap<string, LinkableModel>;
    model: string | undefined;
}): boolean => {
    const entry = model === undefined ? undefined : linkable.get(model);

    return (
        entry !== undefined &&
        (entry.mode ?? "text") === "text" &&
        entry.provider !== "external" &&
        composerModelOf({ isAnonymous, mode: "text", threadModel: entry.id }) === entry.id
    );
};
