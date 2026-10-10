export type SymbolKind = 'function' | 'class' | 'variable' | 'method' | 'type';

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  exported: boolean;
  startLine: number;
  endLine: number;
  refs: string[];
}
export interface ImportBinding { local: string; imported: string }
export interface ExtractedImport { specifier: string; bindings: ImportBinding[]; reexport: boolean }
export interface ExtractResult { symbols: ExtractedSymbol[]; imports: ExtractedImport[] }

// ctl marks a ) that closes the head of if, for, while or with, and a } that closes a block
// (not an object literal): a regex literal may follow either.
interface Tok { t: 'id' | 'str' | 'lit' | 'p'; v: string; line: number; ctl?: boolean }

const MAX_SYMBOLS = 2000;
const MAX_REFS = 200;

const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const CONTROL_HEAD = new Set(['if', 'for', 'while', 'with']);
// A { after one of these opens a block, not an object literal.
const BLOCK_KEYWORDS = new Set(['else', 'do', 'try', 'finally']);
const DECL_START = new Set(['export', 'import', 'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'abstract', 'declare', 'async', 'module', 'exports', 'namespace']);
const DECL_MODIFIERS = new Set(['declare', 'abstract', 'async']);
const CONTINUATION = new Set(['=', '+', '-', '*', '/', '%', '&', '|', '^', '?', ':', ',', '.', '<', '>', '!', '~', '(', '[', '{']);
const NON_REF = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'yield', 'await', 'async', 'true', 'false', 'null', 'undefined', 'as', 'from', 'type', 'interface', 'enum',
  'implements', 'public', 'private', 'protected', 'readonly', 'abstract', 'declare', 'string', 'number', 'boolean', 'any', 'unknown', 'never'
]);

const isIdStart = (c: string): boolean => /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127;
const isIdPart = (c: string): boolean => /[\w$]/.test(c) || c.charCodeAt(0) > 127;
const isOpen = (tk?: Tok): boolean => !!tk && tk.t === 'p' && (tk.v === '{' || tk.v === '(' || tk.v === '[');
const isId = (tk: Tok | undefined, v?: string): boolean => !!tk && tk.t === 'id' && (v === undefined || tk.v === v);
const isP = (tk: Tok | undefined, v: string): boolean => !!tk && tk.t === 'p' && tk.v === v;

const INTERPOLATION_START = '${';

