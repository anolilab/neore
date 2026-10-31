import { folderMatchesRepo } from "@neore/backend/source-control/guide-logic";

import { DEVICE_ONLINE_WINDOW_MS } from "@/features/devices/lib/device-relay";

export interface HostOffer {
    agentKey: string;
    agentLabel: string;
    deviceId: string;
    deviceName: string;
    folderId: string;
    folderLabel: string;
}

interface DeviceWithOffers {
    _id: string;
    acpOffers?: { agentKey: string; agentLabel: string; folderId: string; folderLabel: string }[];
    lastSeenAt?: number;
    name: string;
}

/**
 * The (agent, folder) pairs a paired computer that is online offers for this repository. The server checks the same
 * rules again when the guide is started; this only decides what the page offers.
 */
export const hostOffersFor = (devices: ReadonlyArray<DeviceWithOffers>, repo: string, now: number): HostOffer[] =>
    devices.flatMap((device) =>
        device.lastSeenAt !== undefined && now - device.lastSeenAt <= DEVICE_ONLINE_WINDOW_MS
            ? (device.acpOffers ?? [])
                  .filter((offer) => folderMatchesRepo(offer.folderLabel, repo))
                  .map((offer) => {
                      return { ...offer, deviceId: device._id, deviceName: device.name };
                  })
            : [],
    );

export const offerKey = (offer: Pick<HostOffer, "agentKey" | "deviceId" | "folderId">): string =>
    `${offer.deviceId}\u{0}${offer.agentKey}\u{0}${offer.folderId}`;

export interface LineRange {
    end: number;
    side: "new" | "old";
    start: number;
}

/** One line number for a single line, a span for several. The side is the caller to say. */
export const rangeText = (range: Pick<LineRange, "end" | "start">): string =>
    range.start === range.end ? String(range.start) : `${String(range.start)}–${String(range.end)}`;
