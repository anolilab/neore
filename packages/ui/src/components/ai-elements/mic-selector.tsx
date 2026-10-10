"use client";

import { useLingui } from "@lingui/react/macro";
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Button } from "@ui/components/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/popover";
import cn from "@ui/utils/cn";
import { ChevronsUpDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, use, useEffect, useMemo, useRef, useState } from "react";

import { useAudioDevices } from "./use-audio-devices";

const deviceIdRegex = /\(([\da-f]{4}:[\da-f]{4})\)$/i;

interface MicSelectorContextType {
    data: MediaDeviceInfo[];
    onOpenChange?: (open: boolean) => void;
    onValueChange?: (value: string) => void;
    open: boolean;
    setWidth?: (width: number) => void;
    value: string | undefined;
    width: number;
}

const MicSelectorContext = createContext<MicSelectorContextType>({
    data: [],
    onOpenChange: undefined,
    onValueChange: undefined,
    open: false,
    setWidth: undefined,
    value: undefined,
    width: 200,
});

export type MicSelectorProps = ComponentProps<typeof Popover> & {
    defaultValue?: string;
    onOpenChange?: (open: boolean) => void;
    onValueChange?: (value: string | undefined) => void;
    open?: boolean;
    value?: string;
};

export const MicSelector = ({
    defaultOpen = false,
    defaultValue,
    onOpenChange: controlledOnOpenChange,
    onValueChange: controlledOnValueChange,
    open: controlledOpen,
    value: controlledValue,
    ...props
}: MicSelectorProps) => {
    const [value, onValueChange] = useControllableState<string | undefined>({
        defaultProp: defaultValue,
        onChange: controlledOnValueChange,
        prop: controlledValue,
    });
    const [open, onOpenChange] = useControllableState({
        defaultProp: defaultOpen,
        onChange: controlledOnOpenChange,
        prop: controlledOpen,
    });
    const [width, setWidth] = useState(200);
    const { devices, hasPermission, loadDevices, loading } = useAudioDevices();

    useEffect(() => {
        if (open && !hasPermission && !loading) {
            loadDevices();
        }
    }, [open, hasPermission, loading, loadDevices]);

    const contextValue = useMemo<MicSelectorContextType>(() => {
        return {
            data: devices,
            onOpenChange,
            onValueChange,
            open,
            setWidth,
            value,
            width,
        };
    }, [devices, onOpenChange, onValueChange, open, setWidth, value, width]);

    return (
        <MicSelectorContext value={contextValue}>
            <Popover {...props} onOpenChange={onOpenChange} open={open} />
        </MicSelectorContext>
    );
};

export type MicSelectorTriggerProps = ComponentProps<typeof Button>;

export const MicSelectorTrigger = ({ children, ...props }: MicSelectorTriggerProps) => {
    const { setWidth } = use(MicSelectorContext);
    const ref = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        // Create a ResizeObserver to detect width changes
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const newWidth = (entry.target as HTMLElement).offsetWidth;

                if (newWidth) {
                    setWidth?.(newWidth);
                }
            }
        });

        if (ref.current) {
            resizeObserver.observe(ref.current);
        }

        // Clean up the observer when component unmounts
        return () => {
            resizeObserver.disconnect();
        };
    }, [setWidth]);

    return (
        <PopoverTrigger render={<Button variant="outline" {...props} ref={ref} />}>
            {children}
            <ChevronsUpDownIcon className="text-muted-foreground shrink-0" size={16} />
        </PopoverTrigger>
    );
};

export type MicSelectorContentProps = {
    /** Forwarded to the popover, not to `Command` — `Autocomplete.Root` renders no element. */
    className?: string;
    popoverOptions?: ComponentProps<typeof PopoverContent>;
} & ComponentProps<typeof Command>;

export const MicSelectorContent = ({ className, popoverOptions, ...props }: MicSelectorContentProps) => {
    const { onValueChange, value, width } = use(MicSelectorContext);

    return (
        <PopoverContent className={cn("p-0", className)} style={{ width }} {...popoverOptions}>
            <Command onValueChange={onValueChange} value={value} {...props} />
        </PopoverContent>
    );
};

export type MicSelectorInputProps = ComponentProps<typeof CommandInput> & {
    defaultValue?: string;
    onValueChange?: (value: string) => void;
    value?: string;
};

export const MicSelectorInput = ({ ...props }: MicSelectorInputProps) => {
    const { t } = useLingui();

    return <CommandInput placeholder={t`Search microphones...`} {...props} />;
};

export type MicSelectorListProps = Omit<ComponentProps<typeof CommandList>, "children"> & {
    children: (devices: MediaDeviceInfo[]) => ReactNode;
};

export const MicSelectorList = ({ children, ...props }: MicSelectorListProps) => {
    const { data } = use(MicSelectorContext);

    return <CommandList {...props}>{children(data)}</CommandList>;
};

export type MicSelectorEmptyProps = ComponentProps<typeof CommandEmpty>;

export const MicSelectorEmpty = ({ children, ...props }: MicSelectorEmptyProps) => {
    const { t } = useLingui();

    return <CommandEmpty {...props}>{children ?? t`No microphone found.`}</CommandEmpty>;
};

export type MicSelectorItemProps = ComponentProps<typeof CommandItem>;

export const MicSelectorItem = (props: MicSelectorItemProps) => {
    const { onOpenChange, onValueChange } = use(MicSelectorContext);
    const { value } = props;

    return (
        <CommandItem
            onSelect={() => {
                if (typeof value === "string") {
                    onValueChange?.(value);
                }

                onOpenChange?.(false);
            }}
            {...props}
        />
    );
};

export type MicSelectorLabelProps = ComponentProps<"span"> & {
    device: MediaDeviceInfo;
};

export const MicSelectorLabel = ({ className, device, ...props }: MicSelectorLabelProps) => {
    const matches = device.label.match(deviceIdRegex);

    console.log(matches, device.label);

    if (!matches) {
        return (
            <span className={className} {...props}>
                {device.label}
            </span>
        );
    }

    const [, deviceId] = matches;
    const name = device.label.replace(deviceIdRegex, "");

    return (
        <span className={className} {...props}>
            <span>{name}</span>
            <span className="text-muted-foreground"> ({deviceId})</span>
        </span>
    );
};

export type MicSelectorValueProps = ComponentProps<"span">;

export const MicSelectorValue = ({ className, ...props }: MicSelectorValueProps) => {
    const { t } = useLingui();
    const { data, value } = use(MicSelectorContext);
    const currentDevice = data.find((d) => d.deviceId === value);

    if (!currentDevice) {
        return (
            <span className={cn("flex-1 text-left", className)} {...props}>
                {t`Select microphone...`}
            </span>
        );
    }

    return <MicSelectorLabel className={cn("flex-1 text-left", className)} device={currentDevice} {...props} />;
};
