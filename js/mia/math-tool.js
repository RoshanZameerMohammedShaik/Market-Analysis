// Safe math evaluator for Mia. The LLM is good at setting up equations
// and bad at computing them; this gives her a calculator so she stops
// making arithmetic errors mid-derivation.
//
// Two operations:
//   1) compute({ expression })  — evaluate "974 / 8.80 + 100 * 7.96"
//      with full operator precedence. Returns the numeric result.
//   2) solve_break_even({ investment, buyPrice, currentPrice, target })
//      — purpose-built for the recurring pattern: how much MORE do I
//      need to invest at currentPrice so that when the price recovers
//      to `target`, the average cost per share equals `target`?
//      The math collapses analytically to:
//        if target == buyPrice: x = 0  (recovery alone breaks you even)
//        else: x = investment * (buyPrice - target) / (target - currentPrice)
//                  * (currentPrice / buyPrice)
//      Returns x along with shares bought, new average cost, etc.
//
// Both operations sanity-check inputs and return structured results
// so Mia can quote them verbatim without re-deriving.

// ----------------------------------------------------------------------
// Safe expression evaluator (recursive-descent, no eval).
// Supported: + - * / ^ ( ) and decimal numbers. No identifiers, no
// strings, no function calls. Hard-fails on anything else.
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
        if ('+-*/^()'.includes(c)) {
            tokens.push({ type: 'op', value: c });
            i++;
            continue;
        }
        throw new Error(`Unexpected character: ${c}`);
    }
    return tokens;
}

// Parser: expr := term (('+'|'-') term)*; term := factor (('*'|'/') factor)*;
// factor := unary ('^' factor)?; unary := '-'? primary; primary := num | '(' expr ')'
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
        if (t.value === '(') {
            eat('(');
            const v = expr();
            eat(')');
            return v;
        }
        throw new Error(`Unexpected token: ${t.value}`);
    }

    const result = expr();
    if (pos !== tokens.length) throw new Error(`Unparsed input remaining`);
    return result;
}

export function compute({ expression }) {
    if (!expression || typeof expression !== 'string') {
        throw new Error('expression (string) required');
    }
    if (expression.length > 200) throw new Error('expression too long (max 200 chars)');
    const tokens = tokenize(expression);
    if (!tokens.length) throw new Error('empty expression');
    const result = parse(tokens);
    if (!Number.isFinite(result)) throw new Error('result is not a finite number');
    return {
        expression,
        result: Number(result.toFixed(6)),
    };
}

// ----------------------------------------------------------------------
// solve_break_even — purpose-built for the recurring "how much more do
// I invest to break even" question. Computes analytically; no LLM math.
// ----------------------------------------------------------------------

export function solveBreakEven({ investment, buyPrice, currentPrice, target }) {
    const inv = Number(investment);
    const buy = Number(buyPrice);
    const cur = Number(currentPrice);
    const tgt = Number(target);
    if (!Number.isFinite(inv) || inv <= 0) throw new Error('investment must be positive');
    if (!Number.isFinite(buy) || buy <= 0) throw new Error('buyPrice must be positive');
    if (!Number.isFinite(cur) || cur <= 0) throw new Error('currentPrice must be positive');
    if (!Number.isFinite(tgt) || tgt <= 0) throw new Error('target must be positive');

    const originalShares = inv / buy;
    const currentValue = originalShares * cur;
    const unrealizedPL = currentValue - inv;

    // Algebraic identity: if target == buyPrice, the recovery alone
    // breaks you even. No additional investment needed.
    if (Math.abs(tgt - buy) < 0.0001 * buy) {
        return {
            additionalInvestment: 0,
            additionalShares: 0,
            originalShares: +originalShares.toFixed(4),
            currentValue: +currentValue.toFixed(2),
            unrealizedPL: +unrealizedPL.toFixed(2),
            newAverageCost: +buy.toFixed(4),
            note: 'Target equals entry price. The price recovery alone returns your portfolio to break-even — no additional investment needed.',
            trivial: true,
        };
    }

    // General solve: (inv + x) / (originalShares + x/cur) = tgt
    //  => inv + x = tgt * originalShares + tgt*x/cur
    //  => x * (1 - tgt/cur) = tgt*originalShares - inv
    //  => x = (tgt*originalShares - inv) / (1 - tgt/cur)
    const numerator = tgt * originalShares - inv;
    const denominator = 1 - tgt / cur;
    let additionalInvestment;
    if (Math.abs(denominator) < 1e-9) {
        additionalInvestment = 0;
    } else {
        additionalInvestment = numerator / denominator;
    }

    // Negative additionalInvestment means the target is above current and you'd
    // need to SELL to break even there — surface that as a note rather than a
    // negative invest amount.
    if (additionalInvestment < 0) {
        return {
            additionalInvestment: 0,
            originalShares: +originalShares.toFixed(4),
            currentValue: +currentValue.toFixed(2),
            unrealizedPL: +unrealizedPL.toFixed(2),
            note: 'No buy at the current price gets you to that break-even target — the target is higher than the current price, so additional buys would raise your average cost. Consider waiting for a recovery instead, or pick a target between currentPrice and buyPrice.',
            trivial: false,
            infeasible: true,
        };
    }

    const additionalShares = additionalInvestment / cur;
    const totalShares = originalShares + additionalShares;
    const totalInvested = inv + additionalInvestment;
    const newAverageCost = totalInvested / totalShares;

    return {
        additionalInvestment: +additionalInvestment.toFixed(2),
        additionalShares: +additionalShares.toFixed(4),
        originalShares: +originalShares.toFixed(4),
        totalShares: +totalShares.toFixed(4),
        totalInvested: +totalInvested.toFixed(2),
        currentValue: +currentValue.toFixed(2),
        unrealizedPL: +unrealizedPL.toFixed(2),
        newAverageCost: +newAverageCost.toFixed(4),
        breakEvenTarget: +tgt.toFixed(4),
    };
}
