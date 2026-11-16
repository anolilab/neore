import type { Meta, StoryObj } from "@storybook/react-vite";

import { Checkbox } from "./checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet, FieldTitle } from "./field";
import { Input } from "./input";
import { RadioGroup, RadioGroupItem } from "./radio-group";

const meta = {
    component: Field,
    decorators: [
        (Story) => (
            <div className="w-96">
                <Story />
            </div>
        ),
    ],
    title: "UI/Field",
} satisfies Meta<typeof Field>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: (args) => (
        <Field {...args}>
            <FieldLabel htmlFor="story-field-name">Name</FieldLabel>
            <Input id="story-field-name" placeholder="Ada Lovelace" />
            <FieldDescription>Shown on your profile.</FieldDescription>
        </Field>
    ),
};

export const WithError: Story = {
    render: (args) => (
        <Field data-invalid="true" {...args}>
            <FieldLabel htmlFor="story-field-email">Email</FieldLabel>
            <Input aria-invalid="true" defaultValue="not-an-email" id="story-field-email" />
            <FieldError errors={[{ message: "Enter a valid email address." }]} />
        </Field>
    ),
};

export const Horizontal: Story = {
    args: { orientation: "horizontal" },
    render: (args) => (
        <Field {...args}>
            <Checkbox id="story-field-news" />
            <FieldContent>
                <FieldLabel htmlFor="story-field-news">Product news</FieldLabel>
                <FieldDescription>Occasional emails about new features.</FieldDescription>
            </FieldContent>
        </Field>
    ),
};

export const GroupWithSeparator: Story = {
    render: () => (
        <FieldGroup>
            <Field>
                <FieldLabel htmlFor="story-group-email">Email</FieldLabel>
                <Input id="story-group-email" type="email" />
            </Field>
            <FieldSeparator>or</FieldSeparator>
            <Field>
                <FieldLabel htmlFor="story-group-token">Access token</FieldLabel>
                <Input id="story-group-token" />
            </Field>
        </FieldGroup>
    ),
};

export const FieldSetWithRadios: Story = {
    render: () => (
        <FieldSet>
            <FieldLegend>Plan</FieldLegend>
            <FieldDescription>Pick how you want to be billed.</FieldDescription>
            <RadioGroup aria-label="Plan" defaultValue="monthly">
                <Field orientation="horizontal">
                    <RadioGroupItem id="story-plan-monthly" value="monthly" />
                    <FieldLabel htmlFor="story-plan-monthly">Monthly</FieldLabel>
                </Field>
                <Field orientation="horizontal">
                    <RadioGroupItem id="story-plan-yearly" value="yearly" />
                    <FieldLabel htmlFor="story-plan-yearly">
                        <FieldTitle>Yearly</FieldTitle>
                    </FieldLabel>
                </Field>
            </RadioGroup>
        </FieldSet>
    ),
};
