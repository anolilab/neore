/**
 * The live content hash of an installed child, read from the child's row. Update and export both use it, so a child counts as
 * edited or unedited the same way in both. A child whose row is gone reads as "missing", which is never unedited.
 */
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { groupRowHash, skillRowHash, triggerRowHash } from "./entry-hash";
import { markerFor, parseMarker } from "./logic";
import type { ChildKind } from "./logic";

export const liveHashOf = async (ctx: QueryCtx, installId: string, link: { entryKey: string; kind: ChildKind }): Promise<string> => {
    const marker = markerFor(installId, link.entryKey);

    if (link.kind === "skill") {
        const skill = await ctx.db.skills.findFirst({ where: { pluginMarker: marker } });

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
        const skill = await ctx.db.skills.findFirst({ where: { _id: skillId as Id<"skills"> } });
        const parsed = skill?.pluginMarker ? parseMarker(skill.pluginMarker) : null;

        if (parsed) {
            keys.set(skillId, parsed.entryKey);
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
