import type { Doc } from "../../_generated/dataModel";

/**
 * A string of the stored fields a person can edit on a group chat: title, mode, model, participant skill ids in order, synthesizer and
 * debate rounds. Plain fields only, so a caller can take it again later in another transaction and compare. A plugin update takes it
 * when it decides to delete a group and the delete checks it before the point of no return.
 */
export const groupFingerprint = (thread: Pick<Doc<"threads">, "groupChat" | "model" | "title">): string =>
    JSON.stringify([
        thread.title ?? null,
        thread.groupChat?.mode ?? null,
        thread.model ?? null,
        (thread.groupChat?.participants ?? []).map((participant) => participant.skillId),
        thread.groupChat?.synthesizerSkillId ?? null,
        thread.groupChat?.debateRounds ?? null,
    ]);
