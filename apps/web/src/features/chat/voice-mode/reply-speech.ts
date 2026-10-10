/**
 * Pure helpers shared by hands-free voice mode and "Auto-read replies": which
 * reply just finished, which skill (and so which voice) it belongs to, and
 * which `speechSynthesis` voice a preference names.
 */

/** The fields of a chat `UIMessage` these helpers read. */
export interface SpeakableMessage {
    id: string;
    role: string;
    /** Group chat: the participant (skill id) that wrote this reply. */
    speakerSkillId?: string;
    status: string;
    text: string;
}

/** The subset of `SpeechSynthesisVoice` used to pick one. */
export interface VoiceLike {
    default?: boolean;
    lang: string;
    name: string;
}

const UNFINISHED_STATUSES = new Set(["pending", "streaming"]);
const SKILL_INVOCATION_RE = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/;
const LANGUAGE_TAG_RE = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i;

/** Id of the newest assistant message, or `null` when there is none. */
export const latestAssistantId = (messages: ReadonlyArray<SpeakableMessage>): string | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];

        if (message?.role === "assistant") {
            return message.id;
        }
    }

    return null;
};

export type FinishedReply = { failed: boolean; message: SpeakableMessage };

/**
 * The reply that finished since `baselineId` was the newest assistant message,
 * or `null` while it is still being written. The thread's LAST message must be
 * that reply: while the prompt is the last row, the reply has not started.
 */
export const findFinishedReply = (
    messages: ReadonlyArray<SpeakableMessage>,
    { baselineId, isStreaming }: { baselineId: string | null; isStreaming: boolean },
): FinishedReply | null => {
    if (isStreaming) {
        return null;
    }

    const last = messages.at(-1);

    if (!last || last.role !== "assistant" || last.id === baselineId || UNFINISHED_STATUSES.has(last.status)) {
        return null;
    }

    return { failed: last.status === "failed", message: last };
};

/** The user prompt the given reply answers: the closest user message before it. */
export const promptBefore = (messages: ReadonlyArray<SpeakableMessage>, replyId: string): SpeakableMessage | null => {
    const index = messages.findIndex((message) => message.id === replyId);

    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const message = messages[cursor];

        if (message?.role === "user") {
            return message;
        }
    }

    return null;
};

/** `"/code-reviewer check this"` → `"code-reviewer"`: the skill a prompt invoked with a slash command. */
export const skillSlugFromPrompt = (text: string): string | null => SKILL_INVOCATION_RE.exec(text.trimStart())?.[1] ?? null;

const normalizeLang = (lang: string): string => lang.replaceAll("_", "-").toLowerCase();

const findByLanguage = <V extends VoiceLike>(voices: ReadonlyArray<V>, lang: string): V | undefined => {
    const wanted = normalizeLang(lang);
    const primary = wanted.split("-", 1)[0];

    return (
        voices.find((voice) => normalizeLang(voice.lang) === wanted) ??
        voices.find((voice) => normalizeLang(voice.lang).split("-", 1)[0] === primary && voice.default) ??
        voices.find((voice) => normalizeLang(voice.lang).split("-", 1)[0] === primary)
    );
};

/**
 * Resolves a voice preference (a skill's `config.voice`): an exact voice NAME
 * wins, then a BCP 47 language tag, then the reply's language. `undefined`
 * leaves the choice to the browser.
 */
export const pickVoice = <V extends VoiceLike>(voices: ReadonlyArray<V>, preference: string | undefined, fallbackLang: string | undefined): V | undefined => {
    const wanted = preference?.trim();

    if (wanted) {
        const lowered = wanted.toLowerCase();
        const byName = voices.find((voice) => voice.name.toLowerCase() === lowered);

        if (byName) {
            return byName;
        }

        if (LANGUAGE_TAG_RE.test(wanted)) {
            const byLanguage = findByLanguage(voices, wanted);

            if (byLanguage) {
                return byLanguage;
            }
        }

        // A partial name ("Samantha" for "Samantha (Enhanced)").
        const byPartialName = voices.find((voice) => voice.name.toLowerCase().includes(lowered));

        if (byPartialName) {
            return byPartialName;
        }
    }

    return fallbackLang ? findByLanguage(voices, fallbackLang) : undefined;
};

/** A skill reduced to what picking its voice needs. */
export interface SkillVoiceEntry {
    id: string;
    slug: string;
    voice?: string;
}

/**
 * The voice of the skill behind a reply: the group-chat participant that wrote
 * it (`speakerSkillId`), else the skill its prompt invoked with `/slug`.
 */
export const findSkillVoice = (
    skills: ReadonlyArray<SkillVoiceEntry>,
    { skillId, slug }: { skillId?: string | null; slug?: string | null },
): string | undefined => {
    const skill = (skillId ? skills.find((entry) => entry.id === skillId) : undefined) ?? (slug ? skills.find((entry) => entry.slug === slug) : undefined);
    const voice = skill?.voice?.trim();

    return voice || undefined;
};
