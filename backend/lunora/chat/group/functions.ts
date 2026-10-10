/**
 * Multi-agent group chat: several skills ("participants") take part in one
 * thread, and a supervisor, a rotation or the user's `@mentions` decide who
 * speaks. The participant list and mode live on `threads.groupChat`; the turn
 * itself runs in `run.ts`.
 *
 * Every participant must be a skill the thread OWNER may invoke — readable
 * under `skills/access.ts` and enabled by them (`canUseSkillAsParticipant`). It
 * is checked when participants are set AND again when a turn runs, because a
 * skill can be made private, or the owner can leave the organization it was
 * shared with, after it joined. Participant instructions never leave the
 * backend: the public procedures return names and descriptions only.
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation, internalQuery } from "../../_generated/server";
import type { QueryCtx as QueryContext } from "../../_generated/server";
import { loadActivePathTail } from "../../agent/branch-rows";
import { insertThread, patchMessage, patchThread } from "../../agent/table-writes";
import { resolveThreadReadAccess } from "../../agent/thread-read-access";
import { authMutation, authQuery, rateLimit } from "../../lib/crpc";
import type { SkillAccessSubject } from "../../skills/access";
import { MAX_ENABLED_SKILLS } from "../../skills/constants";
import { prepareSkillInvocation } from "../../skills/executor";
import { ensureTemplateSkills } from "../../skills/template-skills";
import { vSkillConfig } from "../../skills/validators";
import type { GroupHistoryRow } from "./logic";
import { canUseSkillAsParticipant, GROUP_HISTORY_ROWS, normalizeGroupOptions, validateParticipantIds } from "./logic";
import { readSkills } from "./skill-reader";
import { findGroupTemplate } from "./templates";
import type { GroupChat, GroupChatMode } from "./validators";
import { vGroupChatMode } from "./validators";
import { admitSkills } from "../../lib/rls/scope";
import { MAX_LENGTH } from "../../lib/validators";

const DEFAULT_GROUP_TITLE = "Group chat";

const vParticipantSummary = v.object({
    description: v.string(),
    icon: v.optional(v.string()),
    name: v.string(),
    skillId: v.string(),
    slug: v.string(),
});

type ParticipantSummary = Infer<typeof vParticipantSummary>;

const toSummary = (skill: Doc<"skills">): ParticipantSummary => {
    return {
        description: skill.description,
        ...(skill.icon && { icon: skill.icon }),
        name: skill.name,
        skillId: skill._id as string,
        slug: skill.slug,
    };
};

/** Ids of the skills the user has enabled — the opt-in every participant needs. A LIST, capped: for picking candidates only. */
const loadEnabledSkillIds = async (context: Pick<QueryContext, "db">, userId: string): Promise<Set<string>> => {
    const rows = await context.db
        .query("userSkills")
        .withIndex("by_user_and_enabled", (q) => q.eq("userId", userId).eq("enabled", true))
        .take(MAX_ENABLED_SKILLS);

    return new Set(rows.map((row) => row.skillId as string));
};

/**
 * Which of `skillIds` the user has enabled, looked up one link each — never
 * through the capped list above, which a user with more enabled skills than
 * its cap would fail for participants past it.
 */
const loadEnabledAmong = async (context: Pick<QueryContext, "db">, userId: string, skillIds: ReadonlyArray<string>): Promise<Set<string>> => {
    const links = await Promise.all(
        [...new Set(skillIds)].map(
            async (skillId) =>
                await context.db
                    .query("userSkills")
                    .withIndex("by_user_and_skill", (q) => q.eq("userId", userId).eq("skillId", skillId as Id<"skills">))
                    .first(),
        ),
    );

    return new Set(links.flatMap((link) => (link?.enabled ? [link.skillId as string] : [])));
};

/**
 * The participants of `groupChat` the owner may still use, in thread order,
 * with their skill rows. Participants that lost access are dropped, not failed:
 * one skill made private must not break the whole group.
 */
