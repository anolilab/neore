/**
 * `/memory`: the paired owner asks what is remembered about them. Answered with a digest (`memory/export-format.ts`)
 * by `messenger/respond.ts#sendMemoryDigest`, never by the model, and only in the chat the connection was paired in
 * when the platform says it is one-to-one: in a group, the digest would reach every member.
 */

import { withoutLeadingMention } from "./types";

/** `/memory`, `memory`, or Telegram's `/memory@my_bot`: the whole message. The slash is optional, as for `/pair`, since Slack and Teams keep a leading slash for their own commands. */
const MEMORY_COMMAND = /^\s*\/?memory(?:@\S+)?\s*$/iu;

export const isMemoryCommand = (text: string | undefined): boolean => text !== undefined && MEMORY_COMMAND.test(withoutLeadingMention(text));

export const MEMORY_COMMAND_OTHER_CHAT_NOTICE = "Send /memory in your direct chat with this bot: what it remembers about you is not shown here.";

/** For a Discord message that names no channel type (`directUnknown`): only the slash command tells a DM from a group DM. */
export const MEMORY_COMMAND_DISCORD_SLASH_NOTICE = "Use the /memory slash command in your direct message with the bot.";

/** Sent when the digest could not be read; the cause is logged, never shown. */
export const MEMORY_DIGEST_FAILED_NOTICE = "Couldn't read your memories right now. Please try again in a moment.";

/** Sent past the download's own limit (`memory/export`), which `/memory` shares. */
export const MEMORY_COMMAND_RATE_LIMITED_NOTICE = "You've asked for your memories often in the last hour. Please try again later.";
