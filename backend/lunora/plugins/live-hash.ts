/**
 * The live content hash of an installed child, read from the child's row. Update and export both use it, so a child counts as
 * edited or unedited the same way in both. A child whose row is gone reads as "missing", which is never unedited.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { groupRowHash, skillRowHash, triggerRowHash } from "./entry-hash";
import { markerFor, parseMarker } from "./logic";
import type { ChildKind } from "./logic";

/**
 * `skillKeys` is an optional lookup shared by the calls of one pass over one install: a participant skill's entry key, read once however
 * many group chats name it. Without it every group chat re-reads its participants, which adds up past a request's read budget.
 */
export type SkillKeyCache = Map<string, string | undefined>;

/** An install's skills by entry key, as {@link pluginSkillsByKey} reads them. */
export type PluginSkills = ReadonlyMap<string, Doc<"skills">>;

/**
 * Every skill of one install by entry key, read from the primary in pages by `pluginInstallId` (25 skills a statement), instead of one
 * read per link. A skill whose marker names another install is left out. A link whose key is absent has no skill.
 */
export const pluginSkillsByKey = async (ctx: Pick<QueryCtx, "db">, installId: string): Promise<PluginSkills> => {
    const skills = new Map<string, Doc<"skills">>();
    let cursor: string | null = null;

    for (;;) {
        const result: { continueCursor?: string | null; isDone: boolean; page: Doc<"skills">[] } = await ctx.db.skills.findMany({
            consistency: "primary",
            cursor,
            where: { pluginInstallId: installId },
        });

        for (const skill of result.page) {
            const parsed = parseMarker(skill.pluginMarker ?? "");

            if (parsed?.installId === installId && !skills.has(parsed.entryKey)) {
                skills.set(parsed.entryKey, skill);
            }
        }

        if (result.isDone || !result.continueCursor) {
            return skills;
        }

        cursor = result.continueCursor;
    }
};

/**
 * `skills` is the install's skills read once by {@link pluginSkillsByKey}: a skill link is then answered from it, with no read.
 */
export const liveHashOf = async (
    ctx: QueryCtx,
    installId: string,
    link: { entryKey: string; kind: ChildKind },
    skillKeys?: SkillKeyCache,
    skills?: PluginSkills,
): Promise<string> => {
    const marker = markerFor(installId, link.entryKey);

    if (link.kind === "skill") {
        const skill = skills ? skills.get(link.entryKey) : await ctx.db.skills.findFirst({ consistency: "primary", where: { pluginMarker: marker } });

        return skill ? await skillRowHash(skill) : "missing";
    }

    if (link.kind === "trigger") {
        const trigger = await ctx.db
            .query("triggers")
            .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", marker))
            .first();

        return trigger ? await triggerRowHash(trigger) : "missing";
    }

    const thread = await ctx.db
        .query("threads")
        .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", marker))
        .first();

    if (!thread) {
        return "missing";
    }

    // A participant maps to its plugin entry key through the marker on its skill row.
    const keys = new Map<string, string>();
    const participantIds = [
        ...(thread.groupChat?.participants ?? []).map((participant) => participant.skillId),
        ...(thread.groupChat?.synthesizerSkillId ? [thread.groupChat.synthesizerSkillId] : []),
    ];

    for (const skillId of participantIds) {
        let key: string | undefined;

        if (skillKeys?.has(skillId)) {
            key = skillKeys.get(skillId);
        } else {
            const skill = await ctx.db.skills.findFirst({ consistency: "primary", where: { _id: skillId as Id<"skills"> } });
            const parsed = skill?.pluginMarker ? parseMarker(skill.pluginMarker) : null;

            // Only this install's own skills map to an entry key: another plugin's skill under the same key is a replacement, and must change the hash.
            key = parsed && parsed.installId === installId ? parsed.entryKey : undefined;
            skillKeys?.set(skillId, key);
        }

        if (key !== undefined) {
            keys.set(skillId, key);
        }
    }

    return await groupRowHash(
        {
            debateRounds: thread.groupChat?.debateRounds,
            mode: thread.groupChat?.mode ?? "",
            model: thread.model ?? "",
            participants: thread.groupChat?.participants ?? [],
            synthesizerSkillId: thread.groupChat?.synthesizerSkillId,
            title: thread.title,
        },
        (skillId) => keys.get(skillId),
    );
};