const loadUsableParticipants = async (
    context: Pick<QueryContext, "db">,
    groupChat: GroupChat,
    subject: SkillAccessSubject,
): Promise<{ skill: Doc<"skills">; skillId: string }[]> => {
    const participantIds = groupChat.participants.map((p) => p.skillId);
    const [enabled, skills] = await Promise.all([loadEnabledAmong(context, subject.userId, participantIds), readSkills(context, participantIds)]);

    return groupChat.participants.flatMap((participant, index) => {
        const skill = skills[index];

        return skill && canUseSkillAsParticipant(skill, subject, enabled, participant.skillId) ? [{ skill, skillId: participant.skillId }] : [];
    });
};

/** Throws unless every id is a skill the owner may use as a participant. */
const requireUsableSkills = async (context: Pick<QueryContext, "db">, skillIds: ReadonlyArray<string>, subject: SkillAccessSubject): Promise<void> => {
    const [enabled, skills] = await Promise.all([loadEnabledAmong(context, subject.userId, skillIds), readSkills(context, skillIds)]);
    const usable = new Map(skillIds.map((id, index) => [id, canUseSkillAsParticipant(skills[index], subject, enabled, id)]));
    const error = validateParticipantIds(skillIds, (id) => usable.get(id) === true);

    if (error) {
        throw new LunoraError("BAD_REQUEST", error);
    }
};

/** `normalizeGroupOptions`, throwing its error as a `BAD_REQUEST`. */
const requireGroupOptions = (args: {
    debateRounds?: number;
    mode: GroupChatMode;
    skillIds: ReadonlyArray<string>;
    synthesizerSkillId?: string;
}): { debateRounds?: number; synthesizerSkillId?: string } => {
    const result = normalizeGroupOptions(args);

    if ("error" in result) {
        throw new LunoraError("BAD_REQUEST", result.error);
    }

    return result.options;
};

// ---------------------------------------------------------------------------
// Public procedures
// ---------------------------------------------------------------------------

/** The skills the caller may add to a group chat: readable and enabled. */
export const listGroupCandidates = authQuery
    .input({})
    .output(v.array(vParticipantSummary))
    .query(async ({ ctx }) => {
        const { userId } = ctx.user;
        const subject: SkillAccessSubject = { organizationId: ctx.user.activeOrganization?.id, userId };
        const enabled = await loadEnabledSkillIds(ctx, userId);
        const skills = await readSkills(ctx, [...enabled]);

        return skills
            .filter((skill): skill is Doc<"skills"> => !!skill && canUseSkillAsParticipant(skill, subject, enabled, skill._id as string))
            .map((skill) => toSummary(skill));
    });

/**
 * A thread's group setup, for its owner and members. `null` for a thread that
 * is not a group chat, and for a viewer who only sees the public projection.
 * `available: false` marks a participant the owner can no longer use — it stays
 * listed so it can be removed, and does not speak.
 */
