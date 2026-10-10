/**
 * The memory taxonomy.
 *
 * Five types, each answering a different question about the user:
 *
 * - `identity`   — who they are: name, role, location, language, pronouns.
 * - `preference` — how they want things: likes, dislikes, style, standing
 *                  instructions, and corrections they made to the assistant.
 * - `context`    — what they are working with: projects, goals, deadlines, their
 *                  stack and domain facts about their situation.
 * - `activity`   — what they did or tend to do: events and observed behaviour.
 *                  The only type that DECAYS — an observation not seen again goes
 *                  stale; one seen repeatedly is promoted by reflection into a
 *                  `preference` or `identity`.
 * - `experience` — what they know: skills, expertise, background.
 */
import { v } from "lunorash/server";

export const MEMORY_TYPES = ["identity", "preference", "context", "activity", "experience"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Spelled out inline rather than mapped from {@link MEMORY_TYPES}: codegen resolves a literal union, not a computed one. */
export const vMemoryType = v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience"));

export const isMemoryType = (value: unknown): value is MemoryType => typeof value === "string" && (MEMORY_TYPES as ReadonlyArray<string>).includes(value);

/** When a memory was last confirmed: the explicit stamp, else its last write, else its creation. */
export const lastConfirmedOf = (row: { _creationTime: number; lastConfirmedAt?: number | null; updatedAt?: number | null }): number =>
    row.lastConfirmedAt ?? row.updatedAt ?? row._creationTime;

/**
 * The type guidance the extraction, compression and reflection prompts share, so
 * the model is told the same taxonomy everywhere.
 */
export const MEMORY_TYPE_GUIDE = `Types:
- identity: Who the user is — name, role, location, language, pronouns, personal attributes
- preference: Likes/dislikes, preferred tools, methods and styles, standing instructions, corrections the user made to the assistant
- context: The user's situation — current projects, goals, deadlines, their stack, domain facts about their work
- activity: Things the user did or tends to do — events, observed behaviour and communication patterns
- experience: Skills, expertise and background knowledge`;
