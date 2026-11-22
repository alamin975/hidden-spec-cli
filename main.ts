// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a move edit performed, in order; only a pair whose old path existed before the patch and whose new
   * path did not is reported as an `R` row (section 2). Rolled back with `now` when an edit fails. */
  readonly moves: Array<{ old: string; new: string }> = [];
  recordMove(oldP: string, newP: string): void {
    this.moves.push({ old: oldP, new: newP });
  }
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file as lines (section 3): its line break, its lines, whether it ends with a line break. */
interface FileModel {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

/** One line of N: a context line, written as the file's own matched line, or an added line. */
type NewLine = { kind: 'ctx'; idx: number } | { kind: 'add'; text: string };

/** Line equality at one matching tier (section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const trimEnd = (s: string): string => s.replace(/[ \t]+$/, '');
  if (tier === 1) return trimEnd(a) === trimEnd(b);
  const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return trimBoth(a) === trimBoth(b);
}

function matchAt(o: string[], f: string[], at: number, tier: number): boolean {
  for (let k = 0; k < o.length; k++) if (!lineEq(o[k]!, f[at + k]!, tier)) return false;
  return true;
}

/** All 0-based positions where O occurs in the file's lines at a tier. */
function occurrences(o: string[], f: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= f.length; i++) if (matchAt(o, f, i, tier)) out.push(i);
  return out;
}

