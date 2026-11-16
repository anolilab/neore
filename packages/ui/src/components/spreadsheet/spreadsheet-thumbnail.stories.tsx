import type { Meta, StoryObj } from "@storybook/react-vite";

import SpreadsheetThumbnail from "./spreadsheet-thumbnail";

const CSV = `name,city,age,member
Ada,Berlin,31,true
Grace,Lisbon,27,false
Linus,Oslo,45,true
Margaret,Boston,52,true
Alan,London,41,false
Barbara,Seattle,38,true`;

const meta = {
    args: { className: "w-64", content: CSV },
    component: SpreadsheetThumbnail,
    title: "UI/Files/Spreadsheet thumbnail",
} satisfies Meta<typeof SpreadsheetThumbnail>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const QuotedFields: Story = {
    args: { content: 'title,note\n"Hello, world","She said ""hi"""\nplain,value' },
};

export const WideSheet: Story = {
    args: { content: "a,b,c,d,e,f,g\n1,2,3,4,5,6,7\n8,9,10,11,12,13,14" },
};

export const Empty: Story = {
    args: { content: "" },
};
