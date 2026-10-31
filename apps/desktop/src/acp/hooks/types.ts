/** What the local device window is shown of a folder's hooks file. */
import type { HookEvent } from "./schema";

export interface HookView {
    event: HookEvent;
    glob?: string;
    id: string;
    name: string;
    prompt: string;
}

/**
 * `unapproved`: a valid file nobody approved. `changed`: a file was approved once and has changed since, so it
 * is inert again. `hash` is of the bytes the hooks were read from; approving names it, so the person approves what
 * they were shown.
 */
export interface HooksView {
    error?: string;
    hash?: string;
    hooks: HookView[];
    state: "approved" | "changed" | "invalid" | "none" | "unapproved";
    /** False when the folder is not being watched (the watcher failed, for one: the system can be out of watches), so file hooks cannot fire. */
    watching: boolean;
}
