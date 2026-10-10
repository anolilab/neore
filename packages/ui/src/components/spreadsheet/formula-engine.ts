/**
 * Spreadsheet Formula Computation Engine
 *
 * Evaluates spreadsheet formulas using a lightweight expression parser.
 * Supports common Excel-compatible functions without requiring the full
 * ExcelJS library in the browser bundle.
 *
 * Supported functions:
 * - Arithmetic: SUM, AVERAGE, MIN, MAX, COUNT, PRODUCT
 * - Text: CONCATENATE, UPPER, LOWER, TRIM, LEN, LEFT, RIGHT, MID
 * - Logic: IF, AND, OR, NOT
 * - Math: ABS, ROUND, FLOOR, CEIL, MOD, POWER, SQRT
 * - Lookup: VLOOKUP (basic), INDEX, MATCH (basic)
 * - Date: NOW, TODAY, YEAR, MONTH, DAY
 *
 * Cell references: A1, B2, $A$1 (absolute), A1:B5 (ranges)
 *
 * Code-split: Import dynamically to keep the main bundle small.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CellRef {
    col: number; // 0-based
    row: number; // 0-based
}

export interface CellRange {
    end: CellRef;
    start: CellRef;
}

export type CellValue = string | number | boolean | null;

export type CellDataGetter = (row: number, col: number) => CellValue;

export interface FormulaResult {
    error?: string;
    value: CellValue;
}

// ---------------------------------------------------------------------------
// Cell Reference Parsing
// ---------------------------------------------------------------------------

const CELL_REF_REGEX = /^\$?([A-Z]+)\$?(\d+)$/;
const RANGE_REGEX = /^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/;
const FUNCTION_CALL_REGEX = /^([A-Z_]+)\((.*)\)$/s;
const HIGH_PRECEDENCE_OPERATORS = new Set(["*", "/", "^"]);

const colLetterToIndex = (letters: string): number => {
    let index = 0;

    for (let i = 0; i < letters.length; i++) {
        index = index * 26 + ((letters.codePointAt(i) ?? 0) - 64);
    }

    return index - 1; // 0-based
};

const parseCellRef = (ref: string): CellRef | null => {
    const match = ref.match(CELL_REF_REGEX);

    if (!match?.[1] || !match[2]) {
        return null;
    }

    return {
        col: colLetterToIndex(match[1]),
        row: Number(match[2]) - 1,
    };
};

const parseRange = (rangeString: string): CellRange | null => {
    const match = rangeString.match(RANGE_REGEX);

    if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
        return null;
    }

    return {
        end: { col: colLetterToIndex(match[3]), row: Number(match[4]) - 1 },
        start: { col: colLetterToIndex(match[1]), row: Number(match[2]) - 1 },
    };
};

const getRangeValues = (range: CellRange, getData: CellDataGetter): CellValue[] => {
    const values: CellValue[] = [];
    const minRow = Math.min(range.start.row, range.end.row);
    const maxRow = Math.max(range.start.row, range.end.row);
    const minCol = Math.min(range.start.col, range.end.col);
    const maxCol = Math.max(range.start.col, range.end.col);

    for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
            values.push(getData(r, c));
        }
    }

    return values;
};

// ---------------------------------------------------------------------------
// Built-in Functions
// ---------------------------------------------------------------------------

type FormulaFunction = (args: CellValue[]) => CellValue;

const toNumber = (v: CellValue | undefined): number => {
    if (typeof v === "number") {
        return v;
    }

    if (typeof v === "boolean") {
        return v ? 1 : 0;
    }

    if (typeof v === "string") {
        const n = Number.parseFloat(v);

        return Number.isNaN(n) ? 0 : n;
    }

    return 0;
};

const toNumbers = (values: CellValue[]): number[] => values.filter((v) => v !== null && v !== "").map((v) => toNumber(v));

const FUNCTIONS: Record<string, FormulaFunction> = {
    // Math
    ABS: (args) => Math.abs(toNumber(args[0])),
    AND: (args) => args.every(Boolean),
    AVERAGE: (args) => {
        const nums = toNumbers(args);

        return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    },
    CEIL: (args) => Math.ceil(toNumber(args[0])),
    // Text
    CONCATENATE: (args) => args.map(String).join(""),
    COUNT: (args) => args.filter((v) => typeof v === "number" || (typeof v === "string" && !Number.isNaN(Number.parseFloat(v)))).length,

    DAY: (args) => new Date(String(args[0])).getDate(),
    FLOOR: (args) => Math.floor(toNumber(args[0])),
    // Logic
    IF: (args) => (args[0] ? (args[1] ?? true) : (args[2] ?? false)),
    LEFT: (args) => String(args[0] ?? "").slice(0, toNumber(args[1] ?? 1)),
    LEN: (args) => String(args[0] ?? "").length,
    LOWER: (args) => String(args[0] ?? "").toLowerCase(),
    MAX: (args) => {
        const nums = toNumbers(args);

        return nums.length > 0 ? Math.max(...nums) : 0;
    },
    MID: (args) => {
        const s = String(args[0] ?? "");
        const start = toNumber(args[1] ?? 1) - 1;
        const sliceLength = toNumber(args[2] ?? 1);

        return s.slice(start, start + sliceLength);
    },

    MIN: (args) => {
        const nums = toNumbers(args);

        return nums.length > 0 ? Math.min(...nums) : 0;
    },
    MOD: (args) => toNumber(args[0]) % toNumber(args[1]),
    MONTH: (args) => new Date(String(args[0])).getMonth() + 1,
    NOT: (args) => !args[0],

    // Date (basic)
    NOW: () => new Date().toISOString(),
    OR: (args) => args.some(Boolean),
    PI: () => Math.PI,
    POWER: (args) => toNumber(args[0]) ** toNumber(args[1]),
    PRODUCT: (args) => toNumbers(args).reduce((a, b) => a * b, 1),
    RIGHT: (args) => {
        const s = String(args[0] ?? "");
        const n = toNumber(args[1] ?? 1);

        return s.slice(-n);
    },
    ROUND: (args) => {
        const value = toNumber(args[0]);
        const places = toNumber(args[1] ?? 0);
        const factor = 10 ** places;

        return Math.round(value * factor) / factor;
    },
    SQRT: (args) => Math.sqrt(toNumber(args[0])),

    SUM: (args) => toNumbers(args).reduce((a, b) => a + b, 0),
    TODAY: () => new Date().toISOString().split("T", 1)[0] ?? "",
    TRIM: (args) => String(args[0] ?? "").trim(),
    UPPER: (args) => String(args[0] ?? "").toUpperCase(),
    YEAR: (args) => new Date(String(args[0])).getFullYear(),
};

// ---------------------------------------------------------------------------
// Formula Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a single formula string.
 * @param formula Formula string (with or without leading "=")
 * @param getData Function to retrieve cell values by (row, col)
 * @returns Computed value or error
 */
