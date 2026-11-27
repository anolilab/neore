/**
 * `/memory`: the paired owner asks what is remembered about them. Answered with a digest (`memory/export-format.ts`)
 * by `messenger/respond.ts#sendMemoryDigest`, never by the model, and only in the chat the connection was paired in:
 * in a group the owner shares, the digest would reach every member.
 */

/** `/memory`, `memory`, or Telegram's `/memory@my_bot`: the whole message. The slash is optional, as for `/pair`, since Slack and Teams keep a leading slash for their own commands. */
const MEMORY_COMMAND = /^\s*\/?memory(?:@\S+)?\s*$/iu;

export const isMemoryCommand = (text: string | undefined): boolean => text !== undefined && MEMORY_COMMAND.test(text);

export const MEMORY_COMMAND_OTHER_CHAT_NOTICE = "Send /memory in your direct chat with this bot: what it remembers about you is not shown here.";
