/** `10/19/26, 5:32 PM` in the reader's locale; `timeZone` is for tests, the default is the browser's. */
const formatMessageTime = (createdAt: number, locale: string, timeZone?: string): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short", timeZone }).format(createdAt);

export default formatMessageTime;
