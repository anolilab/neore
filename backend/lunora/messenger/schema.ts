/**
 * Non-table exports from the original `messenger/schema.ts`.
 *
 * The table definitions moved to the generated top-level `lunora/schema.ts`;
 * these types and validators are still referenced by handlers, so they stay here.
 */
export type MessengerPlatform = "discord" | "feishu" | "line" | "slack" | "teams" | "telegram" | "wechat" | "whatsapp";
