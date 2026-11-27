import { api } from "@neore/backend/api";

import { ago, DAY, HOUR, MINUTE } from "../clock";
import type { LunoraFixture } from "../lunora";
import { lunora } from "../lunora";
import { userFixtures } from "./user";

/** The signed-in preferences row the agent group of settings tabs reads: keys, MCP servers, agent switches. */
const AGENT_PREFERENCES = {
    autoDetectComplexity: false,
    autoMediaEnrichment: false,
    browserClickMode: "page",
    codingAgentCommitIdentity: "agent",
    enableDatasource: false,
    enableKnowledge: true,
    enablePlanner: true,
    generalProviders: {
        tavily: { createdAt: ago(40 * DAY), enabled: true, hasKey: true, last4: "9f2c" },
    },
    mcpServers: [
        { enabled: true, name: "docs", protocol: "http", url: "https://docs.example.com/mcp" },
        {
            enabled: true,
            headers: [{ key: "Authorization", value: "Bearer ••••" }],
            name: "Linear",
            protocol: "sse",
            url: "https://mcp.linear.example/sse",
        },
        { enabled: false, name: "Local files", protocol: "http", url: "https://files.example.com/mcp" },
    ],
    messengerKeys: {
        telegram_bot_token: { createdAt: ago(12 * DAY), enabled: true, hasKey: true, last4: "Q7xA" },
    },
    providerApiKeys: {
        anthropic: { createdAt: ago(60 * DAY), enabled: true, hasKey: true, last4: "k3Zp", lastRotatedAt: ago(9 * DAY) },
        openrouter: { createdAt: ago(21 * DAY), enabled: true, hasKey: true, last4: "d81e" },
    },
} as const;

/** What the agent, MCP, tools, sub-agent roles and API keys tabs read, populated with a few real-looking rows. */
export const agentSettingsFixtures = (): LunoraFixture[] => [
    ...userFixtures({ preferences: AGENT_PREFERENCES as never }),
    lunora(api.chat.mcp_registry.listMcpRegistryServers, { error: "The MCP registry is currently unavailable.", ok: false }),
    lunora(api.connectors.mcp_servers.listMcpServerSignIns, [
        {
            accountLabel: "ada@example.com",
            hasRefreshToken: true,
            scopes: ["read", "write"],
            serverName: "Linear",
            serverUrl: "https://mcp.linear.example/sse",
            status: "connected",
            tokenExpiresAt: ago(-HOUR),
        },
    ]),
    lunora(api.chat.tool_permissions.getToolPermissionSettings, {
        autoApproveLowRisk: false,
        builtIn: [
            { available: true, category: "Search", defaultMode: "auto", key: "builtin:webSearch", name: "webSearch" },
            { available: true, category: "Search", defaultMode: "auto", key: "builtin:fetchUrl", name: "fetchUrl" },
            { available: true, category: "Files", defaultMode: "ask", key: "builtin:writeFile", name: "writeFile" },
            { available: false, category: "Files", defaultMode: "ask", key: "builtin:runShell", name: "runShell" },
        ],
        grants: { "mcp:docs:search": ago(-3 * HOUR), "builtin:writeFile": ago(-30 * MINUTE) },
        lowRiskTrustedServers: ["docs"],
        overrides: { "builtin:fetchUrl": "ask", "builtin:writeFile": "off" },
    }),
    lunora(api.chat.tool_permissions.listMcpToolPermissions, {
        servers: [
            {
                error: null,
                name: "docs",
                tools: [
                    {
                        defaultMode: "auto",
                        description: "Search the documentation.",
                        destructive: false,
                        key: "mcp:docs:search",
                        name: "search",
                        readOnly: true,
                    },
                    { defaultMode: "ask", description: "Delete a page.", destructive: true, key: "mcp:docs:delete", name: "delete", readOnly: false },
                ],
            },
            { error: "Connection refused", name: "Linear", tools: [] },
        ],
    }),
    lunora(api.sub_agents.role_settings.getSubAgentRoles, {
        project: null,
        user: {
            implementation: { mode: "prefer", model: "anthropic/claude-sonnet-4.5" },
            review: { instructions: "Check every change against our style guide.", mode: "always", model: "anthropic/claude-sonnet-4.5" },
        },
    }),
];

const TRIGGER_BASE = {
    botComputer: false,
    botId: null,
    description: null,
    eventSource: null,
    eventStatus: null,
    filters: [],
    inputTemplate: "Summarize my inbox and highlight urgent items.",
    lastError: null,
    nextTriggerAt: null,
    quietWhenEmpty: false,
    searchMode: null,
    systemPrompt: null,
    timezone: null,
    updatedAt: ago(DAY),
    webhookPreviousSecretExpiresAt: null,
    webhookSignatureScheme: null,
} as const;

/** The triggers tab: one schedule, one webhook and one that failed last time. */
export const triggerFixtures = (): LunoraFixture[] => [
    ...userFixtures(),
    lunora(api.bots.functions.listBots, []),
    lunora(api.triggers.functions.getTriggers, [
        {
            ...TRIGGER_BASE,
            _creationTime: ago(14 * DAY),
            _id: "trigger-daily",
            createdAt: ago(14 * DAY),
            cronExpression: "0 8 * * *",
            description: "Summarize my email inbox every morning",
            enabled: true,
            lastTriggeredAt: ago(4 * HOUR),
            model: "anthropic/claude-sonnet-4.5",
            name: "Daily inbox summary",
            timezone: "Europe/Berlin",
            triggerCount: 14,
            type: "schedule",
        },
        {
            ...TRIGGER_BASE,
            _creationTime: ago(6 * DAY),
            _id: "trigger-deploys",
            createdAt: ago(6 * DAY),
            cronExpression: null,
            enabled: true,
            lastError: "The model refused the request.",
            lastTriggeredAt: ago(2 * DAY),
            model: "anthropic/claude-sonnet-4.5",
            name: "Deploy notifications",
            triggerCount: 3,
            type: "webhook",
            webhookSignatureScheme: "timestamped",
        },
        {
            ...TRIGGER_BASE,
            _creationTime: ago(3 * DAY),
            _id: "trigger-weekly",
            createdAt: ago(3 * DAY),
            cronExpression: "0 9 * * 1",
            enabled: false,
            lastTriggeredAt: null,
            model: "anthropic/claude-sonnet-4.5",
            name: "Weekly planning",
            triggerCount: 0,
            type: "schedule",
        },
    ] as never),
    lunora(api.triggers.functions.getTriggerExecutions, []),
];
