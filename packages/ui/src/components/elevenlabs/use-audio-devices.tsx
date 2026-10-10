"use client";

import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";

import type { AudioDevice } from "./mic-selector";

const useAudioDevices = () => {
    const { t } = useLingui();
    const [devices, setDevices] = useState<AudioDevice[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [hasPermission, setHasPermission] = useState(false);

    const loadDevicesWithoutPermission = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);

            const deviceList = await navigator.mediaDevices.enumerateDevices();

            const audioInputs = deviceList
                .filter((device) => device.kind === "audioinput")
                .map((device) => {
                    const shortId = device.deviceId.slice(0, 8);
                    let cleanLabel = device.label || t`Microphone ${shortId}`;

                    // Drop the parenthesised hardware id, then collapse the whitespace it
                    // leaves behind. Two passes rather than one `\s*\(…\)`, whose
                    // leading `\s*` backtracks across every run of spaces in the label.
                    cleanLabel = cleanLabel
                        .replaceAll(/\([^()]*\)/g, "")
                        .replaceAll(/\s{2,}/g, " ")
                        .trim();

                    return {
                        deviceId: device.deviceId,
                        groupId: device.groupId,
                        label: cleanLabel,
                    };
                });

            setDevices(audioInputs);
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : t`Failed to get audio devices`);
            console.error("Error getting audio devices:", error_);
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

            tempStream.getTracks().forEach((track) => track.stop());

            const deviceList = await navigator.mediaDevices.enumerateDevices();

            const audioInputs = deviceList
                .filter((device) => device.kind === "audioinput")
                .map((device) => {
                    const shortId = device.deviceId.slice(0, 8);
                    let cleanLabel = device.label || t`Microphone ${shortId}`;

                    // Drop the parenthesised hardware id, then collapse the whitespace it
                    // leaves behind. Two passes rather than one `\s*\(…\)`, whose
                    // leading `\s*` backtracks across every run of spaces in the label.
                    cleanLabel = cleanLabel
                        .replaceAll(/\([^()]*\)/g, "")
                        .replaceAll(/\s{2,}/g, " ")
                        .trim();

                    return {
                        deviceId: device.deviceId,
                        groupId: device.groupId,
                        label: cleanLabel,
                    };
                });

            setDevices(audioInputs);
            setHasPermission(true);
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : t`Failed to get audio devices`);
            console.error("Error getting audio devices:", error_);
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
