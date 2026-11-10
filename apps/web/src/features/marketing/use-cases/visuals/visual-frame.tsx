import { domAnimation, LazyMotion } from "motion/react";
import type { ReactNode } from "react";

/** The box every use-case visual sits in. The label is the image's accessible name; the drawing itself is decorative. */
export const VisualFrame = ({ children, label }: { children: ReactNode; label: string }) => (
    <div
        aria-label={label}
        className="relative flex min-h-[280px] w-full flex-col justify-center overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6"
        role="img"
    >
        <LazyMotion features={domAnimation}>
            <div aria-hidden="true" className="flex w-full flex-col gap-4">
                {children}
            </div>
        </LazyMotion>
    </div>
);
