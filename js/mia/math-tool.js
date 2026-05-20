// One tool, one job: evaluate any arithmetic expression Mia gives it.
//
// The LLM is good at SETUP and EXPLANATION, bad at COMPUTATION.
// This is the missing primitive — a general-purpose calculator she
// can call as many times as she needs to work through ANY problem.
//
// We deliberately do NOT bake in domain-specific solvers ("break-even",
// "average-down", "compound interest", etc.). Mia knows the formulas;
// she just needs precise arithmetic. Closed-form per-pattern functions
// would be infinite (every market question shape needs its own one)
// and brittle (each function answers ONE framing of ONE question).
//
// Generality comes from:
//   1. Full operator precedence: + - * / ^ and parens
//   2. Named variables — Mia can store intermediate results and reuse
//      them across calls without re-typing. e.g.
//        compute({ expression: "974 / 8.80", as: "shares" })       → 110.68
//        compute({ expression: "shares * 8.80", as: "valueAtEntry" }) → 974
//        compute({ expression: "(8.80 - 7.96) / 7.96", as: "gainPerDollar" }) → 0.1055
//        compute({ expression: "1000 * gainPerDollar" }) → 105.53
//      The variable scope persists for the whole turn so the chain of
//      tool calls stays clean and verifiable.
//
// Safety: pure recursive-descent parser. No eval, no Function ctor,
// no string-to-code path. Tokens are limited to digits, the four
// arithmetic operators, exponent, parens, and identifiers (which
// resolve only against the in-memory variable map). Hard-fails on
// anything else.

// ----------------------------------------------------------------------
// Per-turn variable scope. Cleared at the start of each Mia turn so
// previous-turn variables don't leak across conversations.
// ----------------------------------------------------------------------

let scope = new Map();

export function resetMathScope() {
    scope = new Map();
}

// ----------------------------------------------------------------------
// Tokenizer
// ----------------------------------------------------------------------

function tokenize(expr) {
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
        const c = expr[i];
        if (/\s/.test(c)) { i++; continue; }
        if (/[0-9.]/.test(c)) {
            let n = '';
            while (i < expr.length && /[0-9.]/.test(expr[i])) { n += expr[i]; i++; }
            const num = parseFloat(n);
            if (!Number.isFinite(num)) throw new Error(`Invalid number: ${n}`);
            tokens.push({ type: 'num', value: num });
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            let id = '';
            while (i < expr.length && /[A-Za-z_0-9]/.test(expr[i])) { id += expr[i]; i++; }
            tokens.push({ type: 'id', value: id });
            continue;
        }
        if ('+-*/^()'.includes(c)) {
            tokens.push({ type: 'op', value: c });
            i++;
            continue;
        }
        throw new Error(`Unexpected character: ${c}`);
    }
    return tokens;
}

// ----------------------------------------------------------------------
// Recursive-descent parser
// expr  := term (('+'|'-') term)*
// term  := factor (('*'|'/') factor)*
// factor := unary ('^' factor)?
// unary := '-'? primary
// primary := num | id | '(' expr ')'
// ----------------------------------------------------------------------

function parse(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const eat = (val) => {
        const t = tokens[pos];
        if (!t || (val && t.value !== val)) throw new Error(`Expected ${val}, got ${t?.value}`);
        pos++;
        return t;
    };

    function expr() {
        let left = term();
        while (peek() && (peek().value === '+' || peek().value === '-')) {
            const op = eat().value;
            const right = term();
            left = op === '+' ? left + right : left - right;
        }
        return left;
    }
    function term() {
        let left = factor();
        while (peek() && (peek().value === '*' || peek().value === '/')) {
            const op = eat().value;
            const right = factor();
            if (op === '/' && right === 0) throw new Error('Division by zero');
            left = op === '*' ? left * right : left / right;
        }
        return left;
    }
    function factor() {
        let base = unary();
        if (peek() && peek().value === '^') {
            eat('^');
            const exp = factor();
            base = Math.pow(base, exp);
        }
        return base;
    }
    function unary() {
        if (peek() && peek().value === '-') { eat('-'); return -unary(); }
        return primary();
    }
    function primary() {
        const t = peek();
        if (!t) throw new Error('Unexpected end of expression');
        if (t.type === 'num') { pos++; return t.value; }
        if (t.type === 'id') {
            pos++;
            if (!scope.has(t.value)) {
                throw new Error(`Unknown variable: ${t.value}. Define it in an earlier compute call with the "as" parameter.`);
            }
            return scope.get(t.value);
        }
        if (t.value === '(') {
            eat('(');
            const v = expr();
            eat(')');
            return v;
        }
        throw new Error(`Unexpected token: ${t.value}`);
    }

    const result = expr();
    if (pos !== tokens.length) throw new Error('Unparsed input remaining');
    return result;
}

// ----------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------

export function compute({ expression, as }) {
    if (!expression || typeof expression !== 'string') {
        throw new Error('expression (string) required');
    }
    if (expression.length > 400) throw new Error('expression too long (max 400 chars)');
    const tokens = tokenize(expression);
    if (!tokens.length) throw new Error('empty expression');
    const result = parse(tokens);
    if (!Number.isFinite(result)) throw new Error('result is not a finite number');

    const rounded = Number(result.toFixed(6));
    const out = { expression, result: rounded };
    if (as && typeof as === 'string' && /^[A-Za-z_][A-Za-z_0-9]*$/.test(as)) {
        scope.set(as, rounded);
        out.storedAs = as;
    }
    return out;
}

// Hook called by mia.js at the start of each user turn so variables
// from previous turns don't leak into new conversations.
export { resetMathScope as _resetForNewTurn };