/** The first tier at which O occurs at least once, with its positions (section 5). */
function findTier(o: string[], f: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(o, f, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The replacement lines for a match at `at`: context lines from the file, other lines re-indented at tier 2. */
function buildReplacement(model: FileModel, at: number, nParts: NewLine[], o: string[], tier: number): string[] {
  if (tier !== 2) return nParts.map((np) => (np.kind === 'ctx' ? model.lines[at + np.idx]! : np.text));
  const F = /^[ \t]*/.exec(model.lines[at] ?? '')?.[0] ?? '';
  const P = /^[ \t]*/.exec(o[0] ?? '')?.[0] ?? '';
  return nParts.map((np) => {
    if (np.kind === 'ctx') return model.lines[at + np.idx]!;
    const t = np.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk (section 6): its A, its body lines, O and N, and whether a `\` line follows its last
 * context or `+` line. */
interface Hunk {
  a: number;
  body: string[];
  oLines: string[];
  nParts: NewLine[];
  backslashAfterLastCtxOrPlus: boolean;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const body: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const oLines: string[] = [];
  const nParts: NewLine[] = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      oLines.push(t);
      nParts.push({ kind: 'ctx', idx: oLines.length - 1 });
    } else if (l.startsWith('-')) oLines.push(l.slice(1));
    else if (l.startsWith('+')) nParts.push({ kind: 'add', text: l.slice(1) });
  }
  let backslashAfterLastCtxOrPlus = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const l = body[k]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) {
      backslashAfterLastCtxOrPlus = (body[k + 1] ?? '').startsWith('\\');
      break;
    }
  }
  return { hunk: { a, body, oLines, nParts, backslashAfterLastCtxOrPlus }, next: j };
}

/** One unified section (section 6). Paths are `undefined` while unnamed, `null` for `/dev/null`. */
interface Section {
  oldPath: string | null | undefined;
  newPath: string | null | undefined;
  isNew: boolean;
  isDeleted: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!;
  const p = raw.trim();
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let state: 'outside' | 'header' | 'afterHunk' = 'outside';
  let hasPair = false;
  const startSection = (oldP: string | null | undefined, newP: string | null | undefined, diffOld?: string, diffNew?: string): void => {
    cur = { oldPath: oldP, newPath: newP, isNew: false, isDeleted: false, hunks: [] };
    (cur as Section & { diffOld?: string; diffNew?: string }).diffOld = diffOld;
    (cur as Section & { diffOld?: string; diffNew?: string }).diffNew = diffNew;
    sections.push(cur);
    state = 'header';
    hasPair = oldP !== undefined || newP !== undefined;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(undefined, undefined, m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (state === 'header' && l.startsWith('--- ')) {
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      const oldP = headerPath(l);
      const newP = headerPath(lines[i + 1]!);
      if (hasPair) {
        startSection(oldP, newP);
      } else {
        cur!.oldPath = oldP;
        cur!.newPath = newP;
        hasPair = true;
      }
      i += 2;
      continue;
    }
    if ((state === 'afterHunk' || state === 'outside') && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection(headerPath(l), headerPath(lines[i + 1]!));
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      state = 'afterHunk';
      i = next;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (l.startsWith('rename from ')) (cur as Section & { renameFrom?: string }).renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) (cur as Section & { renameTo?: string }).renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isNew = true;
      else if (l.startsWith('deleted file mode')) cur.isDeleted = true;
    }
    i += 1;
  }
  for (const s of sections) {
    const ext = s as Section & { diffOld?: string; diffNew?: string; renameFrom?: string; renameTo?: string };
    if (s.oldPath === undefined) s.oldPath = ext.renameFrom ?? ext.diffOld ?? null;
    if (s.newPath === undefined) s.newPath = ext.renameTo ?? ext.diffNew ?? null;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply one hunk to a file model; `d` is the length delta of this section's hunks applied so far. */
function applyHunk(model: FileModel, h: Hunk, d: number, strict: boolean, path: string): FileModel {
  const o = h.oLines;
  if (o.length === 0) {
    const insertAt = Math.max(0, Math.min(h.a + d, model.lines.length));
    const rep = buildReplacement(model, insertAt, h.nParts, o, 0);
    const lines = [...model.lines];
    lines.splice(insertAt, 0, ...rep);
    const atEnd = insertAt === model.lines.length;
    return { br: model.br, lines, finalBreak: atEnd ? !h.backslashAfterLastCtxOrPlus : model.finalBreak };
  }
  const found = findTier(o, model.lines, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const rep = buildReplacement(model, best, h.nParts, o, found.tier);
  const lines = [...model.lines];
  lines.splice(best, o.length, ...rep);
  const touchesEnd = best + o.length === model.lines.length;
  return { br: model.br, lines, finalBreak: touchesEnd ? !h.backslashAfterLastCtxOrPlus : model.finalBreak };
}

function unifiedEdit(sec: Section, strict = false): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.isNew;
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plusLines: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const l = h.body[k]!;
          if (l.startsWith('+')) {
            plusLines.push(l.slice(1));
            noBreak = (h.body[k + 1] ?? '').startsWith('\\');
          }
        }
      }
      tree.now.set(newP, plusLines.length === 0 ? '' : plusLines.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    const isDelete = newP === null || sec.isDeleted;
    if (isDelete) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return;
    }
    if (oldP !== newP) {
      const cur = tree.get(oldP!);
      if (cur === null) throw new Fail('missing', oldP!);
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
      let model = splitFile(cur);
      let d = 0;
      for (const h of sec.hunks) {
        model = applyHunk(model, h, d, strict, oldP!);
        d += h.nParts.length - h.oLines.length;
      }
      tree.now.set(newP!, joinFile(model));
      tree.now.set(oldP!, null);
      tree.recordMove(oldP!, newP!);
      return;
    }
    const cur = tree.get(oldP!);
    if (cur === null) throw new Fail('missing', oldP!);
    let model = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      model = applyHunk(model, h, d, strict, oldP!);
      d += h.nParts.length - h.oLines.length;
    }
    tree.now.set(oldP!, joinFile(model));
  };
}

/** One SEARCH/REPLACE block (section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const model = splitFile(cur);
    const found = findTier(oldLines, model.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const nParts: NewLine[] = newLines.map((t) => ({ kind: 'add', text: t }));
    const rep = buildReplacement(model, at, nParts, oldLines, found.tier);
    const lines = [...model.lines];
    lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, joinFile({ br: model.br, lines, finalBreak: model.finalBreak }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k--) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk (section 8): its anchor (null: none), its raw body lines, and whether `*** End of File`
 * ended it. Raw body lines are converted to O/N when the section ends, so blank lines at the end of the
 * section can be dropped first. */
interface V4aChunk {
  anchor: string | null;
  rawBody: string[];
  endOfFile: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** Apply one V4A chunk; returns the model and the cursor just after the lines written. */
function applyV4aChunk(
  model: FileModel,
  ch: { anchor: string | null; oLines: string[]; nParts: NewLine[]; endOfFile: boolean },
  cursor: number,
  strict: boolean,
  path: string,
): { model: FileModel; cursor: number } {
  let cur = cursor;
  if (ch.anchor !== null) {
    let idx = -1;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const t of tiers) {
      for (let j = cur; j < model.lines.length; j++) {
        if (lineEq(ch.anchor, model.lines[j]!, t)) {
          idx = j;
          break;
        }
      }
      if (idx >= 0) break;
    }
    if (idx < 0) throw new Fail('no-match', path);
    cur = idx + 1;
  }
  const o = ch.oLines;
  if (o.length === 0) {
    const insertAt = ch.endOfFile ? model.lines.length : cur;
    const rep = ch.nParts.map((np) => (np.kind === 'add' ? np.text : model.lines[insertAt + np.idx] ?? ''));
    const lines = [...model.lines];
    lines.splice(insertAt, 0, ...rep);
    return { model: { br: model.br, lines, finalBreak: model.finalBreak }, cursor: insertAt + rep.length };
  }
  const tiers = strict ? [0] : [0, 1, 2];
  let found: { tier: number; pos: number } | null = null;
  for (const t of tiers) {
    if (ch.endOfFile) {
      const pos = model.lines.length - o.length;
      if (pos >= cur && pos >= 0 && matchAt(o, model.lines, pos, t)) {
        found = { tier: t, pos };
        break;
      }
    } else {
      for (let i = cur; i + o.length <= model.lines.length; i++) {
        if (matchAt(o, model.lines, i, t)) {
          found = { tier: t, pos: i };
          break;
        }
      }
      if (found !== null) break;
    }
  }
  if (found === null) throw new Fail('no-match', path);
  const rep = buildReplacement(model, found.pos, ch.nParts, o, found.tier);
  const lines = [...model.lines];
  lines.splice(found.pos, o.length, ...rep);
  return { model: { br: model.br, lines, finalBreak: model.finalBreak }, cursor: found.pos + rep.length };
}

function v4aUpdateEdit(
  path: string,
  moveTo: string | null,
  chunks: V4aChunk[],
  strict: boolean,
): Edit {
  // Convert each chunk's raw body lines to O and N once, now that trailing blanks are settled.
  const ready = chunks.map((ch) => {
    const oLines: string[] = [];
    const nParts: NewLine[] = [];
    for (const l of ch.rawBody) {
      if (l === '' || l.startsWith(' ')) {
        const t = l === '' ? '' : l.slice(1);
        oLines.push(t);
        nParts.push({ kind: 'ctx', idx: oLines.length - 1 });
      } else if (l.startsWith('-')) oLines.push(l.slice(1));
      else if (l.startsWith('+')) nParts.push({ kind: 'add', text: l.slice(1) });
    }
    return { anchor: ch.anchor, oLines, nParts, endOfFile: ch.endOfFile };
  });
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let model = splitFile(cur);
    let cursor = 0;
    for (const ch of ready) {
      const r = applyV4aChunk(model, ch, cursor, strict, path);
      model = r.model;
      cursor = r.cursor;
    }
    const text = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.trim() === '*** End Patch') break;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i += 1;
      const fileLines: string[] = [];
      while (i < last) {
        const c = lines[i]!;
        if (isSectionStart(c) || c.trim() === '*** End Patch') break;
        if (blank(c)) {
          fileLines.push('');
          i += 1;
          continue;
        }
        if (c.startsWith('+')) {
          fileLines.push(c.slice(1));
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last) {
        const c = lines[i]!;
        if (blank(c)) {
          i += 1;
          continue;
        }
        if (isSectionStart(c) || c.trim() === '*** End Patch') break;
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      let betweenChunks = false;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const c = lines[i]!;
        if (isSectionStart(c) || c.trim() === '*** End Patch') break;
        if (c.startsWith('@@')) {
          closeChunk();
          const anchor = c.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, rawBody: [], endOfFile: false };
          firstChunk = false;
          betweenChunks = false;
          i += 1;
          continue;
        }
        if (c.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.endOfFile = true;
          closeChunk();
          betweenChunks = true;
          i += 1;
          continue;
        }
        if (blank(c)) {
          if (cur !== null) {
            cur.rawBody.push(c);
            i += 1;
            continue;
          }
          if (betweenChunks) {
            i += 1;
            continue;
          }
          if (firstChunk) {
            cur = { anchor: null, rawBody: [c], endOfFile: false };
            firstChunk = false;
            i += 1;
            continue;
          }
          throw new Exit2(`error: parse ${i + 1}`);
        }
        if (c.startsWith(' ') || c.startsWith('-') || c.startsWith('+')) {
          if (betweenChunks) throw new Exit2(`error: parse ${i + 1}`);
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, rawBody: [], endOfFile: false };
            firstChunk = false;
          }
          cur.rawBody.push(c);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const openAtEnd = cur !== null;
      closeChunk();
      // Blank lines at the end of a section are not part of it: drop them from the last chunk, unless
      // that chunk was already closed by `*** End of File`.
      const lastChunk = chunks[chunks.length - 1];
      if (openAtEnd && lastChunk !== undefined) {
        while (lastChunk.rawBody.length > 0 && blank(lastChunk.rawBody[lastChunk.rawBody.length - 1]!)) {
          lastChunk.rawBody.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move edit's pair is reported as one `R` row when the old path existed before the patch and does
  // not after it, and the new path did not exist before it and does after it; the row sorts by <new>.
  const movePairs: Array<{ old: string; new: string }> = [];
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      movePairs.push(m);
    }
  }
  const covered = new Set<string>();
  for (const m of movePairs) {
    covered.add(m.old);
    covered.add(m.new);
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of movePairs) rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
