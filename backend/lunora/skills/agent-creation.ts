import { LunoraError, v } from "lunorash/server";
import z from "zod/v4";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";

/**
 * Agent-Creates-Agent
 *
 * Allows an AI agent to programmatically create new skills/agents during
 * a conversation. The AI can define a skill's name, instructions, tools,
 * and configuration — then the skill is instantly available for use.
 *
 * This is exposed as a tool that the AI can call, enabling self-replicating
 * agent workflows where a coordinator creates specialized sub-agents.
 */
import type { ToolCtx as ToolContext } from "../agent/client";
import { createTool } from "../agent/client";
import toonEncodeOutput from "../chat/tools/toon-encode";
import { toolsLogger } from "../lib/logger";

export const createSkillFromAgent = internalMutation
    .input({
        additionalTools: v.optional(v.array(v.string())),
        category: v.optional(v.string()),
        description: v.string(),
        instructions: v.string(),
        name: v.string(),
        preferredModel: v.optional(v.string()),
        slug: v.string(),
        tags: v.optional(v.array(v.string())),
        userId: v.string(),
    })
    .mutation(async ({ args, ctx }) => {
        const { additionalTools, category, description, instructions, name, preferredModel, slug, tags, userId } = args;

        // Check for slug uniqueness
        const existing = await ctx.db.skills.findFirst({ where: { slug, userId } });

        if (existing) {
            throw new LunoraError("CONFLICT", `A skill with slug "${slug}" already exists. Choose a different slug.`);
        }

        const config =
            preferredModel || additionalTools
                ? {
                      ...(preferredModel && { preferredModel }),
                      ...(additionalTools && { additionalTools }),
                  }
                : undefined;
        const insertedSkillId = await ctx.db.insert("skills", {
            category: category ?? "general",
            config,
            currentVersion: 1,
            description,
            instructions,
            name,
            slug,
            source: { type: "editor" as const },
            tags: tags ?? [],
            userId,
            visibility: "private",
        });
        const skillId = insertedSkillId as Id<"skills">;

        // Auto-install for the user
        await ctx.db.insert("userSkills", {
            addedAt: ctx.now,
            enabled: true,
            skillId,
            userId,
        });

        // Create initial version history
        await ctx.db.insert("skillHistory", {
            changeType: "created",
            config,
            createdAt: ctx.now,
            instructions,
            note: "Created by AI agent",
            skillId,
            userId,
            version: 1,
        });

        return { skillId: skillId as string };
    });

/**
 * Create Agent Tool — allows the AI to create new skills during conversation.
 */
export const createAgentTool = createTool<
    {
        additionalTools?: string[];
        category?: string;
        description: string;
        instructions: string;
        name: string;
        preferredModel?: string;
        slug: string;
        tags?: string[];
    },
    {
        error?: string;
        name: string;
        skillId?: string;
        success: boolean;
    },
    ToolContext
>({
    description: `Create a new AI agent/skill that can be used in future conversations.
The created agent will have its own instructions, tool configuration, and can be invoked via slash commands.
Use this to create specialized agents for specific tasks — e.g., a "code reviewer" agent, a "data analyst" agent, etc.
The new agent is private to the user and can be customized later.`,
    execute: async (context, input) => {
        if (!context.userId) {
            return { error: "Authentication required", name: input.name, success: false };
        }

        toolsLogger.debug(`[CREATE_AGENT] Creating agent: ${input.name}`);

        try {
            const result = (await context.runMutation(internal.skills.agent_creation.createSkillFromAgent, {
                additionalTools: input.additionalTools,
                category: input.category,
                description: input.description,
                instructions: input.instructions,
                name: input.name,
                preferredModel: input.preferredModel,
                slug: input.slug,
                tags: input.tags,
                userId: context.userId,
            })) as { skillId: string };

            return {
                name: input.name,
                skillId: result.skillId,
                success: true,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            toolsLogger.error(`[CREATE_AGENT] Failed: ${errorMessage}`);

            return { error: errorMessage, name: input.name, success: false };
        }
    },
    inputSchema: z
        .object({
            additionalTools: z.array(z.string()).optional().meta({ description: "Additional tool names to enable" }),
            category: z.string().optional().meta({ description: "Category: 'coding', 'writing', 'analysis', 'automation', 'creative'" }),
            description: z.string().min(1).max(500).meta({ description: "Brief description of what this agent does" }),
            instructions: z.string().min(10).max(10_000).meta({ description: "System prompt / instructions for the agent" }),
            name: z.string().min(1).max(100).meta({ description: "Display name for the agent" }),
            preferredModel: z.string().optional().meta({ description: "Preferred AI model (e.g., 'claude-sonnet-4-5-20250514')" }),
            slug: z
                .string()
                .min(1)
                .max(50)
                .regex(/^[\da-z-]+$/)
                .meta({ description: "URL-safe slug for slash command (e.g., 'code-reviewer')" }),
            tags: z.array(z.string()).optional().meta({ description: "Tags for discovery" }),
        })
        .strict(),
    title: "Create Agent",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});
