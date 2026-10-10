import { cva } from "class-variance-authority";

const navigationMenuTriggerStyle = cva(
    "bg-background hover:bg-muted focus:bg-muted data-open:hover:bg-muted data-open:focus:bg-muted focus-visible:ring-ring/30 data-popup-open:bg-muted/50 data-popup-open:hover:bg-muted rounded-md px-2.5 py-1.5 text-xs/relaxed font-medium transition-all focus-visible:ring-[2px] focus-visible:outline-1 disabled:opacity-50 group/navigation-menu-trigger inline-flex h-9 w-max items-center justify-center disabled:pointer-events-none outline-none",
);

export { navigationMenuTriggerStyle };
