import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import {
    MicSelector,
    MicSelectorContent,
    MicSelectorEmpty,
    MicSelectorInput,
    MicSelectorItem,
    MicSelectorLabel,
    MicSelectorList,
    MicSelectorTrigger,
    MicSelectorValue,
} from "./mic-selector";

const device = (deviceId: string, label: string): MediaDeviceInfo => {
    return {
        deviceId,
        groupId: deviceId,
        kind: "audioinput",
        label,
        toJSON: () => {
            return {};
        },
    };
};

// Replaces the browser's device list so the story does not depend on the machine's hardware or a permission prompt.
const stubDevices = (devices: MediaDeviceInfo[]) => {
    const original = navigator.mediaDevices;
    const stub = {
        addEventListener: () => {},
        enumerateDevices: () => Promise.resolve(devices),
        getUserMedia: () => Promise.resolve(new MediaStream()),
        removeEventListener: () => {},
    };

    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: stub });

    return () => Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: original });
};

const DEVICES = [device("built-in", "MacBook Pro Microphone (05ac:8104)"), device("usb", "USB Headset")];

const Picker = ({ defaultOpen = false, defaultValue }: { defaultOpen?: boolean; defaultValue?: string }) => (
    <MicSelector defaultOpen={defaultOpen} defaultValue={defaultValue} onValueChange={fn()}>
        <MicSelectorTrigger className="w-64">
            <MicSelectorValue />
        </MicSelectorTrigger>
        <MicSelectorContent>
            <MicSelectorInput />
            <MicSelectorList>
                {(devices) =>
                    devices.length === 0 ? (
                        <MicSelectorEmpty />
                    ) : (
                        devices.map((item) => (
                            <MicSelectorItem key={item.deviceId} value={item.deviceId}>
                                <MicSelectorLabel device={item} />
                            </MicSelectorItem>
                        ))
                    )
                }
            </MicSelectorList>
        </MicSelectorContent>
    </MicSelector>
);

const meta: Meta<typeof MicSelector> = {
    component: MicSelector,
    decorators: [
        (Story) => (
            <div className="h-72 w-72">
                <Story />
            </div>
        ),
    ],
    title: "Chat/MicSelector",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Closed: Story = {
    beforeEach: () => stubDevices(DEVICES),
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: /microphone/i })).toBeVisible();
    },
    render: () => <Picker />,
};

export const Open: Story = {
    beforeEach: () => stubDevices(DEVICES),
    play: async ({ canvasElement }) => {
        const { body } = canvasElement.ownerDocument;

        await expect(await within(body).findByText("USB Headset")).toBeVisible();
    },
    render: () => <Picker defaultOpen />,
};

export const Selected: Story = {
    beforeEach: () => stubDevices(DEVICES),
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("USB Headset")).toBeVisible();
    },
    render: () => <Picker defaultValue="usb" />,
};

export const NoMicrophone: Story = {
    beforeEach: () => stubDevices([]),
    play: async ({ canvasElement }) => {
        await expect(await within(canvasElement.ownerDocument.body).findByPlaceholderText("Search microphones...")).toBeInTheDocument();
    },
    render: () => <Picker defaultOpen />,
};

export const ChoosesDevice: Story = {
    beforeEach: () => stubDevices(DEVICES),
    play: async ({ canvas, canvasElement }) => {
        await userEvent.click(canvas.getByRole("button", { name: /microphone/i }));
        await userEvent.click(await within(canvasElement.ownerDocument.body).findByText("USB Headset"));
    },
    render: () => <Picker />,
};