export const getGroupChat = authQuery
    .input({ threadId: v.id("threads") })
    .output(
        v.union(
            v.null(),
            v.object({
                canEdit: v.boolean(),
                debateRounds: v.optional(v.number()),
                mode: vGroupChatMode,
                participants: v.array(
                    v.object({
                        available: v.boolean(),
                        description: v.string(),
                        icon: v.optional(v.string()),
                        name: v.string(),
                        skillId: v.string(),
                        slug: v.string(),
                    }),
                ),
                synthesizerSkillId: v.optional(v.string()),
            }),
        ),
    )
    .query(async ({ args: { threadId }, ctx }) => {
        const access = await resolveThreadReadAccess(ctx, threadId, ctx.user.userId);

        if (access?.kind !== "full" || !access.thread.groupChat || access.thread.groupChat.participants.length === 0) {
            return null;
        }

        const { groupChat } = access.thread;
        const ownerId = access.thread.userId ?? ctx.user.userId;
        // Availability is the OWNER's: their skills and their organization. Only
        // the owner's own session knows their active organization, so a member
        // sees organization-shared participants as available.
        const isOwner = ownerId === ctx.user.userId;
        const usableRows = isOwner
            ? await loadUsableParticipants(ctx, groupChat, { organizationId: ctx.user.activeOrganization?.id, userId: ownerId })
            : undefined;
        const usable = usableRows && new Set(usableRows.map((p) => p.skillId));

        // A thread member sees the participants the owner put in the chat, which
        // may be the owner's private skills.
        admitSkills(
            ctx,
            groupChat.participants.map((p) => p.skillId),
        );

        const skills = await readSkills(
            ctx,
            groupChat.participants.map((p) => p.skillId),
        );

        return {
            canEdit: isOwner,
            ...(groupChat.debateRounds !== undefined && { debateRounds: groupChat.debateRounds }),
            ...(groupChat.synthesizerSkillId !== undefined && { synthesizerSkillId: groupChat.synthesizerSkillId }),
            mode: groupChat.mode,
            participants: groupChat.participants.map((participant, index) => {
                const skill = skills[index];

                if (!skill) {
                    return { available: false, description: "", name: "Removed skill", skillId: participant.skillId, slug: "" };
                }

                return { ...toSummary(skill), available: usable ? usable.has(participant.skillId) : true };
            }),
        };
    });

export const createGroupChat = authMutation
    .use(rateLimit("chat/create"))
    .input({
        /** `debate` only: rounds of for/against (1–3). */
        debateRounds: v.optional(v.number()),
        mode: vGroupChatMode,
        /** The model participants without a preferred model run on. */
        model: v.string().max(MAX_LENGTH.short),
        skillIds: v.array(v.string().max(MAX_LENGTH.id)),
        /** `parallel` / `debate`: the participant that merges or weighs the answers. */
        synthesizerSkillId: v.optional(v.string().max(MAX_LENGTH.id)),
        title: v.optional(v.string().max(MAX_LENGTH.long)),
    })
    .output(v.object({ threadId: v.string() }))
    .mutation(async ({ args: { debateRounds, mode, model, skillIds, synthesizerSkillId, title }, ctx }) => {
        if (skillIds.length < 2) {
            throw new LunoraError("BAD_REQUEST", "A group chat needs at least two participants");
        }

        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;
        const options = requireGroupOptions({ debateRounds, mode, skillIds, synthesizerSkillId });

        await requireUsableSkills(ctx, skillIds, { organizationId, userId });

        const now = ctx.now;
        const threadId = await insertThread(ctx.db, {
            createdBy: userId,
            groupChat: {
                ...options,
                mode,
                participants: skillIds.map((skillId) => {
                    return { addedAt: now, skillId };
                }),
            },
            model,
            ...(organizationId && { organizationId }),
            status: "active",
            tags: ["chat"],
            title: title?.trim().slice(0, 200) || DEFAULT_GROUP_TITLE,
            updatedAt: now,
            userId,
        });

        ctx.log.event("chat.create_group_chat", { mode, participantCount: skillIds.length, titled: title !== undefined });

        return { threadId: threadId as string };
    });

/**
 * Open a group chat from a seeded template (`templates.ts`): the caller gets
 * the template's personas as their own skills — reusing any they already have
 * under the template's slugs — and a new group thread in the template's mode.
 */
