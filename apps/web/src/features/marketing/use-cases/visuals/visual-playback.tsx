import { useInView } from "motion/react";
import type { ReactNode } from "react";
import { createContext, use, useRef } from "react";

const PlaybackContext = createContext(true);

/**
 * Runs a visual's loops only while it is on screen. Off screen the visual holds its final frame, and it plays again from
 * the start when it comes back into view.
 */
export const VisualPlayback = ({ children }: { children: ReactNode }) => {
    const ref = useRef<HTMLDivElement>(null);
    const inView = useInView(ref);

    return (
        <PlaybackContext value={inView}>
            <div ref={ref}>{children}</div>
        </PlaybackContext>
    );
};

/** Whether the visual around the caller is on screen. Always true outside a `VisualPlayback`. */
export const usePlaying = (): boolean => use(PlaybackContext);
