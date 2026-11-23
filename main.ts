// main.ts is mend, the CLI SPEC.md specifies. It applies AI-written edits in four
// formats (unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON text-editor calls)
// to a tree of text files, finding the lines each edit names at the first of three
// matching tiers, and writing every change or none. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

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
  /** Successful moves, old path -> new path, with chains collapsed to their first old path. */
  readonly moves = new Map<string, string>();
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
  recordMove(oldP: string, newP: string): void {
    for (const [k, v] of this.moves) {
      if (v === oldP) this.moves.set(k, newP);
    }
    this.moves.set(oldP, newP);
  }
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

/* ---- Section 5: the file's lines and the three matching tiers ---- */

/** A file split into lines, remembering its own line break and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  ends: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.ends ? m.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** A line normalised for one matching tier: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

interface Found {
  tier: number;
  occs: number[];
}

/** All starts at or after `from` where O matches, at the first tier with any (tier 0 only when strict). */
function findOcc(lines: string[], oldLines: string[], strict: boolean, from: number): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occs: number[] = [];
    const last = lines.length - oldLines.length;
    for (let i = Math.max(0, from); i <= last; i++) {
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (normLine(lines[i + j]!, tier) !== normLine(oldLines[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) occs.push(i);
    }
    if (occs.length > 0) return { tier, occs };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line, never the patch's. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Build the lines that replace the k matched lines at `at`, applying the tier-2 re-indent rule. */
function buildNewLines(fileLines: string[], at: number, oldLines: string[], newLines: NewLine[], tier: number): string[] {
  const out: string[] = [];
  const firstFile = fileLines[at] ?? '';
  const f = leadingWs(firstFile);
  const p = leadingWs(oldLines[0] ?? '');
  for (const nl of newLines) {
    if (nl.ctx) {
      out.push(fileLines[at + nl.oIdx]!);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/* ---- Section 6: unified diffs ---- */

interface Hunk {
  /** Old start line A from `@@ -A[,B] +C[,D] @@` (1-based). */
  a: number;
  o: string[];
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noEolPlus: boolean;
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  headOld: string | null | undefined;
  headNew: string | null | undefined;
  hasHead: boolean;
  renOld: string | null;
  renNew: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function newSection(diffOld: string | null = null, diffNew: string | null = null): Section {
  return { diffOld, diffNew, headOld: undefined, headNew: undefined, hasHead: false, renOld: null, renNew: null, isNew: false, isDel: false, hunks: [] };
}

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, spaces removed, `/dev/null` is no file. */
function cleanPath(s: string): string | null {
  let t = s.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

const DIFF_GIT = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!);
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = cleanPath(l.slice(4));
      const newP = cleanPath(lines[i + 1]!.slice(4));
      if (cur !== null && !cur.hasHead && cur.hunks.length === 0) {
        cur.headOld = oldP;
        cur.headNew = newP;
        cur.hasHead = true;
      } else {
        cur = newSection();
        cur.headOld = oldP;
        cur.headNew = newP;
        cur.hasHead = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      // A `--- ` line not followed by `+++ `, inside a section's header, names the line after it.
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (cur === null || m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const b = lines[j]!;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      let lastCP = -1;
      let lastPlus = -1;
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('+')) lastCP = k;
        if (bl.startsWith('+')) lastPlus = k;
      }
      const o: string[] = [];
      const nn: NewLine[] = [];
      for (const bl of body) {
        if (bl.startsWith('\\')) continue;
        if (bl === '' || bl.startsWith(' ')) {
          const t = bl === '' ? '' : bl.slice(1);
          o.push(t);
          nn.push({ text: t, ctx: true, oIdx: o.length - 1 });
        } else if (bl.startsWith('-')) {
          o.push(bl.slice(1));
        } else if (bl.startsWith('+')) {
          nn.push({ text: bl.slice(1), ctx: false, oIdx: -1 });
        }
      }
      cur.hunks.push({
        a: parseInt(m[1]!, 10),
        o,
        n: nn,
        noEol: lastCP >= 0 && lastCP + 1 < body.length && body[lastCP + 1]!.startsWith('\\'),
        noEolPlus: lastPlus >= 0 && lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\'),
      });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.renOld = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renNew = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.isNew = true;
      else if (l.startsWith('deleted file mode')) cur.isDel = true;
    }
    i++;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

/** Apply one hunk of a change or move to the file model, tracking the line drift `d` outside. */
function applyHunk(model: FileModel, h: Hunk, d: number, strict: boolean, path: string): void {
  if (h.o.length === 0) {
    const at = Math.max(0, Math.min(h.a + d, model.lines.length));
    const atEnd = at === model.lines.length;
    model.lines.splice(at, 0, ...h.n.map((e) => e.text));
    if (atEnd) model.ends = !h.noEol;
    return;
  }
  const found = findOcc(model.lines, h.o, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occs[0]!;
  let bestDist = Math.abs(best - target);
  for (const o of found.occs) {
    const dist = Math.abs(o - target);
    if (dist < bestDist) {
      best = o;
      bestDist = dist;
    }
  }
  const oldLen = model.lines.length;
  const built = buildNewLines(model.lines, best, h.o, h.n, found.tier);
  model.lines.splice(best, h.o.length, ...built);
  if (best + h.o.length === oldLen) model.ends = !h.noEol;
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.headOld !== undefined ? sec.headOld : (sec.renOld ?? sec.diffOld);
  const newPath = sec.headNew !== undefined ? sec.headNew : (sec.renNew ?? sec.diffNew);
  if (sec.isNew || oldPath === null) {
    // Creation: the new path must not exist; the file is the `+` lines of all hunks.
    const np = newPath ?? '';
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const e of h.n) if (!e.ctx) plus.push(e.text);
      }
      // Only the `\` after the section's very last `+` line counts.
      let noEol = false;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        if (sec.hunks[k]!.n.some((e) => !e.ctx)) {
          noEol = sec.hunks[k]!.noEolPlus;
          break;
        }
      }
      tree.now.set(np, renderFile({ lines: plus, br: '\n', ends: plus.length > 0 && !noEol }));
    };
  }
  if (sec.isDel || newPath === null) {
    const op = oldPath ?? '';
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  const op = oldPath!;
  const np = newPath!;
  const isMove = op !== np;
  return (tree) => {
    if (!safe(op)) throw new Fail('unsafe', op);
    if (isMove && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const model = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      applyHunk(model, h, d, strict, op);
      d += h.n.length - h.o.length;
    }
    const out = renderFile(model);
    if (isMove) {
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.recordMove(op, np);
    } else {
      tree.now.set(op, out);
    }
  };
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let j = s + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new Exit2(`error: parse ${s + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let p = s - 1; p >= prevEnd; p--) {
      const t = lines[p]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(s + 1, j);
    const newLines = lines.slice(j + 1, k);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, renderFile({ lines: [...newLines], br: '\n', ends: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = findOcc(model.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occs.length > 1) throw new Fail('ambiguous', path);
    const at = found.occs[0]!;
    const nl: NewLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const built = buildNewLines(model.lines, at, oldLines, nl, found.tier);
    model.lines.splice(at, oldLines.length, ...built);
    tree.now.set(path, renderFile(model));
  };
}

/* ---- Section 8: V4A patches ---- */

interface Chunk {
  /** Null means no anchor (an `@@` line with empty text, or a chunk that starts at a body line). */
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function isV4aSectionStart(l: string): boolean {
  return l.startsWith(V4A_ADD) || l === '*** Add File:' || l.startsWith(V4A_DEL) || l === '*** Delete File:' || l.startsWith(V4A_UPD) || l === '*** Update File:';
}

function v4aPath(l: string, prefix: string, bare: string): string {
  if (l === bare) return '';
  return l.slice(prefix.length).trim();
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith(V4A_ADD) || l === '*** Add File:') {
      const path = v4aPath(l, V4A_ADD, '*** Add File:');
      const collected: { t: string; blankLine: boolean }[] = [];
      let j = i + 1;
      while (j < last && !isV4aSectionStart(lines[j]!)) {
        const bl = lines[j]!;
        if (bl.startsWith('+')) collected.push({ t: bl.slice(1), blankLine: false });
        else if (blank(bl)) collected.push({ t: '', blankLine: true });
        else throw new Exit2(`error: parse ${j + 1}`);
        j++;
      }
      while (collected.length > 0 && collected[collected.length - 1]!.blankLine) collected.pop();
      const fileLines = collected.map((c) => c.t);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, renderFile({ lines: fileLines, br: '\n', ends: fileLines.length > 0 }));
      });
      i = j;
      continue;
    }
    if (l.startsWith(V4A_DEL) || l === '*** Delete File:') {
      const path = v4aPath(l, V4A_DEL, '*** Delete File:');
      let j = i + 1;
      while (j < last && blank(lines[j]!)) j++;
      if (j < last && !isV4aSectionStart(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = j;
      continue;
    }
    if (l.startsWith(V4A_UPD) || l === '*** Update File:') {
      const path = v4aPath(l, V4A_UPD, '*** Update File:');
      const updLine = i + 1;
      let j = i + 1;
      while (j < last && blank(lines[j]!)) j++;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith(V4A_MOVE)) {
        moveTo = lines[j]!.slice(V4A_MOVE.length).trim();
        j++;
        while (j < last && blank(lines[j]!)) j++;
      }
      const chunks: Chunk[] = [];
      let curChunk: Chunk | null = null;
      let afterEof = false;
      const closeChunk = (): void => {
        if (curChunk !== null) {
          chunks.push(curChunk);
          curChunk = null;
        }
      };
      while (j < last && !isV4aSectionStart(lines[j]!)) {
        const bl = lines[j]!;
        if (bl.trim() === '*** End of File') {
          if (curChunk === null) curChunk = { anchor: null, o: [], n: [], eof: true };
          else curChunk.eof = true;
          closeChunk();
          afterEof = true;
          j++;
          while (j < last && blank(lines[j]!)) j++;
          continue;
        }
        if (bl.startsWith('@@')) {
          closeChunk();
          afterEof = false;
          const a = bl.slice(2).trim();
          curChunk = { anchor: a === '' ? null : a, o: [], n: [], eof: false };
          j++;
          continue;
        }
        if (afterEof) throw new Exit2(`error: parse ${j + 1}`);
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (curChunk === null) curChunk = { anchor: null, o: [], n: [], eof: false };
          if (bl === '' || bl.startsWith(' ')) {
            const t = bl === '' ? '' : bl.slice(1);
            curChunk.o.push(t);
            curChunk.n.push({ text: t, ctx: true, oIdx: curChunk.o.length - 1 });
          } else if (bl.startsWith('-')) {
            curChunk.o.push(bl.slice(1));
          } else {
            curChunk.n.push({ text: bl.slice(1), ctx: false, oIdx: -1 });
          }
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      closeChunk();
      // Blank lines at the end of a section are not part of it: drop trailing blank
      // context lines (patch lines that were blank) from the last chunk.
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk !== undefined) {
        while (lastChunk.o.length > 0) {
          const oi = lastChunk.o.length - 1;
          if (lastChunk.o[oi] !== '') break;
          const ni = lastChunk.n.findIndex((e) => e.ctx && e.oIdx === oi);
          if (ni < 0 || lastChunk.n[ni]!.text !== '') break;
          // Only drop it when it is the last line of both O and N.
          if (ni !== lastChunk.n.length - 1) break;
          lastChunk.o.pop();
          lastChunk.n.splice(ni, 1);
          for (const e of lastChunk.n) if (e.ctx && e.oIdx > oi) e.oIdx--;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const f = findOcc(model.lines, [ch.anchor], strict, cursor);
        if (f === null) throw new Fail('no-match', path);
        cursor = f.occs[0]! + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? model.lines.length : cursor;
        const texts = ch.n.map((e) => e.text);
        model.lines.splice(at, 0, ...texts);
        cursor = at + texts.length;
        continue;
      }
      const found = findOcc(model.lines, ch.o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let at = -1;
      for (const o of found.occs) {
        if (ch.eof && o + ch.o.length !== model.lines.length) continue;
        at = o;
        break;
      }
      if (at < 0) throw new Fail('no-match', path);
      const built = buildNewLines(model.lines, at, ch.o, ch.n, found.tier);
      model.lines.splice(at, ch.o.length, ...built);
      cursor = at + built.length;
    }
    const out = renderFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ---- Section 10: order, atomicity, output ---- */

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Change rows, in byte order of the paths (a move row sorts by its new path).
  const rows: { key: string; row: string }[] = [];
  const rPairs: { oldP: string; newP: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.get(oldP) === null && tree.get(newP) !== null) {
      rPairs.push({ oldP, newP });
    }
  }
  const rOlds = new Set(rPairs.map((p) => p.oldP));
  const rNews = new Set(rPairs.map((p) => p.newP));
  for (const p of rPairs) rows.push({ key: p.newP, row: `R ${p.oldP} -> ${p.newP}` });
  for (const p of [...tree.now.keys()]) {
    if (rOlds.has(p) || rNews.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.row);
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
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
