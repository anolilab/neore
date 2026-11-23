import cn from "@neore/ui/utils/cn";
import { useReducedMotion } from "motion/react";
import { getExample, renderAvatarSvg } from "open-bot-avatar";
import type { MountedAvatar } from "open-bot-avatar/dom";
import { mountAvatar } from "open-bot-avatar/dom";
import type { FC } from "react";
import { useEffect, useRef, useSyncExternalStore } from "react";

/** The states part 1 shows: at rest, at work, and finished. */
export type BotAvatarState = "idle" | "working" | "done";

export interface BotAvatarProps {
    className?: string;
    /** Width and height in CSS pixels. */
    size?: number;
    state?: BotAvatarState;
}

/** The one body in part 1. */
const BODY = getExample("mug");
/** The brand lime (`--primary`) as a hex value: the static image is an `<img>`, which cannot read page variables. */
const BODY_COLOR = "#caff00";

/** Whether a 2D canvas can draw. Probed once, in the browser; the server renders the static image. */
const canvasAvailable = (() => {
    let ready: boolean | undefined;

    return (): boolean => {
        if (ready === undefined) {
            // Path2D first: asking jsdom for a context logs a "not implemented" error.
            ready = typeof Path2D !== "undefined" && Boolean(document.createElement("canvas").getContext("2d"));
        }

        return ready;
    };
})();

const subscribeNothing = (): (() => void) => () => {};
const noCanvas = (): boolean => false;

/** A live avatar that the engine animates on a canvas. It is mounted once; state changes go through `update`. */
const LiveBotAvatar: FC<{ className?: string; size: number; state: BotAvatarState }> = ({ className, size, state }) => {
    const host = useRef<HTMLDivElement>(null);
    const avatar = useRef<MountedAvatar | null>(null);

    useEffect(() => {
        const element = host.current;

        if (!element || !BODY) {
            return undefined;
        }

        avatar.current = mountAvatar(element, { color: BODY_COLOR, definition: BODY, label: "", reducedMotion: false });

        return () => {
            avatar.current?.destroy();
            avatar.current = null;
        };
    }, []);

    useEffect(() => {
        avatar.current?.update({ state });
    }, [state]);

    return <div className={cn("shrink-0", className)} ref={host} style={{ height: size, width: size }} />;
};

/**
 * A bot's avatar in a group-chat label: the Open Bot Avatar body, animated on a canvas. Under reduced motion,
 * or where no canvas can draw, it is a still image of the same state instead.
 */
export const BotAvatar: FC<BotAvatarProps> = ({ className, size = 24, state = "idle" }) => {
    const reducedMotion = useReducedMotion();
    // The server and the first client render both take the still branch, so hydration matches.
    const canvas = useSyncExternalStore(subscribeNothing, canvasAvailable, noCanvas);

    if (!BODY) {
        return null;
    }

    if (canvas && reducedMotion !== true) {
        return <LiveBotAvatar className={className} size={size} state={state} />;
    }

    const svg = renderAvatarSvg(BODY, { color: BODY_COLOR, reducedMotion: true, size, state });

    return (
        <img
            alt=""
            className={cn("block shrink-0", className)}
            height={size}
            role="presentation"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
            width={size}
        />
    );
};