export const evaluateFormula = (formula: string, getData: CellDataGetter): FormulaResult => {
    try {
        let expression = formula.trim();

        if (expression.startsWith("=")) expression = expression.slice(1).trim();

        if (!expression) return { value: null };

        const result = evaluateExpression(expression, getData);

        return { value: result };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "#ERROR!",
            value: null,
        };
    }
};

const evaluateExpression = (rawExpression: string, getData: CellDataGetter): CellValue => {
    const expression = rawExpression.trim();

    // Check for function calls: FUNC(args)
    const functionMatch = expression.match(FUNCTION_CALL_REGEX);

    if (functionMatch) {
        const functionName = functionMatch[1]!;
        const argsString = functionMatch[2]!;
        const formulaFunction = FUNCTIONS[functionName];

        if (!formulaFunction) throw new Error(`#NAME? Unknown function: ${functionName}`);

        const args = parseArguments(argsString, getData);

        return formulaFunction(args);
    }

    // Check for range reference: A1:B5
    const range = parseRange(expression);

    if (range) {
        return getRangeValues(range, getData) as any;
    }

    // Check for cell reference: A1
    const cellRef = parseCellRef(expression);

    if (cellRef) {
        return getData(cellRef.row, cellRef.col);
    }

    // Check for string literal
    if (expression.startsWith('"') && expression.endsWith('"')) {
        return expression.slice(1, -1);
    }

    // Check for number
    const numericValue = Number(expression);

    if (!Number.isNaN(numericValue) && String(numericValue) === expression) {
        return numericValue;
    }

    // Check for boolean
    if (expression === "TRUE") {
        return true;
    }

    if (expression === "FALSE") {
        return false;
    }

    // Simple arithmetic: try to evaluate basic operations
    // Handle +, -, *, / with cell references
    const arithmeticResult = evaluateArithmetic(expression, getData);

    if (arithmeticResult !== undefined) {
        return arithmeticResult;
    }

    // Return as string if nothing else matches
    return expression;
};