export const createGroupChatFromTemplate = authMutation
    .use(rateLimit("chat/create"))
    .input({
        /** The model participants without a preferred model run on. */
        model: v.string().max(MAX_LENGTH.short),
        templateId: v.string().max(MAX_LENGTH.id),
        /** The title in the caller's language; the template's English title otherwise. */
        title: v.optional(v.string().max(MAX_LENGTH.long)),
    })
    .output(v.object({ threadId: v.string() }))
    .mutation(async ({ args: { model, templateId, title }, ctx }) => {
        const template = findGroupTemplate(templateId);

        if (!template) {
            throw new LunoraError("NOT_FOUND", "Template not found");
        }

        const { userId } = ctx.user;
        const organizationId = ctx.user.activeOrganization?.id;

        // Every check that can fail runs BEFORE `ensureTemplateSkills`: the
        // `skills`/`skillStats` rows it writes are `.global()` (D1), outside this
        // mutation's transaction, so a throw after them would leave them behind.
        // The options are validated over the personas' slugs, which stand in
        // one-to-one for the skill ids they become.
        const slugs = template.personas.map((persona) => persona.slug);
        const participantError = validateParticipantIds(slugs, () => true);

        if (participantError) {
            throw new LunoraError("BAD_REQUEST", participantError);
        }

        const slugOptions = requireGroupOptions({
            ...(template.debateRounds !== undefined && { debateRounds: template.debateRounds }),
            mode: template.mode,
            skillIds: slugs,
            ...(template.synthesizerSlug !== undefined && { synthesizerSkillId: template.synthesizerSlug }),
        });

        // The caller's own skills (found by slug, or created now), each with an
        // enabled link — usable by construction, so no usability re-check here.
        const skillIds = await ensureTemplateSkills(
            ctx,
            { ...(organizationId && { activeOrganizationId: organizationId }), isPremium: ctx.user.plan === "premium" || ctx.user.isAdmin === true, userId },
            template.personas,
        );
        const synthesizerSkillId = slugOptions.synthesizerSkillId === undefined ? undefined : skillIds[slugs.indexOf(slugOptions.synthesizerSkillId)];
        const options = { ...slugOptions, ...(synthesizerSkillId !== undefined && { synthesizerSkillId }) };

        const now = ctx.now;
        const threadId = await insertThread(ctx.db, {
            createdBy: userId,
            groupChat: {
                ...options,
                mode: template.mode,
                participants: skillIds.map((skillId) => {
                    return { addedAt: now, skillId };
                }),
            },
            model,
            ...(organizationId && { organizationId }),
            status: "active",
            tags: ["chat"],
            title: title?.trim().slice(0, 200) || template.title,
            updatedAt: now,
            userId,
        });

        ctx.log.event("chat.create_group_chat_from_template", { mode: template.mode, participantCount: skillIds.length, templateId });

        return { threadId: threadId as string };
    });

/**
 * Set a thread's participants and mode — the participant bar's add/remove and
 * the mode switch. Owner only. An empty list turns the thread back into an
 * ordinary chat; the messages keep their speaker labels.
 */
export const updateGroupChat = authMutation
    .use(rateLimit("chat/update"))
    .input({
        /** `debate` only: rounds of for/against (1–3). */
        debateRounds: v.optional(v.number()),
        mode: vGroupChatMode,
        skillIds: v.array(v.string().max(MAX_LENGTH.id)),
        /** `parallel` / `debate`: the participant that merges or weighs the answers. */
        synthesizerSkillId: v.optional(v.string().max(MAX_LENGTH.id)),
        threadId: v.id("threads"),
    })
    .output(v.null())
    .mutation(async ({ args: { debateRounds, mode, skillIds, synthesizerSkillId, threadId }, ctx }) => {
        const { userId } = ctx.user;
        const thread = await ctx.db.get(threadId);

        if (!thread || thread.deleted === true) {
            throw new LunoraError("NOT_FOUND", "Thread not found");
        }

        if (thread.userId !== userId) {
            throw new LunoraError("FORBIDDEN", "Only the thread owner can change its participants");
        }

        if (skillIds.length === 0) {
            // An empty list, not `groupChat: undefined` — the shard engine rejects
            // a patch that sets a field to undefined. Every reader treats no
            // participants as "not a group chat".
            await patchThread(ctx.db, threadId, { groupChat: { mode, participants: [] }, updatedAt: ctx.now });

            ctx.log.event("chat.update_group_chat", { mode, participantCount: 0 });

            return null;
        }

        // A participant already in the thread may stay even if it became
        // unusable — removing it must not require fixing it first — but nothing
        // new joins without passing the check.
        const existing = new Set((thread.groupChat?.participants ?? []).map((p) => p.skillId));
        const added = skillIds.filter((id) => !existing.has(id));

        // Duplicates and the cap over the WHOLE list; access over the new ids.
        const shapeError = validateParticipantIds(skillIds, () => true);

        if (shapeError) {
            throw new LunoraError("BAD_REQUEST", shapeError);
        }

        const options = requireGroupOptions({ debateRounds, mode, skillIds, synthesizerSkillId });

        await requireUsableSkills(ctx, added, { organizationId: ctx.user.activeOrganization?.id, userId });

        const now = ctx.now;
        const addedAt = new Map((thread.groupChat?.participants ?? []).map((p) => [p.skillId, p.addedAt]));

        // The whole object is replaced, so options the new mode does not read are dropped.
        await patchThread(ctx.db, threadId, {
            groupChat: {
                ...options,
                mode,
                participants: skillIds.map((skillId) => {
                    return { addedAt: addedAt.get(skillId) ?? now, skillId };
                }),
                ...(thread.groupChat?.stopRequestedAt !== undefined && { stopRequestedAt: thread.groupChat.stopRequestedAt }),
            },
            updatedAt: now,
        });

        ctx.log.event("chat.update_group_chat", { mode, participantCount: skillIds.length });

        return null;
    });

