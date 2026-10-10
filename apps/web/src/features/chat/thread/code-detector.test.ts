import { describe, expect, it } from "vitest";

import { detectCode, languageToExtension } from "./code-detector";

describe("detectCode", () => {
    describe("should detect code", () => {
        it("should detect JavaScript code", () => {
            const code = `
const express = require('express');
const app = express();

app.get('/', (req, res) => {
    res.send('Hello World');
});

app.listen(3000);
`;
            const result = detectCode(code);

            expect(result.isCode).toBe(true);
            expect(result.language).toBe("javascript");
        });

        it("should detect Python code", () => {
            const code = `
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

for i in range(10):
    print(fibonacci(i))
`;
            const result = detectCode(code);

            expect(result.isCode).toBe(true);
            expect(result.language).toBe("python");
        });

        it("should detect TypeScript code", () => {
            const code = `
interface User {
    id: string;
    name: string;
    email: string;
}

type ReadonlyUser = Readonly<User>;

@Controller('/users')
class UserController {
    findAll(): User[] {
        return [];
    }
}
`;
            const result = detectCode(code);

            expect(result.isCode).toBe(true);
            expect(result.language).toBe("typescript");
        });

        it("should detect SQL code", () => {
            const code = `
SELECT u.name, u.email, COUNT(o.id) as order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
WHERE u.active = true
GROUP BY u.name, u.email
HAVING COUNT(o.id) > 5;
`;
            const result = detectCode(code);

            expect(result.isCode).toBe(true);
            expect(result.language).toBe("sql");
        });

        it("should detect Rust code", () => {
            const code = `
fn main() {
    let mut vec = Vec::new();
    vec.push(1);
    vec.push(2);

    for item in &vec {
        println!("{}", item);
    }
}
`;
            const result = detectCode(code);

            expect(result.isCode).toBe(true);
            expect(result.language).toBe("rust");
        });

        it("should detect Go code", () => {
            const code = `
package main

func main() {
    result := add(1, 2)
    fmt.Println(result)
}

func add(a, b int) int {
    return a + b
}
`;
            const result = detectCode(code);

            expect(result.isCode).toBe(true);
            expect(result.language).toBe("go");
        });

        it("should detect JSON", () => {
            const code = `
{
    "name": "my-app",
    "version": "1.0.0",
    "dependencies": {
        "express": "^4.0.0"
    }
}
`;
            const result = detectCode(code);

            expect(result.isCode).toBe(true);
            expect(result.language).toBe("json");
        });

        it("should detect shebang scripts", () => {
            const code = `#!/usr/bin/env python
import sys
print(sys.argv)
`;
            const result = detectCode(code);

            expect(result.isCode).toBe(true);
            expect(result.language).toBe("python");
        });

        it("should detect bash shebang", () => {
            const code = `#!/bin/bash
echo "hello"
if [ -f /tmp/test ]; then
    cat /tmp/test
fi
`;
            const result = detectCode(code);

            expect(result.isCode).toBe(true);
            expect(result.language).toBe("bash");
        });

        it("should detect node shebang", () => {
            const code = `#!/usr/bin/env node
console.log('hello');
`;
            const result = detectCode(code);

            expect(result.isCode).toBe(true);
            expect(result.language).toBe("javascript");
        });

        it("should detect C code with includes", () => {
            const code = String.raw`
#include <stdio.h>
#include <stdlib.h>

int main() {
    int x = 42;
    printf("Hello %d\n", x);
    return 0;
}
`;
            const result = detectCode(code);

            expect(result.isCode).toBe(true);
            expect(result.language).toBe("c");
        });

        it("should detect Dockerfile", () => {
            const code = `
FROM node:18-alpine
COPY package.json .
RUN npm install
EXPOSE 3000
CMD ["node", "server.js"]
`;
            const result = detectCode(code);

            expect(result.isCode).toBe(true);
            expect(result.language).toBe("dockerfile");
        });
    });

    describe("should not detect as code", () => {
        it.each([
            ["plain text", "Hello, this is just a regular message about my day."],
            ["single-line content", "const x = 5;"],
            ["markdown code blocks", "```javascript\nconst x = 5;\n```"],
        ])("should not detect %s", (_label, text) => {
            const result = detectCode(text);

            expect(result.isCode).toBe(false);
        });

        it("should not detect empty content", () => {
            const result = detectCode("");

            expect(result.isCode).toBe(false);
        });

        it("should not detect simple conversational text", () => {
            const text = `
Can you help me with my project?
I'm trying to build a web application.
It should have a login page and a dashboard.
`;
            const result = detectCode(text);

            expect(result.isCode).toBe(false);
        });
    });
});

describe("languageToExtension", () => {
    it("should map known languages to extensions", () => {
        expect(languageToExtension("javascript")).toBe("js");
        expect(languageToExtension("typescript")).toBe("ts");
        expect(languageToExtension("python")).toBe("py");
        expect(languageToExtension("rust")).toBe("rs");
        expect(languageToExtension("go")).toBe("go");
        expect(languageToExtension("java")).toBe("java");
        expect(languageToExtension("csharp")).toBe("cs");
        expect(languageToExtension("ruby")).toBe("rb");
        expect(languageToExtension("sql")).toBe("sql");
        expect(languageToExtension("html")).toBe("html");
        expect(languageToExtension("css")).toBe("css");
        expect(languageToExtension("json")).toBe("json");
        expect(languageToExtension("yaml")).toBe("yaml");
        expect(languageToExtension("bash")).toBe("sh");
        expect(languageToExtension("dockerfile")).toBe("dockerfile");
    });

    it("should return 'txt' for unknown languages", () => {
        expect(languageToExtension("unknown")).toBe("txt");
        expect(languageToExtension("")).toBe("txt");
    });
});
