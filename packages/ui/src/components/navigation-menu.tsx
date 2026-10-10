import { NavigationMenu as NavigationMenuPrimitive } from "@base-ui/react/navigation-menu";
import { navigationMenuTriggerStyle } from "@ui/components/navigation-menu-trigger-style";
import cn from "@ui/utils/cn";
import { ChevronDownIcon } from "lucide-react";

const NavigationMenu = ({ children, className, ...props }: NavigationMenuPrimitive.Root.Props) => (
    <NavigationMenuPrimitive.Root
        className={cn("group/navigation-menu relative flex max-w-max flex-1 items-center justify-center", className)}
        data-slot="navigation-menu"
        {...props}
    >
        {children}
        <NavigationMenuPositioner />
    </NavigationMenuPrimitive.Root>
);

const NavigationMenuList = ({ className, ...props }: NavigationMenuPrimitive.List.Props) => (
    <NavigationMenuPrimitive.List
        className={cn("group flex flex-1 list-none items-center justify-center gap-0", className)}
        data-slot="navigation-menu-list"
        {...props}
    />
);

const NavigationMenuItem = ({ className, ...props }: NavigationMenuPrimitive.Item.Props) => (
    <NavigationMenuPrimitive.Item className={cn("relative", className)} data-slot="navigation-menu-item" {...props} />
);

const NavigationMenuTrigger = ({ children, className, ...props }: NavigationMenuPrimitive.Trigger.Props) => (
    <NavigationMenuPrimitive.Trigger className={cn(navigationMenuTriggerStyle(), "group", className)} data-slot="navigation-menu-trigger" {...props}>
        {children}{" "}
        <ChevronDownIcon
            aria-hidden="true"
            className="relative top-[1px] ml-1 size-3 transition duration-300 group-data-open/navigation-menu-trigger:rotate-180 group-data-popup-open/navigation-menu-trigger:rotate-180"
        />
    </NavigationMenuPrimitive.Trigger>
);

const NavigationMenuContent = ({ className, ...props }: NavigationMenuPrimitive.Content.Props) => (
    <NavigationMenuPrimitive.Content
        className={cn(
            "data-[motion^=from-]:animate-in data-[motion^=to-]:animate-out data-[motion^=from-]:fade-in data-[motion^=to-]:fade-out data-[motion=from-end]:slide-in-from-right-52 data-[motion=from-start]:slide-in-from-left-52 data-[motion=to-end]:slide-out-to-right-52 data-[motion=to-start]:slide-out-to-left-52 group-data-[viewport=false]/navigation-menu:bg-popover group-data-[viewport=false]/navigation-menu:text-popover-foreground group-data-[viewport=false]/navigation-menu:data-open:animate-in group-data-[viewport=false]/navigation-menu:data-closed:animate-out group-data-[viewport=false]/navigation-menu:data-closed:zoom-out-95 group-data-[viewport=false]/navigation-menu:data-open:zoom-in-95 group-data-[viewport=false]/navigation-menu:data-open:fade-in-0 group-data-[viewport=false]/navigation-menu:data-closed:fade-out-0 group-data-[viewport=false]/navigation-menu:ring-foreground/10 h-full w-auto p-1.5 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[viewport=false]/navigation-menu:rounded-xl group-data-[viewport=false]/navigation-menu:shadow-md group-data-[viewport=false]/navigation-menu:ring-1 group-data-[viewport=false]/navigation-menu:duration-300 **:data-[slot=navigation-menu-link]:focus:ring-0 **:data-[slot=navigation-menu-link]:focus:outline-none",
            className,
        )}
        data-slot="navigation-menu-content"
        {...props}
    />
);

const NavigationMenuPositioner = ({
    align = "start",
    alignOffset = 0,
    className,
    side = "bottom",
    sideOffset = 8,
    ...props
}: NavigationMenuPrimitive.Positioner.Props) => (
    <NavigationMenuPrimitive.Portal>
        <NavigationMenuPrimitive.Positioner
            align={align}
            alignOffset={alignOffset}
            className={cn(
                "isolate z-50 h-[var(--positioner-height)] w-[var(--positioner-width)] max-w-[var(--available-width)] transition-[top,left,right,bottom] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] data-[instant]:transition-none data-[side=bottom]:before:top-[-10px] data-[side=bottom]:before:right-0 data-[side=bottom]:before:left-0",
                className,
            )}
            side={side}
            sideOffset={sideOffset}
            {...props}
        >
            <NavigationMenuPrimitive.Popup className="bg-popover text-popover-foreground ring-foreground/10 xs:w-(--popup-width) relative h-(--popup-height) w-(--popup-width) origin-(--transform-origin) rounded-xl shadow ring-1 transition-all ease-[cubic-bezier(0.22,1,0.36,1)] outline-none data-[ending-style]:scale-90 data-[ending-style]:opacity-0 data-[ending-style]:duration-150 data-[starting-style]:scale-90 data-[starting-style]:opacity-0">
                <NavigationMenuPrimitive.Viewport className="relative size-full overflow-hidden" />
            </NavigationMenuPrimitive.Popup>
        </NavigationMenuPrimitive.Positioner>
    </NavigationMenuPrimitive.Portal>
);

const NavigationMenuLink = ({ className, ...props }: NavigationMenuPrimitive.Link.Props) => (
    <NavigationMenuPrimitive.Link
        className={cn(
            "data-[active=true]:focus:bg-muted data-[active=true]:hover:bg-muted data-[active=true]:bg-muted/50 focus-visible:ring-ring/30 hover:bg-muted focus:bg-muted flex items-center gap-1.5 rounded-lg p-2 text-xs/relaxed transition-all outline-none focus-visible:ring-[2px] focus-visible:outline-1 [&_svg:not([class*='size-'])]:size-4",
            className,
        )}
        data-slot="navigation-menu-link"
        {...props}
    />
);

const NavigationMenuIndicator = ({ className, ...props }: NavigationMenuPrimitive.Icon.Props) => (
    <NavigationMenuPrimitive.Icon
        className={cn(
            "data-[state=visible]:animate-in data-[state=hidden]:animate-out data-[state=hidden]:fade-out data-[state=visible]:fade-in top-full z-[1] flex h-1.5 items-end justify-center overflow-hidden",
            className,
        )}
        data-slot="navigation-menu-indicator"
        {...props}
    >
        <div className="bg-border relative top-[60%] h-2 w-2 rotate-45 rounded-tl-sm shadow-md" />
    </NavigationMenuPrimitive.Icon>
);

export {
    NavigationMenu,
    NavigationMenuContent,
    NavigationMenuIndicator,
    NavigationMenuItem,
    NavigationMenuLink,
    NavigationMenuList,
    NavigationMenuPositioner,
    NavigationMenuTrigger,
};