/**
 * "Stop": the speaker already talking finishes, nobody after it starts. The
 * turn loop compares this against the time it began, so a stop never carries
 * over into the next message.
 */
export const stopGroupTurn = authMutation
    .use(rateLimit("chat/update"))
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args: { threadId }, ctx }) => {
        const access = await resolveThreadReadAccess(ctx, threadId, ctx.user.userId);

        if (access?.kind !== "full" || access.permission === "read") {
            throw new LunoraError("FORBIDDEN", "Not allowed to stop this conversation");
        }

        const { groupChat } = access.thread;

        if (groupChat) {
            await patchThread(ctx.db, threadId, { groupChat: { ...groupChat, stopRequestedAt: ctx.now } });
        }

        ctx.log.event("chat.stop_group_turn", { stopRequested: Boolean(groupChat) });

        return null;
    });

// ---------------------------------------------------------------------------
// Internal — the turn loop (`run.ts`)
// ---------------------------------------------------------------------------

/**
 * What a turn needs, re-checked against the owner's CURRENT access: `null` when
 * the thread is not a group chat (or not the caller's), otherwise the mode and
 * the participants still usable, with instructions resolved exactly as a
 * `/<slug>` invocation without arguments would (`prepareSkillInvocation`). One
 * that cannot run that way — a required variable with no default — is dropped
 * like one that lost access.
 */
