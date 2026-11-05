/**
 * A small, safe arithmetic evaluator (recursive descent). No `eval`, no
 * `Function`, no property access — only numbers, operators, parentheses and
 * a fixed whitelist of functions and constants.
 *
 * Grammar:
 *   expr   := term (('+' | '-') term)*
 *   term   := power (('*' | '/' | '%') power)*
 *   power  := unary ('^' power)?
 *   unary  := ('-' | '+') unary | call
 *   call   := IDENT '(' expr (',' expr)* ')' | IDENT | NUMBER | '(' expr ')'
 */
const FUNCTIONS: Record<string, { arity: [number, number]; fn: (...args: number[]) => number }> = {
  sqrt: { arity: [1, 1], fn: Math.sqrt },
  abs: { arity: [1, 1], fn: Math.abs },
  round: { arity: [1, 2], fn: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d },
  floor: { arity: [1, 1], fn: Math.floor },
  ceil: { arity: [1, 1], fn: Math.ceil },
  min: { arity: [1, 32], fn: Math.min },
  max: { arity: [1, 32], fn: Math.max },
  log10: { arity: [1, 1], fn: Math.log10 },
  ln: { arity: [1, 1], fn: Math.log },
  exp: { arity: [1, 1], fn: Math.exp },
  sin: { arity: [1, 1], fn: Math.sin },
  cos: { arity: [1, 1], fn: Math.cos },
  tan: { arity: [1, 1], fn: Math.tan },
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token =
  { kind: 'num'; value: number } | { kind: 'id'; value: string } | { kind: 'op'; value: string };

export class CalculatorError extends Error {}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const match = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(input.slice(i));
      if (!match) throw new CalculatorError(`Invalid number at position ${i}`);
      tokens.push({ kind: 'num', value: Number(match[0]) });
      i += match[0].length;
    } else if (/[a-z_]/i.test(ch)) {
      const match = /^[a-z_][a-z0-9_]*/i.exec(input.slice(i)) as RegExpExecArray;
      tokens.push({ kind: 'id', value: match[0].toLowerCase() });
      i += match[0].length;
    } else if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i++;
    } else {
      throw new CalculatorError(`Unexpected character "${ch}" at position ${i}`);
    }
  }
  return tokens;
}

export function evaluateExpression(expression: string): number {
  if (expression.length > 500)
    throw new CalculatorError('Expression too long (max 500 characters)');
  const tokens = tokenize(expression);
  let pos = 0;
  let depth = 0;
  const peek = (): Token | undefined => tokens[pos];
  const isOp = (value: string): boolean => {
    const t = peek();
    return t?.kind === 'op' && t.value === value;
  };
  const expectOp = (value: string): void => {
    if (!isOp(value)) throw new CalculatorError(`Expected "${value}"`);
    pos++;
  };

  const expr = (): number => {
    if (++depth > 64) throw new CalculatorError('Expression nested too deeply');
    let value = term();
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as Token).value;
      value = op === '+' ? value + term() : value - term();
    }
    depth--;
    return value;
  };
  const term = (): number => {
    let value = power();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (tokens[pos++] as Token).value;
      const rhs = power();
      if ((op === '/' || op === '%') && rhs === 0) throw new CalculatorError('Division by zero');
      value = op === '*' ? value * rhs : op === '/' ? value / rhs : value % rhs;
    }
    return value;
  };
  const power = (): number => {
    const base = unary();
    if (isOp('^')) {
      pos++;
      return base ** power();
    }
    return base;
  };
  const unary = (): number => {
    if (isOp('-')) {
      pos++;
      return -unary();
    }
    if (isOp('+')) {
      pos++;
      return unary();
    }
    return primary();
  };
  const primary = (): number => {
    const token = peek();
    if (!token) throw new CalculatorError('Unexpected end of expression');
    if (token.kind === 'num') {
      pos++;
      return token.value;
    }
    if (token.kind === 'op' && token.value === '(') {
      pos++;
      const value = expr();
      expectOp(')');
      return value;
    }
    if (token.kind === 'id') {
      pos++;
      if (isOp('(')) {
        const fn = FUNCTIONS[token.value];
        if (!fn) throw new CalculatorError(`Unknown function "${token.value}"`);
        pos++;
        const args = [expr()];
        while (isOp(',')) {
          pos++;
          args.push(expr());
        }
        expectOp(')');
        if (args.length < fn.arity[0] || args.length > fn.arity[1]) {
          throw new CalculatorError(`Wrong number of arguments for ${token.value}()`);
        }
        return fn.fn(...args);
      }
      const constant = CONSTANTS[token.value];
      if (constant === undefined) throw new CalculatorError(`Unknown identifier "${token.value}"`);
      return constant;
    }
    throw new CalculatorError(`Unexpected token "${token.value}"`);
  };

  const result = expr();
  if (pos < tokens.length)
    throw new CalculatorError(`Unexpected token "${String((tokens[pos] as Token).value)}"`);
  if (!Number.isFinite(result)) throw new CalculatorError('Result is not a finite number');
  return result;
}
