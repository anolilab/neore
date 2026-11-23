import cn from "@neore/ui/utils/cn";
import { useReducedMotion } from "motion/react";
import { getExample, renderAvatarSvg } from "open-bot-avatar";
import type { MountedAvatar } from "open-bot-avatar/dom";
import { mountAvatar } from "open-bot-avatar/dom";
import type { FC } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** The states part 1 shows: at rest, at work, and finished. */
export type BotAvatarState = "idle" | "working" | "done";

export interface BotAvatarProps {
    className?: string;
    /** The speaker's name. It picks the body colour, so the same speaker always looks the same. */
    name?: string;
    /** Width and height in CSS pixels. */
    size?: number;
    state?: BotAvatarState;
}

/** The one body in part 1. */
const BODY = getExample("mug");

/**
 * Body colours, all hex: the static image is an `<img>`, which cannot read page variables. The first is the brand
 * lime (`--primary`), which is also the colour of a speaker with no name.
 */
const BODY_COLORS = ["#caff00", "#ff6a1a", "#1fbf68", "#1f7cf2", "#b15cff", "#ff4d8d", "#00c2d1", "#ffb020"];
const DEFAULT_COLOR = "#caff00";

/** A stable body colour for a speaker: a polynomial hash of the name, so one name always maps to one colour. */
export function botColorFor(name: string | undefined): string {
    if (name === undefined) {
        return DEFAULT_COLOR;
    }

    let hash = 0;

    for (const char of name) {
        hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 2_147_483_647;
    }

    return BODY_COLORS[hash % BODY_COLORS.length] ?? DEFAULT_COLOR;
}

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

/** Start a label's live avatar a little before it scrolls into view, so it is already moving when seen. */
const VIEW_MARGIN = "200px 0px";

/** A live avatar that the engine animates on a canvas. It is remounted only when the colour changes; state goes through `update`. */
const LiveBotAvatar: FC<{ color: string; size: number; state: BotAvatarState }> = ({ color, size, state }) => {
    const host = useRef<HTMLDivElement>(null);
    const avatar = useRef<MountedAvatar | null>(null);

    useEffect(() => {
        const element = host.current;

        if (!element || !BODY) {
            return undefined;
        }

        avatar.current = mountAvatar(element, { color, definition: BODY, label: "", reducedMotion: false });

        return () => {
            avatar.current?.destroy();
            avatar.current = null;
        };
    }, [color]);

    // Also after a remount for a new colour, so the new avatar takes the current state.
    useEffect(() => {
        avatar.current?.update({ state });
    }, [color, state]);

    return <div className="block" ref={host} style={{ height: size, width: size }} />;
};

/**
 * A bot's avatar in a group-chat label: the Open Bot Avatar body, animated on a canvas while the label is in view.
 * Under reduced motion, where no canvas can draw, or while the label is out of view, it is a still image of the
 * same state instead.
 */
export const BotAvatar: FC<BotAvatarProps> = ({ className, name, size = 24, state = "idle" }) => {
    const reducedMotion = useReducedMotion();
    // The server and the first client render both take the still branch, so hydration matches.
    const canvas = useSyncExternalStore(subscribeNothing, canvasAvailable, noCanvas);
    const anchor = useRef<HTMLSpanElement>(null);
    // Without an IntersectionObserver every label counts as in view.
    const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined");

    useEffect(() => {
        const element = anchor.current;

        if (!element || typeof IntersectionObserver === "undefined") {
            return undefined;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                setInView(entries.at(-1)?.isIntersecting ?? false);
            },
            { rootMargin: VIEW_MARGIN },
        );

        observer.observe(element);

        return () => {
            observer.disconnect();
        };
    }, []);

    if (!BODY) {
        return null;
    }

    const color = botColorFor(name);
    const live = canvas && reducedMotion !== true && inView;
    const svg = renderAvatarSvg(BODY, { color, reducedMotion: true, size, state });

    return (
        <span className={cn("inline-flex shrink-0", className)} ref={anchor} style={{ height: size, width: size }}>
            {live ? (
                <LiveBotAvatar color={color} size={size} state={state} />
            ) : (
                <img
                    alt=""
                    className="block"
                    height={size}
                    role="presentation"
                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
                    width={size}
                />
            )}
        </span>
    );
};
