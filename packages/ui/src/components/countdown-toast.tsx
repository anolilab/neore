import { toast } from "sonner";

import type { CountdownToastOptions } from "./countdown-toast-card";
import { CountdownToastCard } from "./countdown-toast-card";

/** Shows a toast whose footer counts down to its dismissal. */
const countdownToast = (options: CountdownToastOptions) =>
    toast.custom((id) => <CountdownToastCard {...options} id={id} />, {
        classNames: {
            // The card supplies its own padding, and `!pe-0` cancels the Toaster's content padding that sonner still applies.
            content: "!pe-0",
            // Focus ring for the outer <li> (the card is not focusable itself). `!shadow-none` would hide sonner's own ring.
            toast: "!border-0 !bg-transparent !p-0 !shadow-none focus-visible:!shadow-[0_0_0_2px_var(--ring)]",
        },
        duration: Infinity,
    });

export { countdownToast };
export type { CountdownToastAction, CountdownToastOptions, CountdownToastTone } from "./countdown-toast-card";
