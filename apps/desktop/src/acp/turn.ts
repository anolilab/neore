import { randomUUID } from "node:crypto";

import type { StopReason, ToolState, TurnState } from "./types";

const MAX_TURN_TEXT = 256_000;

/** One turn as the window shows it. A class so its own mutations stay on `this`. */
export class Turn implements TurnState {
    public readonly id = randomUUID();

    public stopReason: StopReason | undefined;

    public text = "";

    public thought = "";

    public readonly tools: ToolState[] = [];

    public truncated = false;

    /** `scrub` runs over the agent's text when the window reads it, so a value split across two chunks is still caught. */
    public constructor(
        public readonly user: string,
        private readonly scrub: (text: string) => string = (text) => text,
    ) {}

    public append(field: "text" | "thought", chunk: string): void {
        const room = Math.max(0, MAX_TURN_TEXT - this[field].length);

        if (chunk.length > room) {
            this.truncated = true;
        }

        this[field] += chunk.slice(0, room);
    }

    /** A copy the window can keep: later updates do not change it. */
    public toState(): TurnState {
        return {
            id: this.id,
            stopReason: this.stopReason,
            text: this.scrub(this.text),
            thought: this.scrub(this.thought),
            tools: this.tools.map((tool) => { return { ...tool }; }),
            truncated: this.truncated,
            user: this.user,
        };
    }

    /** The first reason wins: a turn that ended does not end again. */
    public end(reason: StopReason): void {
        this.stopReason ??= reason;
    }
}
