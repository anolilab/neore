/**
 * Lunora validator for `CapabilityReport` (`@neore/ai/capabilities`), the shape a
 * host session row stores. `capability-report.test.ts` pins that it and the type
 * accept each other's values.
 *
 * Every capability is spelled out in full, not through a shared const: codegen
 * types a bare const reference as `unknown` (see the validators section of the
 * root CLAUDE.md), and this validator is meant to be an `.output()` and a table
 * column. Every member is optional, like the type: one a report lacks reads as
 * `unknown`.
 */
import { v } from "lunorash/server";

import { MAX_LENGTH } from "./validators";

export const vCapabilityReport = v.object({
    groups: v.object({
        checkpoints: v.optional(
            v.object({
                fileRollback: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
                memoryRollback: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
            }),
        ),
        context: v.optional(
            v.object({
                compactOnRequest: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
                usageMeter: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
            }),
        ),
        identity: v.optional(
            v.object({
                account: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
                models: v.optional(v.array(v.object({ id: v.string().max(MAX_LENGTH.short), name: v.string().max(MAX_LENGTH.short) }))),
                reasoningEffort: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
            }),
        ),
        permissions: v.optional(
            v.object({
                modes: v.optional(v.array(v.string().max(MAX_LENGTH.short))),
            }),
        ),
        planning: v.optional(
            v.object({
                planMode: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
            }),
        ),
        sessions: v.optional(
            v.object({
                create: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
                listNative: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
                load: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
            }),
        ),
        streaming: v.optional(
            v.object({
                reasoning: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
                text: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
                toolParts: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
            }),
        ),
        subagents: v.optional(
            v.object({
                ownChildren: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
            }),
        ),
        tools: v.optional(
            v.object({
                approvalRequest: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
                call: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
                declinePath: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
            }),
        ),
        turns: v.optional(
            v.object({
                cancel: v.optional(
                    v.union(
                        v.object({ degradation: v.literal("none"), supported: v.literal(true) }),
                        v.object({
                            degradation: v.union(v.literal("restart"), v.literal("synthetic"), v.literal("divergent")),
                            note: v.string().max(MAX_LENGTH.long),
                            supported: v.literal(true),
                        }),
                        v.object({ reason: v.union(v.literal("not_offered"), v.literal("not_enforced"), v.literal("unknown")), supported: v.literal(false) }),
                    ),
                ),
                followUp: v.optional(
                    v.union(
                        v.object({ degradation: v.optional(v.literal("restart")), kind: v.literal("steer") }),
                        v.object({ kind: v.literal("queue") }),
                        v.object({ kind: v.literal("none") }),
                    ),
                ),
            }),
        ),
    }),
    reportedAt: v.number(),
    version: v.literal(1),
});
