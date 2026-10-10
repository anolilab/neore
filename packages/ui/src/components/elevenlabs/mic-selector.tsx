"use client";

import { useLingui } from "@lingui/react/macro";
import { Check, ChevronsUpDown, Mic, MicOff } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../components/dropdown-menu";
import cn from "../../utils/cn";
import LiveWaveform from "./live-waveform";
import { useAudioDevices } from "./use-audio-devices";

export interface AudioDevice {
    deviceId: string;
    groupId: string;
    label: string;
}

export interface MicSelectorProps {
    className?: string;
    disabled?: boolean;
    muted?: boolean;
    onMutedChange?: (muted: boolean) => void;
    onValueChange?: (deviceId: string) => void;
    value?: string;
}

export const MicSelector = ({ className, disabled, muted, onMutedChange, onValueChange, value }: MicSelectorProps) => {
    const { t } = useLingui();
    const { devices, error, hasPermission, loadDevices, loading } = useAudioDevices();
    const [selectedDevice, setSelectedDevice] = useState<string>(value || "");
    const [internalMuted, setInternalMuted] = useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);

    // Use controlled muted if provided, otherwise use internal state
    const isMuted = muted === undefined ? internalMuted : muted;

    // Update internal state when controlled value changes
    useEffect(() => {
        if (value !== undefined) {
            setSelectedDevice(value);
        }
    }, [value]);

    // Select first device by default
    const defaultDeviceId = devices[0]?.deviceId || "";

    useEffect(() => {
        if (selectedDevice || !defaultDeviceId) {
            return;
        }

        const newDevice = defaultDeviceId;

        setSelectedDevice(newDevice);
        onValueChange?.(newDevice);
    }, [defaultDeviceId, selectedDevice, onValueChange]);

    const currentDevice = devices.find((d) => d.deviceId === selectedDevice) ||
        devices[0] || {
            deviceId: "",
            label: loading ? t`Loading...` : t`No microphone`,
        };

    const handleDeviceSelect = (deviceId: string, e?: React.MouseEvent) => {
        e?.preventDefault();
        setSelectedDevice(deviceId);
        onValueChange?.(deviceId);
    };

    const handleDropdownOpenChange = async (open: boolean) => {
        setIsDropdownOpen(open);

        if (open && !hasPermission && !loading) {
            await loadDevices();
        }
    };

    const toggleMute = () => {
        const newMuted = !isMuted;

        if (muted === undefined) {
            setInternalMuted(newMuted);
        }

        onMutedChange?.(newMuted);
    };

    const isPreviewActive = isDropdownOpen && !isMuted;

    const deviceItems = error ? (
        <DropdownMenuItem disabled>{t`Error: ${error}`}</DropdownMenuItem>
    ) : (
        devices.map((device) => (
            <DropdownMenuItem
                className="flex items-center justify-between"
                key={device.deviceId}
                onClick={(e) => handleDeviceSelect(device.deviceId, e)}
                onSelect={(e) => e.preventDefault()}
            >
                <span className="truncate">{device.label}</span>
                {selectedDevice === device.deviceId && <Check className="h-4 w-4 flex-shrink-0" />}
            </DropdownMenuItem>
        ))
    );

    return (
        <DropdownMenu onOpenChange={handleDropdownOpenChange}>
            <DropdownMenuTrigger
                render={
                    <Button
                        className={cn("hover:bg-accent flex w-48 cursor-pointer items-center gap-1.5", className)}
                        disabled={loading || disabled}
                        size="sm"
                        variant="ghost"
                    >
                        {isMuted ? <MicOff className="h-4 w-4 flex-shrink-0" /> : <Mic className="h-4 w-4 flex-shrink-0" />}
                        <span className="flex-1 truncate text-left">{currentDevice.label}</span>
                        <ChevronsUpDown className="h-3 w-3 flex-shrink-0" />
                    </Button>
                }
            />
            <DropdownMenuContent align="center" className="w-72" side="top">
                {loading ? <DropdownMenuItem disabled>{t`Loading devices...`}</DropdownMenuItem> : deviceItems}
                {devices.length > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <div className="flex items-center gap-2 p-2">
                            <Button
                                className="h-8 gap-2"
                                onClick={(e) => {
                                    e.preventDefault();
                                    toggleMute();
                                }}
                                size="sm"
                                variant="ghost"
                            >
                                {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                                <span className="text-sm">{isMuted ? t`Unmute` : t`Mute`}</span>
                            </Button>
                            <div className="bg-accent ml-auto w-16 overflow-hidden rounded-md p-1.5">
                                <LiveWaveform
                                    active={isPreviewActive}
                                    barGap={1}
                                    barWidth={3}
                                    deviceId={selectedDevice || defaultDeviceId}
                                    height={15}
                                    mode="static"
                                />
                            </div>
                        </div>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
