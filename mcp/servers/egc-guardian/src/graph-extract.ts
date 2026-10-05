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

interface Tok { t: 'id' | 'str' | 'lit' | 'p'; v: string; line: number }

const MAX_SYMBOLS = 2000;
const MAX_REFS = 200;

const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const DECL_START = new Set(['export', 'import', 'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'abstract', 'declare', 'async', 'module', 'exports', 'namespace']);
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

function regexAllowed(prev: Tok | undefined): boolean {
  if (!prev) return true;
  if (prev.t === 'id') return REGEX_AFTER_KEYWORD.has(prev.v);
  if (prev.t === 'str' || prev.t === 'lit') return false;
  return prev.v !== ')' && prev.v !== ']' && prev.v !== '}';
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
  function skipTemplate(): void {
    i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        if (src[i + 1] === '\n') line++;
        i += 2;
        continue;
      }
      if (src[i] === '\n') line++;
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        skipInterpolation();
        continue;
      }
      i++;
    }
    i++;
  }
  function skipInterpolation(): void {
    let depth = 1;
    while (i < n && depth > 0) {
      const d = src[i];
      if (d === '`') { skipTemplate(); continue; }
      if (d === '"' || d === "'") { skipString(d); continue; }
      if (d === '\n') line++;
      if (d === '{') depth++;
      else if (d === '}') depth--;
      i++;
    }
  }

  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const at = line;
      toks.push({ t: 'str', v: skipString(c), line: at });
      continue;
    }
    if (c === '`') {
      const at = line;
      skipTemplate();
      toks.push({ t: 'lit', v: '', line: at });
      continue;
    }
    if (c === '/' && regexAllowed(toks[toks.length - 1])) {
      const at = line;
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
      toks.push({ t: 'lit', v: '', line: at });
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      toks.push({ t: 'lit', v: '', line });
      i = j;
      continue;
    }
    toks.push({ t: 'p', v: c, line });
    i++;
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

  const requireSpecifier = (eq: number): string | null =>
    isP(toks[eq], '=') && isId(toks[eq + 1], 'require') && isP(toks[eq + 2], '(') && toks[eq + 3]?.t === 'str' ? toks[eq + 3].v : null;

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

  const parseCommonJs = (i: number, p: number): number => {
    if (isP(toks[p], '=')) {
      const rhs = p + 1;
      if (isP(toks[rhs], '{')) {
        const end = close(rhs);
        for (let k = rhs + 1; k < end; ) {
          const tk = toks[k];
          if (isId(tk)) {
            exportedNames.add(tk.v);
            if (isP(toks[k + 1], ':') && isId(toks[k + 2])) exportedNames.add(toks[k + 2].v);
          }
          k = isOpen(tk) ? close(k) + 1 : k + 1;
        }
      } else if (isId(toks[rhs]) && (isP(toks[rhs + 1], ';') || toks[rhs + 1] === undefined || toks[rhs + 1].line > toks[rhs].line)) {
        exportedNames.add(toks[rhs].v);
      }
      return statementEnd(i) + 1;
    }
    if (isP(toks[p], '.') && isId(toks[p + 1]) && isP(toks[p + 2], '=')) {
      const end = statementEnd(i);
      exportedNames.add(toks[p + 1].v);
      addSymbol(toks[p + 1].v, 'variable', true, i, end);
      return end + 1;
    }
    return i + 1;
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
      exported = true;
      j++;
      if (isP(toks[j], '*')) {
        let k = j + 1;
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
      }
      if (isId(toks[j], 'type') && isP(toks[j + 1], '{')) j++;
      if (isP(toks[j], '{')) {
        const names = readBraceBindings(j, 'as');
        const k = close(j) + 1;
        if (isId(toks[k], 'from') && toks[k + 1]?.t === 'str') {
          imports.push({ specifier: toks[k + 1].v, bindings: names, reexport: true });
          return k + 2;
        }
        names.forEach(b => exportedNames.add(b.imported));
        return k;
      }
      if (isId(toks[j], 'default')) {
        isDefault = true;
        j++;
      }
    }
    while (isId(toks[j]) && ['declare', 'abstract', 'async'].includes(toks[j].v) && toks[j + 1]) j++;

    const d = toks[j];
    if (isId(d, 'function')) {
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
      return end + 1;
    }
    if (isId(d, 'class') || isId(d, 'interface') || isId(d, 'enum')) {
      const next = toks[j + 1];
      const nameTok = isId(next) && !isId(next, 'extends') && !isId(next, 'implements') ? next : undefined;
      let b = j + 1;
      while (b <= last && !isP(toks[b], '{')) b = isOpen(toks[b]) ? close(b) + 1 : b + 1;
      const end = b <= last ? close(b) : last;
      const name = nameTok?.v ?? (isDefault ? 'default' : undefined);
      if (name) {
        addSymbol(name, d.v === 'class' ? 'class' : 'type', exported, i, end);
        if (d.v === 'class' && b <= last) addMethods(name, b, exported);
      }
      return end + 1;
    }
    if (isId(d, 'type') && isId(toks[j + 1]) && (isP(toks[j + 2], '=') || isP(toks[j + 2], '<'))) {
      const end = statementEnd(j);
      addSymbol(toks[j + 1].v, 'type', exported, i, end);
      return end + 1;
    }
    if (isId(d, 'const') || isId(d, 'let') || isId(d, 'var')) {
      const end = statementEnd(j);
      const nameTok = toks[j + 1];
      if (isId(nameTok)) {
        const spec = requireSpecifier(j + 2);
        if (spec !== null) imports.push({ specifier: spec, bindings: [{ local: nameTok.v, imported: '*' }], reexport: false });
        else addSymbol(nameTok.v, isFunctionInit(j + 2) ? 'function' : 'variable', exported, i, end);
      } else if (isP(nameTok, '{')) {
        const spec = requireSpecifier(close(j + 1) + 1);
        if (spec !== null) imports.push({ specifier: spec, bindings: readBraceBindings(j + 1, ':'), reexport: false });
      }
      return end + 1;
    }
    if (isDefault) {
      const end = statementEnd(j);
      if (isId(d) && end <= j + 1) exportedNames.add(d.v);
      else addSymbol('default', 'variable', true, i, end);
      return end + 1;
    }
    return isOpen(tk) ? close(i) + 1 : i + 1;
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