function regexAllowed(prev: Tok | undefined): boolean {
  if (!prev) return true;
  if (prev.t === 'id') return REGEX_AFTER_KEYWORD.has(prev.v);
  if (prev.t === 'str') return false;
  // The marker left where a ${ opened an expression: what follows it starts a statement-like position.
  if (prev.t === 'lit') return prev.v === INTERPOLATION_START;
  if (prev.v === ')' || prev.v === '}') return prev.ctl === true;
  // A / right after < is a JSX closing tag, not a regex.
  return prev.v !== ']' && prev.v !== '<';
}

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;

  function skipString(q: string): string {
    i++;
    let v = '';
    while (i < n && src[i] !== q && src[i] !== '\n') {
      if (src[i] === '\\') {
        if (src[i + 1] === '\n') line++;
        v += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      v += src[i];
      i++;
    }
    if (src[i] === q) i++;
    return v;
  }
  // Reads template text up to the closing backtick or the next ${. True when it
  // stopped at a ${, whose code follows as ordinary tokens.
  function scanTemplateText(): boolean {
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        if (src[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (src[i] === '\n') line++;
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        return true;
      }
      i++;
    }
    i++;
    return false;
  }

  function skipBlockComment(): void {
    i += 2;
    while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
      if (src[i] === '\n') line++;
      i++;
    }
    i += 2;
  }
  // Consumes whitespace and comments; true when it consumed something.
  function skipTrivia(c: string): boolean {
    if (c === '\n') { line++; i++; return true; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; return true; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      return true;
    }
    if (c === '/' && src[i + 1] === '*') {
      skipBlockComment();
      return true;
    }
    return false;
  }
  function skipRegex(): void {
    let inClass = false;
    i++;
    while (i < n && src[i] !== '\n') {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '[') inClass = true;
      else if (src[i] === ']') inClass = false;
      else if (src[i] === '/' && !inClass) { i++; break; }
      i++;
    }
    while (i < n && /[a-z]/.test(src[i])) i++;
  }
  function readWhile(from: number, test: (ch: string) => boolean): number {
    let j = from;
    while (j < n && test(src[j])) j++;
    return j;
  }

  const parens: boolean[] = [];
  const blocks: boolean[] = [];
  // The brace depth at each ${ still open: the } that brings the depth back is its end.
  const interpolations: number[] = [];
  let braces = 0;

  function openBrace(): void {
    const prev = toks[toks.length - 1];
    const block = prev === undefined
      || (prev.t === 'p' && (prev.v === ')' || prev.v === ';' || prev.v === '{' || prev.v === '}'))
      || (prev.t === 'id' && BLOCK_KEYWORDS.has(prev.v));
    blocks.push(block);
    braces++;
  }
  // The } that ends a ${ is not a token: the template text goes on from it.
  function closesInterpolation(): boolean {
    if (interpolations.length === 0 || interpolations[interpolations.length - 1] !== braces) return false;
    interpolations.pop();
    i++;
    if (scanTemplateText()) openInterpolation();
    else toks.push({ t: 'lit', v: '', line });
    return true;
  }
  // A ${ opens an expression: a / right after it starts a regex, which the marker token tells regexAllowed.
  function openInterpolation(): void {
    interpolations.push(braces);
    toks.push({ t: 'lit', v: INTERPOLATION_START, line });
  }
  function pushPunct(c: string): void {
    const tk: Tok = { t: 'p', v: c, line };
    if (c === '(') {
      const prev = toks[toks.length - 1];
      parens.push(prev?.t === 'id' && CONTROL_HEAD.has(prev.v));
    } else if (c === ')') {
      tk.ctl = parens.pop() === true;
    } else if (c === '{') {
      openBrace();
    } else if (c === '}') {
      if (closesInterpolation()) return;
      braces = Math.max(0, braces - 1);
      tk.ctl = blocks.pop() === true;
    }
    toks.push(tk);
    i++;
  }

  while (i < n) {
    const c = src[i];
    if (skipTrivia(c)) continue;
    const at = line;
    if (c === '"' || c === "'") {
      toks.push({ t: 'str', v: skipString(c), line: at });
    } else if (c === '`') {
      i++;
      toks.push({ t: 'lit', v: '', line: at });
      if (scanTemplateText()) openInterpolation();
    } else if (c === '/' && regexAllowed(toks[toks.length - 1])) {
      skipRegex();
      toks.push({ t: 'lit', v: '', line: at });
    } else if (isIdStart(c)) {
      const j = readWhile(i + 1, isIdPart);
      toks.push({ t: 'id', v: src.slice(i, j), line });
      i = j;
    } else if (c >= '0' && c <= '9') {
      const j = readWhile(i + 1, ch => /[\w.]/.test(ch));
      toks.push({ t: 'lit', v: '', line });
      i = j;
    } else {
      pushPunct(c);
    }
  }
  return toks;
}

function pairBrackets(toks: Tok[]): number[] {
  const match = new Array<number>(toks.length).fill(-1);
  const stack: number[] = [];
  toks.forEach((tk, k) => {
    if (tk.t !== 'p') return;
    if (tk.v === '{' || tk.v === '(' || tk.v === '[') {
      stack.push(k);
    } else if (tk.v === '}' || tk.v === ')' || tk.v === ']') {
      const open = stack.pop();
      if (open !== undefined) {
        match[open] = k;
        match[k] = open;
      }
    }
  });
  return match;
}

