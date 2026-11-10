/**
 * Class strings shared by the Sonner toast styles (`sonner.tsx`) and the countdown toast (`countdown-toast.tsx`),
 * so both look the same. Tone-specific classes stay with each component.
 */

const toastSurfaceClass = "rounded-lg border border-border bg-popover text-popover-foreground shadow-md";

const toastIconClass = "flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground";

const toastTitleClass = "text-sm leading-5 font-semibold text-popover-foreground";

const toastDescriptionClass = "text-sm leading-5 text-muted-foreground";

const toastCloseButtonClass =
    "absolute end-2 top-2 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-popover-foreground focus-visible:ring-2 focus-visible:ring-ring";

// 24px is the WCAG 2.5.8 minimum; touch screens get 44px, and the press shows as a dimmed button.
const toastTextButtonClass =
    "min-h-6 pointer-coarse:min-h-11 rounded-sm text-sm underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring active:opacity-70";

export { toastCloseButtonClass, toastDescriptionClass, toastIconClass, toastSurfaceClass, toastTextButtonClass, toastTitleClass };
