"use client";

import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";

const useAudioDevices = () => {
    const { t } = useLingui();
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [hasPermission, setHasPermission] = useState(false);

    const loadDevicesWithoutPermission = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);

            const deviceList = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = deviceList.filter((device) => device.kind === "audioinput");

            setDevices(audioInputs);
        } catch (error_) {
            const message = error_ instanceof Error ? error_.message : t`Failed to get audio devices`;

            setError(message);
            console.error("Error getting audio devices:", message);
        } finally {
            setLoading(false);
        }
    }, [t]);

    const loadDevicesWithPermission = useCallback(async () => {
        if (loading) {
            return;
        }

        try {
            setLoading(true);
            setError(null);

            const tempStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
            });

            for (const track of tempStream.getTracks()) {
                track.stop();
            }

            const deviceList = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = deviceList.filter((device) => device.kind === "audioinput");

            setDevices(audioInputs);
            setHasPermission(true);
        } catch (error_) {
            const message = error_ instanceof Error ? error_.message : t`Failed to get audio devices`;

            setError(message);
            console.error("Error getting audio devices:", message);
        } finally {
            setLoading(false);
        }
    }, [loading, t]);

    useEffect(() => {
        loadDevicesWithoutPermission();
    }, [loadDevicesWithoutPermission]);

    useEffect(() => {
        const handleDeviceChange = () => {
            if (hasPermission) {
                loadDevicesWithPermission();
            } else {
                loadDevicesWithoutPermission();
            }
        };

        navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

        return () => {
            navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
        };
    }, [hasPermission, loadDevicesWithPermission, loadDevicesWithoutPermission]);

    return {
        devices,
        error,
        hasPermission,
        loadDevices: loadDevicesWithPermission,
        loading,
    };
};

export { useAudioDevices };
