"use client";

import { api } from "@neore/backend/api";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef } from "react";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useLunoraActionOptions } from "@/lib/lunora/crpc";

import type { SkillVoiceEntry, SpeakableMessage } from "./reply-speech";
import { findSkillVoice, promptBefore, skillSlugFromPrompt } from "./reply-speech";
import type { SpeechHandle, TtsOptions } from "./speaker";
import { speakReply } from "./speaker";
import { isSpeechVoice, ttsPauseMs } from "./tts-availability";

/**
 * Speaks a finished reply. With `registryTts` (hands-free mode) a signed-in
 * user hears the registry TTS model, and a guest — or anyone, whenever TTS
 * fails — the browser's voice (`speaker.ts`). Without it ("Auto-read replies",
 * which promises the browser's voice and runs unattended on every reply) only
 * the browser speaks.
 *
 * The voice is the skill's (`config.voice`) when the reply belongs to one — a
 * group-chat participant, or a `/slug` invocation — else the user's default
 * (`userSettings.voiceModeVoice`). A skill voice that names a TTS preset picks
 * the TTS voice; any other (a browser voice name, a language tag) picks the
 * browser voice used on fallback. The thread's language guides that fallback.
 *
 * The user's skills are fetched once, and only when a reply actually names a
 * skill, so plain chats never pay for it. A skill the caller cannot list
 * (someone else's, in a shared thread) speaks in the default voice.
 *
 * `isStale`, checked after that lookup, lets a caller drop a read whose moment
 * passed while it waited (the thread changed) before a word is spoken.
 */
const SILENT: SpeechHandle = { cancel: () => undefined, done: Promise.resolve() };

/** Until when TTS is not tried again, after a refusal or a spent limit — shared by every mounted reader. */
const ttsPause = { until: 0 };

const useSpeakReply = ({ registryTts = false }: { registryTts?: boolean } = {}): ((
    messages: ReadonlyArray<SpeakableMessage>,
    reply: SpeakableMessage,
    isStale?: () => boolean,
) => Promise<SpeechHandle>) => {
    const { thread } = useChatThread();
    const { isAnonymous } = useIsAnonymous();
    const { data: userSettings } = useUserSettings();
    const { mutateAsync: getSkills } = useMutation(useLunoraActionOptions(api.skills.functions.getSkills));
    const { mutateAsync: synthesizeSpeech } = useMutation(useLunoraActionOptions(api.voice.speech.synthesizeSpeech));
    const skillsRef = useRef<Promise<SkillVoiceEntry[]> | null>(null);
    const lang = thread?.language;
    const defaultVoice = userSettings?.voiceModeVoice;

    return useCallback(
        async (messages, reply, isStale) => {
            const skillId = reply.speakerSkillId ?? null;
            const slug = skillId ? null : skillSlugFromPrompt(promptBefore(messages, reply.id)?.text ?? "");
            let skillVoice: string | undefined;

            if (skillId || slug) {
                skillsRef.current ??= getSkills({})
                    .then((skills) =>
                        skills.map((skill) => {
                            return { id: skill._id, slug: skill.slug, voice: skill.config?.voice };
                        }),
                    )
                    .catch(() => {
                        // Not cached: the next reply that names a skill asks again.
                        skillsRef.current = null;

                        return [];
                    });
                skillVoice = findSkillVoice(await skillsRef.current, { skillId, slug });
            }

            if (isStale?.()) {
                return SILENT;
            }

            const tts: TtsOptions | undefined =
                !registryTts || isAnonymous || Date.now() < ttsPause.until
                    ? undefined
                    : {
                          onUnavailable: (error) => {
                              const pause = ttsPauseMs(error);

                              if (pause > 0) {
                                  ttsPause.until = Date.now() + pause;
                              }
                          },
                          synthesize: synthesizeSpeech,
                          voice: isSpeechVoice(skillVoice) ? skillVoice.trim() : defaultVoice,
                      };

            return speakReply(reply.text, { lang, tts, voice: isSpeechVoice(skillVoice) ? undefined : skillVoice });
        },
        [defaultVoice, getSkills, isAnonymous, lang, registryTts, synthesizeSpeech],
    );
};

export default useSpeakReply;