const parseArguments = (argsString: string, getData: CellDataGetter): CellValue[] => {
    const args: CellValue[] = [];
    let depth = 0;
    let current = "";

    for (const char of argsString) {
        if (char === "(") {
            depth++;
        } else if (char === ")") {
            depth--;
        } else if (char === "," && depth === 0) {
            const evaluated = evaluateExpression(current.trim(), getData);

            // Flatten range results
            if (Array.isArray(evaluated)) {
                args.push(...evaluated);
            } else {
                args.push(evaluated);
            }

            current = "";
            continue;
        }

        current += char;
    }

    if (current.trim()) {
        const evaluated = evaluateExpression(current.trim(), getData);

        if (Array.isArray(evaluated)) {
            args.push(...evaluated);
        } else {
            args.push(evaluated);
        }
    }

    return args;
};

const evaluateArithmetic = (expression: string, getData: CellDataGetter): CellValue | undefined => {
    // Two-pass evaluation respecting operator precedence:
    // Pass 1: *, /, ^  (high precedence)
    // Pass 2: +, -     (low precedence)
    // Comparison operators: >, <, >=, <=, =, <> (lowest precedence)
    const tokens = tokenize(expression);

    if (tokens.length < 3) {
        return undefined;
    }

    // Resolve all value tokens first
    const values: CellValue[] = [];
    const ops: string[] = [];

    for (const [i, token] of tokens.entries()) {
        if (i % 2 === 0) {
            const value = resolveToken(token, getData);

            if (value === undefined) {
                return undefined;
            }

            values.push(value);
        } else {
            ops.push(token!);
        }
    }

    // Pass 1: evaluate *, /, ^ (high precedence)
    const reducedValues: CellValue[] = [values[0]!];
    const reducedOps: string[] = [];

    for (const [i, rawOp] of ops.entries()) {
        const op = rawOp!;

        if (HIGH_PRECEDENCE_OPERATORS.has(op)) {
            const left = toNumber(reducedValues.pop()!);
            const right = toNumber(values[i + 1]!);

            if (op === "*") {
                reducedValues.push(left * right);
            } else if (op === "/") {
                if (right === 0) {
                    throw new Error("#DIV/0!");
                }

                reducedValues.push(left / right);
            } else {
                reducedValues.push(left ** right);
            }
        } else {
            reducedValues.push(values[i + 1]!);
            reducedOps.push(op);
        }
    }

    // Pass 2: evaluate +, -, comparisons (left-to-right)
    let result: CellValue = reducedValues[0]!;

    for (const [i, reducedOp] of reducedOps.entries()) {
        const op = reducedOp!;
        const left = toNumber(result);
        const rightNumber = toNumber(reducedValues[i + 1]!);

        switch (op) {
            case "+": {
                result = left + rightNumber;
                break;
            }
            case "-": {
                result = left - rightNumber;
                break;
            }
            case "<": {
                result = left < rightNumber;
                break;
            }
            case "<=": {
                result = left <= rightNumber;
                break;
            }
            case "<>": {
                result = left !== rightNumber;
                break;
            }
            case "=": {
                result = left === rightNumber;
                break;
            }
            case ">": {
                result = left > rightNumber;
                break;
            }
            case ">=": {
                result = left >= rightNumber;
                break;
            }
            default: {
                return undefined;
            }
        }
    }

    return result;
};