export function extractFile(source: string): ExtractResult {
  const toks = tokenize(source);
  const match = pairBrackets(toks);
  const last = toks.length - 1;
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const exportedNames = new Set<string>();

  // An unmatched opener counts as running to the end of the file.
  const close = (k: number): number => (match[k] >= 0 ? match[k] : last);

  const collectRefs = (from: number, to: number, self: string): string[] => {
    const refs = new Set<string>();
    for (let k = from; k <= to && refs.size < MAX_REFS; k++) {
      const tk = toks[k];
      if (tk.t !== 'id' || NON_REF.has(tk.v)) continue;
      if (isP(toks[k - 1], '.')) {
        if (isId(toks[k - 2], 'this')) refs.add('.' + tk.v);
        continue;
      }
      if (tk.v !== self) refs.add(tk.v);
      if (isP(toks[k + 1], '.') && isId(toks[k + 2])) refs.add(tk.v + '.' + toks[k + 2].v);
    }
    return [...refs];
  };

  // `export { foo as bar }` and a named default declaration give a symbol a
  // second, public name. It is kept as a re-export of this very file (empty
  // specifier), so an import of the public name resolves to the symbol.
  const addExportAlias = (publicName: string, local: string): void => {
    imports.push({ specifier: '', bindings: [{ local: publicName, imported: local }], reexport: true });
  };

  const addSymbol = (name: string, kind: SymbolKind, exported: boolean, startIdx: number, endIdx: number, selfName: string = name): void => {
    if (symbols.length >= MAX_SYMBOLS) return;
    symbols.push({ name, kind, exported, startLine: toks[startIdx].line, endLine: toks[endIdx].line, refs: collectRefs(startIdx, endIdx, selfName) });
  };

  const statementEnd = (from: number): number => {
    let k = from;
    while (k <= last) {
      const tk = toks[k];
      if (k > from) {
        const prev = toks[k - 1];
        const continues = prev.t === 'p' && CONTINUATION.has(prev.v);
        if (tk.line > prev.line && tk.t === 'id' && DECL_START.has(tk.v) && !continues) return k - 1;
      }
      if (isP(tk, ';')) return k;
      k = isOpen(tk) ? close(k) + 1 : k + 1;
    }
    return last;
  };

  const readBraceBindings = (open: number, sep: 'as' | ':'): ImportBinding[] => {
    const out: ImportBinding[] = [];
    const end = close(open);
    let m = open + 1;
    while (m < end) {
      let nm = toks[m];
      if (isId(nm, 'type') && isId(toks[m + 1]) && !isId(toks[m + 1], 'as')) {
        m++;
        nm = toks[m];
      }
      if (!isId(nm)) { m++; continue; }
      const hasAlias = sep === 'as' ? isId(toks[m + 1], 'as') : isP(toks[m + 1], ':');
      const aliasAt = m + 2;
      if (hasAlias && isId(toks[aliasAt])) {
        out.push({ local: toks[aliasAt].v, imported: nm.v });
        m += 3;
      } else {
        out.push({ local: nm.v, imported: nm.v });
        m++;
      }
    }
    return out;
  };

  // Where a module load starts after `=`: the require or import token, past an await; -1 when it is not one.
  const moduleLoadAt = (eq: number): number => {
    if (!isP(toks[eq], '=')) return -1;
    const k = isId(toks[eq + 1], 'await') ? eq + 2 : eq + 1;
    return (isId(toks[k], 'require') || isId(toks[k], 'import')) && isP(toks[k + 1], '(') ? k : -1;
  };

  // `= require(...)`, `= await import(...)`: what is bound comes from another module, whatever the argument is.
  const loadsAModule = (eq: number): boolean => moduleLoadAt(eq) !== -1;

  // The module's path when it is a plain string: `= require('x')` or `= await import('x')`.
  const requireSpecifier = (eq: number): string | null => {
    const k = moduleLoadAt(eq);
    return k !== -1 && toks[k + 2]?.t === 'str' ? toks[k + 2].v : null;
  };

  const isFunctionInit = (eq: number): boolean => {
    if (!isP(toks[eq], '=')) return false;
    const a = toks[eq + 1];
    if (isId(a, 'function') || isId(a, 'async')) return true;
    if (isP(a, '(') && match[eq + 1] >= 0) {
      const stop = Math.min(last, match[eq + 1] + 40);
      for (let m = match[eq + 1] + 1; m <= stop; m++) {
        if (isP(toks[m], ';')) return false;
        if (isP(toks[m], '=') && isP(toks[m + 1], '>')) return true;
      }
      return false;
    }
    return isId(a) && isP(toks[eq + 2], '=') && isP(toks[eq + 3], '>');
  };

  const addMethods = (cls: string, bodyOpen: number, exported: boolean): void => {
    const bodyClose = close(bodyOpen);
    let k = bodyOpen + 1;
    while (k < bodyClose) {
      const tk = toks[k];
      if (isId(tk) && isP(toks[k + 1], '(') && match[k + 1] >= 0) {
        let m = match[k + 1] + 1;
        while (m < bodyClose && !isP(toks[m], '{') && !isP(toks[m], ';')) m = isOpen(toks[m]) ? close(m) + 1 : m + 1;
        if (m < bodyClose && isP(toks[m], '{')) {
          const end = close(m);
          addSymbol(`${cls}.${tk.v}`, 'method', exported, k, end, tk.v);
          k = end + 1;
          continue;
        }
      }
      k = isOpen(tk) ? close(k) + 1 : k + 1;
    }
  };

  const parseImport = (i: number): number => {
    let j = i + 1;
    if (isId(toks[j], 'type') && (isId(toks[j + 1]) || isP(toks[j + 1], '{') || isP(toks[j + 1], '*')) && !isId(toks[j + 1], 'from')) j++;
    if (toks[j]?.t === 'str') {
      imports.push({ specifier: toks[j].v, bindings: [], reexport: false });
      return j + 1;
    }
    const bindings: ImportBinding[] = [];
    let k = j;
    while (k <= last && !isId(toks[k], 'from') && toks[k].t !== 'str') {
      const tk = toks[k];
      if (tk.t === 'id') {
        bindings.push({ local: tk.v, imported: 'default' });
        k++;
      } else if (isP(tk, '*')) {
        if (isId(toks[k + 2])) bindings.push({ local: toks[k + 2].v, imported: '*' });
        k += 3;
      } else if (isP(tk, '{')) {
        bindings.push(...readBraceBindings(k, 'as'));
        k = close(k) + 1;
      } else {
        k++;
      }
    }
    if (isId(toks[k], 'from')) k++;
    if (toks[k]?.t === 'str') {
      imports.push({ specifier: toks[k].v, bindings, reexport: false });
      return k + 1;
    }
    return Math.max(k, i + 1);
  };

  // Where the element that starts at from ends: the next comma at this nesting level, or end.
  const elementEnd = (from: number, end: number): number => {
    let at = from;
    while (at < end && !isP(toks[at], ',')) at = isOpen(toks[at]) ? close(at) + 1 : at + 1;
    return at;
  };

  // { publicName: value }: an alias of a local only when the value is that one name. handlers.run, make() and 5
  // name nothing this file exports.
  const exportProperty = (key: Tok, valueStart: number, valueEnd: number): void => {
    const value = toks[valueStart];
    if (valueEnd !== valueStart + 1 || !isId(value)) return;
    exportedNames.add(value.v);
    if (key.v !== value.v) addExportAlias(key.v, value.v);
  };

  // module.exports = { publicName: local, shorthand }: the locals are exported, and answer to the public names too.
  const exportObjectNames = (open: number): void => {
    const end = close(open);
    for (let k = open + 1; k < end; ) {
      const tk = toks[k];
      if (isId(tk) && isP(toks[k + 1], ':')) {
        const valueEnd = elementEnd(k + 2, end);
        exportProperty(tk, k + 2, valueEnd);
        k = valueEnd + 1;
      } else {
        if (isId(tk)) exportedNames.add(tk.v);
        k = isOpen(tk) ? close(k) + 1 : k + 1;
      }
    }
  };

  const isFunctionOrClassStart = (k: number): boolean =>
    isId(toks[k], 'function') || isId(toks[k], 'class') || (isId(toks[k], 'async') && isId(toks[k + 1], 'function'));

  // module.exports = ...
  const parseModuleExports = (i: number, rhs: number): number => {
    if (isP(toks[rhs], '{')) {
      exportObjectNames(rhs);
    } else if (isFunctionOrClassStart(rhs)) {
      // module.exports = function () {} / class Foo {}: the implementation is the module's export.
      return parseDeclaration(i, isId(toks[rhs], 'async') ? rhs + 1 : rhs, true, true);
    } else if (isId(toks[rhs]) && (isP(toks[rhs + 1], ';') || toks[rhs + 1] === undefined || toks[rhs + 1].line > toks[rhs].line)) {
      exportedNames.add(toks[rhs].v);
    }
    return statementEnd(i) + 1;
  };

  // exports.name = ... and module.exports.name = ..., with p at the dot before the name.
  const parseExportsProperty = (i: number, p: number): number => {
    const end = statementEnd(i);
    const name = toks[p + 1].v;
    const value = toks[p + 3];
    if (isId(value) && !NON_REF.has(value.v) && end <= p + 4) {
      // exports.name = localName;: an alias of the local symbol, not a symbol of its own.
      exportedNames.add(value.v);
      addExportAlias(name, value.v);
    } else {
      exportedNames.add(name);
      addSymbol(name, 'variable', true, i, end);
    }
    return end + 1;
  };

  const parseCommonJs = (i: number, p: number): number => {
    if (isP(toks[p], '=')) return parseModuleExports(i, p + 1);
    if (isP(toks[p], '.') && isId(toks[p + 1]) && isP(toks[p + 2], '=')) return parseExportsProperty(i, p);
    return i + 1;
  };

  const parseExportStar = (i: number, star: number): number => {
    let k = star + 1;
    let ns: string | undefined;
    if (isId(toks[k], 'as') && isId(toks[k + 1])) {
      ns = toks[k + 1].v;
      k += 2;
    }
    if (isId(toks[k], 'from') && toks[k + 1]?.t === 'str') {
      imports.push({ specifier: toks[k + 1].v, bindings: [{ local: ns ?? '*', imported: '*' }], reexport: true });
      return k + 2;
    }
    return Math.max(k, i + 1);
  };

  const parseExportList = (open: number): number => {
    const names = readBraceBindings(open, 'as');
    const k = close(open) + 1;
    if (isId(toks[k], 'from') && toks[k + 1]?.t === 'str') {
      imports.push({ specifier: toks[k + 1].v, bindings: names, reexport: true });
      return k + 2;
    }
    for (const b of names) {
      exportedNames.add(b.imported);
      if (b.local !== b.imported) addExportAlias(b.local, b.imported);
    }
    return k;
  };

  // After `export`: either a finished re-export or list (done), or where the declaration starts.
  const parseExportHead = (i: number): { done: number } | { at: number; isDefault: boolean } => {
    let j = i + 1;
    if (isP(toks[j], '*')) return { done: parseExportStar(i, j) };
    if (isId(toks[j], 'type') && isP(toks[j + 1], '{')) j++;
    if (isP(toks[j], '{')) return { done: parseExportList(j) };
    if (isId(toks[j], 'default')) return { at: j + 1, isDefault: true };
    return { at: j, isDefault: false };
  };

  const parseFunctionDecl = (i: number, j: number, exported: boolean, isDefault: boolean): number => {
    let k = j + 1;
    if (isP(toks[k], '*')) k++;
    const nameTok = isId(toks[k]) ? toks[k] : undefined;
    let p = nameTok ? k + 1 : k;
    while (p <= last && !isP(toks[p], '(')) p++;
    let b = p <= last ? close(p) + 1 : last + 1;
    while (b <= last && !isP(toks[b], '{') && !isP(toks[b], ';')) b = isOpen(toks[b]) ? close(b) + 1 : b + 1;
    const end = isP(toks[b], '{') ? close(b) : Math.min(b, last);
    const name = nameTok ? nameTok.v : isDefault ? 'default' : null;
    if (name) addSymbol(name, 'function', exported, i, end);
    if (name && nameTok && isDefault) addExportAlias('default', name);
    return end + 1;
  };

  const parseClassDecl = (i: number, j: number, exported: boolean, isDefault: boolean): number => {
    const keyword = toks[j].v;
    const next = toks[j + 1];
    const nameTok = isId(next) && !isId(next, 'extends') && !isId(next, 'implements') ? next : undefined;
    let b = j + 1;
    while (b <= last && !isP(toks[b], '{')) b = isOpen(toks[b]) ? close(b) + 1 : b + 1;
    const end = b <= last ? close(b) : last;
    const name = nameTok?.v ?? (isDefault ? 'default' : undefined);
    if (name) {
      addSymbol(name, keyword === 'class' ? 'class' : 'type', exported, i, end);
      if (keyword === 'class' && b <= last) addMethods(name, b, exported);
      if (nameTok && isDefault) addExportAlias('default', name);
    }
    return end + 1;
  };

  const declaratorFollows = (tk: Tok | undefined): boolean =>
    tk === undefined || isP(tk, '=') || isP(tk, ',') || isP(tk, ';') || isP(tk, ':');

  // `const first = 1, second = 2`: the names that start a declarator after a top-level comma.
  const extraDeclarators = (from: number, end: number): number[] => {
    const starts: number[] = [];
    for (let k = from; k <= end; ) {
      const tk = toks[k];
      if (isP(tk, ',') && isId(toks[k + 1]) && declaratorFollows(toks[k + 2])) starts.push(k + 1);
      k = isOpen(tk) ? close(k) + 1 : k + 1;
    }
    return starts;
  };

  const addDeclarator = (name: Tok, at: number, stop: number, exported: boolean, from: number): void => {
    const spec = requireSpecifier(at + 1);
    if (spec !== null) imports.push({ specifier: spec, bindings: [{ local: name.v, imported: '*' }], reexport: false });
    else if (!loadsAModule(at + 1)) addSymbol(name.v, isFunctionInit(at + 1) ? 'function' : 'variable', exported, from, stop);
  };

  // Where what one pattern element binds starts: past a rest dot, and in an object past the key and its colon.
  // A computed key is a selector, not a binding, so it is skipped whole.
  const bindingStart = (from: number, isObject: boolean, stop: number): number => {
    let at = from;
    while (isP(toks[at], '.')) at++;
    if (isObject && isP(toks[at], '[')) {
      const afterKey = close(at) + 1;
      return isP(toks[afterKey], ':') ? afterKey + 1 : stop;
    }
    return isObject && isId(toks[at]) && isP(toks[at + 1], ':') ? at + 2 : at;
  };

  // The names a destructuring pattern binds, as token indexes: { a, b: c, d = 1, ...rest } and [x, , y = 2, ...z], nested too.
  const patternNames = (open: number): number[] => {
    const names: number[] = [];
    const end = close(open);
    const isObject = isP(toks[open], '{');
    let k = open + 1;
    while (k < end) {
      const stop = elementEnd(k, end);
      const at = bindingStart(k, isObject, stop);
      if (at < stop && isId(toks[at])) names.push(at);
      else if (at < stop && (isP(toks[at], '{') || isP(toks[at], '['))) names.push(...patternNames(at));
      k = stop + 1;
    }
    return names;
  };

  const addPatternDeclarator = (open: number, afterPattern: number, stop: number, exported: boolean, from: number): void => {
    const spec = isP(toks[open], '{') ? requireSpecifier(afterPattern) : null;
    if (spec !== null) {
      imports.push({ specifier: spec, bindings: readBraceBindings(open, ':'), reexport: false });
      return;
    }
    // Names taken from a module whose path is not a plain string are imports too, not symbols of this file:
    // counting them would credit every file that imports `validateCommand` with defining it.
    if (loadsAModule(afterPattern)) return;
    for (const at of patternNames(open)) addSymbol(toks[at].v, 'variable', exported, from, stop);
  };

  const parseVariableDecl = (i: number, j: number, exported: boolean): number => {
    const end = statementEnd(j);
    const nameTok = toks[j + 1];
    const isPattern = isP(nameTok, '{') || isP(nameTok, '[');
    // Where the first declarator's initializer starts: after its name, or after its pattern.
    const afterFirst = isPattern ? close(j + 1) + 1 : j + 2;
    const starts = extraDeclarators(afterFirst, end);
    const stopOfFirst = starts.length > 0 ? starts[0] - 2 : end;
    if (isId(nameTok)) addDeclarator(nameTok, j + 1, stopOfFirst, exported, i);
    else if (isPattern) addPatternDeclarator(j + 1, afterFirst, stopOfFirst, exported, i);
    starts.forEach((at, n) => addDeclarator(toks[at], at, starts[n + 1] !== undefined ? starts[n + 1] - 2 : end, exported, at));
    return end + 1;
  };

  const isTypeAlias = (j: number): boolean =>
    isId(toks[j], 'type') && isId(toks[j + 1]) && (isP(toks[j + 2], '=') || isP(toks[j + 2], '<'));

  const parseDeclaration = (i: number, j: number, exported: boolean, isDefault: boolean): number => {
    const d = toks[j];
    if (isId(d, 'function')) return parseFunctionDecl(i, j, exported, isDefault);
    if (isId(d, 'class') || isId(d, 'interface') || isId(d, 'enum')) return parseClassDecl(i, j, exported, isDefault);
    if (isTypeAlias(j)) {
      const end = statementEnd(j);
      addSymbol(toks[j + 1].v, 'type', exported, i, end);
      return end + 1;
    }
    if (isId(d, 'const') || isId(d, 'let') || isId(d, 'var')) return parseVariableDecl(i, j, exported);
    if (isDefault) {
      const end = statementEnd(j);
      if (isId(d) && end <= j + 1) {
        exportedNames.add(d.v);
        addExportAlias('default', d.v);
      } else {
        addSymbol('default', 'variable', true, i, end);
      }
      return end + 1;
    }
    return isOpen(toks[i]) ? close(i) + 1 : i + 1;
  };

  const parseTopLevel = (i: number): number => {
    const tk = toks[i];
    if (isId(tk, 'import') && !isP(toks[i + 1], '(') && !isP(toks[i + 1], '.')) return parseImport(i);
    if (isId(tk, 'module') && isP(toks[i + 1], '.') && isId(toks[i + 2], 'exports')) return parseCommonJs(i, i + 3);
    if (isId(tk, 'exports') && isP(toks[i + 1], '.')) return parseCommonJs(i, i + 1);

    let j = i;
    let exported = false;
    let isDefault = false;
    if (isId(tk, 'export')) {
      const head = parseExportHead(i);
      if ('done' in head) return head.done;
      exported = true;
      j = head.at;
      isDefault = head.isDefault;
    }
    while (isId(toks[j]) && DECL_MODIFIERS.has(toks[j].v) && toks[j + 1]) j++;
    return parseDeclaration(i, j, exported, isDefault);
  };

  let at = 0;
  while (at <= last) at = Math.max(parseTopLevel(at), at + 1);

  toks.forEach((tk, k) => {
    if (!(isId(tk, 'require') || isId(tk, 'import')) || isP(toks[k - 1], '.')) return;
    if (!isP(toks[k + 1], '(') || toks[k + 2]?.t !== 'str') return;
    if (!isP(toks[k + 3], ')') && !isP(toks[k + 3], ',')) return;
    const specifier = toks[k + 2].v;
    if (!imports.some(im => im.specifier === specifier)) imports.push({ specifier, bindings: [], reexport: false });
  });

  for (const s of symbols) if (exportedNames.has(s.name)) s.exported = true;
  return { symbols, imports };
}
