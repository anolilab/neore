import { createDocument } from "@mixmark-io/domino";

import { setHTMLParser } from "../src/html-parser";

// Node has no DOMParser, so every test file parses strings with domino.
setHTMLParser(createDocument);
