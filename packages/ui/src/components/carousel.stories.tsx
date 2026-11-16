import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";

import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious } from "./carousel";

const slides = ["First", "Second", "Third", "Fourth"];

const meta: Meta<typeof Carousel> = {
    args: { "aria-label": "Highlights" },
    component: Carousel,
    decorators: [
        (Story) => (
            <div className="mx-auto w-64 px-12 py-12">
                <Story />
            </div>
        ),
    ],
    render: (args) => (
        <Carousel {...args}>
            <CarouselContent>
                {slides.map((slide) => (
                    <CarouselItem key={slide}>
                        <div className="bg-muted flex aspect-square items-center justify-center rounded-md text-lg font-medium">{slide}</div>
                    </CarouselItem>
                ))}
            </CarouselContent>
            <CarouselPrevious />
            <CarouselNext />
        </Carousel>
    ),
    title: "UI/Carousel",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Previous slide" })).toBeDisabled();
        await expect(canvas.getByRole("button", { name: "Next slide" })).toBeEnabled();
    },
};

export const NextSlide: Story = {
    play: async ({ canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Next slide" }));
        await expect(await canvas.findByRole("button", { name: "Previous slide" })).toBeEnabled();
    },
};

export const KeyboardNavigation: Story = {
    play: async ({ canvas }) => {
        canvas.getByRole("button", { name: "Next slide" }).focus();
        await userEvent.keyboard("{ArrowRight}");
        await expect(await canvas.findByRole("button", { name: "Previous slide" })).toBeEnabled();
    },
};

export const Looping: Story = {
    args: { opts: { loop: true } },
};

export const Vertical: Story = {
    args: { orientation: "vertical" },
    render: (args) => (
        <Carousel {...args}>
            <CarouselContent className="h-48">
                {slides.map((slide) => (
                    <CarouselItem key={slide}>
                        <div className="bg-muted flex h-full items-center justify-center rounded-md text-lg font-medium">{slide}</div>
                    </CarouselItem>
                ))}
            </CarouselContent>
            <CarouselPrevious />
            <CarouselNext />
        </Carousel>
    ),
};