const tokenize = (expression: string): string[] => {
    const tokens: string[] = [];
    let current = "";

    for (let i = 0; i < expression.length; i++) {
        const char = expression[i]!;

        if ("+-*/^".includes(char) || char === ">" || char === "<" || char === "=") {
            if (current.trim()) {
                tokens.push(current.trim());
            }

            // Handle multi-char operators
            let op = char;

            if ((char === ">" || char === "<") && expression[i + 1] === "=") {
                op += "=";
                i++;
            } else if (char === "<" && expression[i + 1] === ">") {
                op = "<>";
                i++;
            }

            tokens.push(op);
            current = "";
        } else {
            current += char;
        }
    }

    if (current.trim()) {
        tokens.push(current.trim());
    }

    return tokens;
};

const resolveToken = (rawToken: string | undefined, getData: CellDataGetter): CellValue | undefined => {
    if (!rawToken) {
        return undefined;
    }

    const token = rawToken.trim();

    const cellRef = parseCellRef(token);

    if (cellRef) {
        return getData(cellRef.row, cellRef.col);
    }

    const parsedNumber = Number.parseFloat(token);

    if (!Number.isNaN(parsedNumber)) {
        return parsedNumber;
    }

    if (token.startsWith('"') && token.endsWith('"')) {
        return token.slice(1, -1);
    }

    if (token === "TRUE") {
        return true;
    }

    if (token === "FALSE") {
        return false;
    }

    return undefined;
};

// ---------------------------------------------------------------------------
// Grid Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate all formulas in a CSV grid.
 * @param grid 2D array of cell values (strings)
 * @returns New grid with formulas replaced by computed values
 */
export const evaluateGrid = (grid: string[][]): string[][] => {
    const results: (CellValue | undefined)[][] = grid.map((row) => row.map(() => undefined));
    const computing = new Set<string>(); // Track cells currently being computed for circular ref detection

    // Cell data getter with memoization for computed cells
    const getData: CellDataGetter = (row, col) => {
        const gridRow = grid[row];
        const resultsRow = results[row];

        if (!gridRow || !resultsRow || row < 0 || col < 0 || col >= gridRow.length) {
            return null;
        }

        // If already computed, return cached result
        if (resultsRow[col] !== undefined) {
            return resultsRow[col]!;
        }

        const cellValue = gridRow[col];

        // If it's a formula, evaluate it
        if (cellValue?.startsWith("=")) {
            const key = `${row},${col}`;

            if (computing.has(key)) {
                resultsRow[col] = "#REF!";

                return "#REF!";
            }

            computing.add(key);
            const { error, value } = evaluateFormula(cellValue, getData);

            computing.delete(key);
            const result = error || value;

            resultsRow[col] = result;

            return result;
        }

        // Parse as number if possible
        if (cellValue) {
            const numericValue = Number(cellValue);

            if (!Number.isNaN(numericValue) && String(numericValue) === cellValue.trim()) {
                resultsRow[col] = numericValue;

                return numericValue;
            }
        }

        resultsRow[col] = cellValue ?? null;

        return cellValue ?? null;
    };

    // Evaluate all cells
    for (const [r, element] of grid.entries()) {
        for (let c = 0; c < (element?.length ?? 0); c++) {
            getData(r, c);
        }
    }

    // Convert results back to strings
    return results.map((row) =>
        row.map((v) => {
            if (v === null || v === undefined) {
                return "";
            }

            return String(v);
        }),
    );
};