export const getGroupRunConfig = internalQuery
    .input({
        /** The caller's ACTIVE organization, resolved server-side — never a client value. */
        organizationId: v.optional(v.string()),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(
        v.union(
            v.null(),
            v.object({
                debateRounds: v.optional(v.number()),
                mode: vGroupChatMode,
                participants: v.array(
                    v.object({
                        config: v.optional(vSkillConfig),
                        description: v.string(),
                        instructions: v.string(),
                        name: v.string(),
                        skillId: v.string(),
                        slug: v.string(),
                    }),
                ),
                stopRequestedAt: v.optional(v.number()),
                synthesizerSkillId: v.optional(v.string()),
            }),
        ),
    )
    .query(async ({ args: { organizationId, threadId, userId }, ctx }) => {
        const thread = await ctx.db.get(threadId as Id<"threads">).catch(() => null);

        if (!thread || thread.userId !== userId || !thread.groupChat || thread.groupChat.participants.length === 0) {
            return null;
        }

        const usable = await loadUsableParticipants(ctx, thread.groupChat, { organizationId, userId });
        const participants = await Promise.all(
            usable.map(async ({ skill, skillId }) => {
                try {
                    const { instructions } = await prepareSkillInvocation(ctx, skill, userId);

                    return [
                        {
                            ...(skill.config && { config: skill.config }),
                            description: skill.description,
                            instructions,
                            name: skill.name,
                            skillId,
                            slug: skill.slug,
                        },
                    ];
                } catch (error) {
                    if (error instanceof LunoraError) {
                        return [];
                    }

                    throw error;
                }
            }),
        );

        const { debateRounds, stopRequestedAt, synthesizerSkillId } = thread.groupChat;

        return {
            ...(debateRounds !== undefined && { debateRounds }),
            mode: thread.groupChat.mode,
            participants: participants.flat(),
            ...(stopRequestedAt !== undefined && { stopRequestedAt }),
            ...(synthesizerSkillId !== undefined && { synthesizerSkillId }),
        };
    });

/** Whether a stop was requested after `since` (the turn's start). */
export const isGroupStopRequested = internalQuery
    .input({ since: v.number(), threadId: v.string() })
    .output(v.boolean())
    .query(async ({ args: { since, threadId }, ctx }) => {
        const thread = await ctx.db.get(threadId as Id<"threads">).catch(() => null);
        const stoppedAt = thread?.groupChat?.stopRequestedAt;

        return stoppedAt !== undefined && stoppedAt >= since;
    });

const rowText = (row: Doc<"messages">): string => {
    if (row.text) {
        return row.text;
    }

    const content = (row.message as { content?: unknown } | undefined)?.content;

    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .flatMap((part: { text?: unknown; type?: unknown }) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
            .join("\n");
    }

    return "";
};

/**
 * The recent shared history on the displayed path, top first, as text: user
 * messages and assistant TEXT (tool rows are skipped). Owner only.
 */
export const getGroupHistory = internalQuery
    .input({ threadId: v.string(), userId: v.string() })
    .output(
        v.array(
            v.object({
                agentName: v.optional(v.string()),
                id: v.string(),
                role: v.union(v.literal("user"), v.literal("assistant")),
                speakerSkillId: v.optional(v.string()),
                text: v.string(),
            }),
        ),
    )
    .query(async ({ args: { threadId, userId }, ctx }): Promise<GroupHistoryRow[]> => {
        const thread = await ctx.db.get(threadId as Id<"threads">).catch(() => null);

        if (!thread || thread.userId !== userId) {
            return [];
        }

        const newestFirst = thread.activeLeafMessageId
            ? await loadActivePathTail(ctx, thread._id, thread.activeLeafMessageId, GROUP_HISTORY_ROWS)
            : await ctx.db
                  .query("messages")
                  .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", thread._id))
                  .order("desc")
                  .take(GROUP_HISTORY_ROWS);

        return newestFirst.toReversed().flatMap((row): GroupHistoryRow[] => {
            const role = (row.message as { role?: string } | undefined)?.role;

            if (row.tool || (role !== "user" && role !== "assistant") || (row.status !== "success" && row.status !== "pending")) {
                return [];
            }

            const text = rowText(row);

            if (!text.trim()) {
                return [];
            }

            return [
                {
                    ...(role === "assistant" && row.speakerSkillId && row.agentName && { agentName: row.agentName }),
                    id: row._id as string,
                    role,
                    ...(role === "assistant" && row.speakerSkillId && { speakerSkillId: row.speakerSkillId }),
                    text,
                },
            ];
        });
    });

/**
 * Stamp a speaker's saved rows with its skill id and name. The agent writes
 * `agentName` itself; this makes it the participant's even for rows saved
 * before the name was set, and adds the id the UI and the labelling key on.
 */
export const markSpeakerMessages = internalMutation
    .input({
        agentName: v.string(),
        messageIds: v.array(v.string()),
        skillId: v.string(),
        threadId: v.string(),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args: { agentName, messageIds, skillId, threadId, userId }, ctx }) => {
        const thread = await ctx.db.get(threadId as Id<"threads">).catch(() => null);

        if (!thread || thread.userId !== userId) {
            return null;
        }

        await Promise.all(
            messageIds.map(async (messageId) => {
                const row = await ctx.db.get(messageId as Id<"messages">).catch(() => null);

                if (row && (row.threadId as string) === threadId) {
                    await patchMessage(ctx.db, row._id, { agentName, speakerSkillId: skillId });
                }
            }),
        );

        return null;
    });
