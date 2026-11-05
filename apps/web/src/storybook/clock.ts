/**
 * Storybook's "now": Thursday 5 November 2026, 12:00 UTC. Fixtures date things relative to
 * it, and `pinClock` moves the page's clock there, so "2 hours ago" and "Expires in 60 days"
 * read the same on every run. CI also pins the time zone to UTC (`vitest.storybook.config.ts`).
 */
export const STORY_NOW = Date.UTC(2026, 10, 5, 12);

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** `STORY_NOW` minus `ms`, as a timestamp. */
export const ago = (ms: number): number => STORY_NOW - ms;

const RealDate = Date;

/**
 * Shifts `Date` so that the page starts at `at` and time keeps moving from there. A frozen
 * clock would stall every timeout and animation that measures elapsed time with `Date.now()`.
 */
export const pinClock = (at: number = STORY_NOW): void => {
    const offset = at - RealDate.now();

    class StoryDate extends RealDate {
        constructor(...args: ConstructorParameters<DateConstructor> | []) {
            if (args.length === 0) {
                super(RealDate.now() + offset);
            } else {
                super(...(args as ConstructorParameters<DateConstructor>));
            }
        }

        static override now(): number {
            return RealDate.now() + offset;
        }
    }

    globalThis.Date = StoryDate as DateConstructor;
};
