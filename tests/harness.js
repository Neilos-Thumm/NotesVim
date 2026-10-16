// Loads Obsidian's Vim engine and the Notes adapter into a fresh sandbox with a
// fake "Notes" text view, so the adapter can be tested without a Mac.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RES = path.join(__dirname, '..', 'Resources');

function createNotes(initialText, caret) {
  const notes = {
    text: initialText,
    start: caret || 0,
    length: 0,
    history: [],
    future: [],
    elementChanged: false,
    log: [],
    prompt: null,
    notifications: [],
    mode: null,
    timers: [],
    clipboard: '',
    selectCalls: 0,
    snapshot() { return { text: this.text, start: this.start, length: this.length }; },
    restore(s) { this.text = s.text; this.start = s.start; this.length = s.length; },
  };

  const native = {
    read() {
      const changed = notes.elementChanged;
      notes.elementChanged = false;
      return { text: notes.text, start: notes.start, length: notes.length, elementChanged: changed };
    },
    select(start, length) {
      notes.selectCalls++;
      notes.start = start;
      notes.length = length;
      return true;
    },
    replace(start, length, text) {
      notes.history.push(notes.snapshot());
      notes.future = [];
      notes.text = notes.text.slice(0, start) + text + notes.text.slice(start + length);
      notes.start = start + text.length;
      notes.length = 0;
      return true;
    },
    undo() {
      const prev = notes.history.pop();
      if (!prev) return true;
      notes.future.push(notes.snapshot());
      notes.restore(prev);
      return true;
    },
    redo() {
      const next = notes.future.pop();
      if (!next) return true;
      notes.history.push(notes.snapshot());
      notes.restore(next);
      return true;
    },
    visibleRange() { return { start: 0, length: notes.text.length }; },
    scrollTo() { return true; },
    setMode(m) { notes.mode = m; },
    notify(text) { notes.notifications.push(text); },
    openPrompt(prefix, desc, value) { notes.prompt = { prefix, desc, value }; },
    closePrompt() { notes.prompt = null; },
    clipboardRead() { return notes.clipboard; },
    clipboardWrite(t) { notes.clipboard = t; },
    setTimer(id, ms) { notes.timers.push({ id, ms }); },
    log(t) { notes.log.push(t); },
  };

  const sandbox = { native, Promise };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const vimSource = fs.readFileSync(path.join(RES, 'vim.js'), 'utf8')
    .replace(/^export function initVim/m, 'function initVim');
  vm.runInContext(vimSource, sandbox, { filename: 'vim.js' });
  vm.runInContext(fs.readFileSync(path.join(RES, 'notes-adapter.js'), 'utf8'), sandbox, { filename: 'notes-adapter.js' });

  const NotesVim = sandbox.NotesVim;
  return { notes, native, NotesVim, sandbox };
}

// Turn "dw", "ciwfoo<Esc>", "<C-v>j", "<CR>" into key events like the Swift
// event tap produces.
function parseKeys(seq) {
  const out = [];
  let i = 0;
  while (i < seq.length) {
    if (seq[i] === '<') {
      const end = seq.indexOf('>', i);
      if (end > i + 1) {
        out.push(seq.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    out.push(seq[i]);
    i++;
  }
  return out;
}

const special = { '<Esc>': 'Escape', '<CR>': 'Enter', '<BS>': 'Backspace', '<Del>': 'Delete', '<Tab>': 'Tab',
  '<Left>': 'ArrowLeft', '<Right>': 'ArrowRight', '<Up>': 'ArrowUp', '<Down>': 'ArrowDown' };

function eventFor(token) {
  const e = { key: token, code: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
  if (special[token]) { e.key = special[token]; return e; }
  const m = /^<C-(.)>$/.exec(token);
  if (m) { e.key = m[1]; e.ctrlKey = true; return e; }
  if (token.length === 1 && token !== token.toLowerCase()) e.shiftKey = true;
  return e;
}

// Press keys. Keys Vim doesn't take behave like typing into Notes.
function press(ctx, seq) {
  const { notes, NotesVim } = ctx;
  for (const token of parseKeys(seq)) {
    const e = eventFor(token);
    const consumed = NotesVim.handleKey(e);
    if (consumed) continue;
    // Notes handles it itself.
    const s = notes.start;
    const l = notes.length;
    let insert = null;
    if (e.key === 'Enter') insert = '\n';
    else if (e.key === 'Tab') insert = '\t';
    else if (e.key.length === 1 && !e.ctrlKey) insert = e.key;
    if (insert !== null) {
      notes.history.push(notes.snapshot());
      notes.text = notes.text.slice(0, s) + insert + notes.text.slice(s + l);
      notes.start = s + insert.length;
      notes.length = 0;
    } else if (e.key === 'Backspace') {
      if (l > 0) {
        notes.text = notes.text.slice(0, s) + notes.text.slice(s + l);
      } else if (s > 0) {
        notes.text = notes.text.slice(0, s - 1) + notes.text.slice(s);
        notes.start = s - 1;
      }
      notes.length = 0;
    } else if (e.key === 'ArrowLeft') {
      notes.start = Math.max(0, s - 1); notes.length = 0;
    } else if (e.key === 'ArrowRight') {
      notes.start = Math.min(notes.text.length, s + l + 1); notes.length = 0;
    }
  }
}

function submitPrompt(ctx, value) { ctx.NotesVim.promptSubmit(value); }

function flushTimers(ctx) {
  while (ctx.notes.timers.length) {
    const t = ctx.notes.timers.shift();
    ctx.NotesVim.fireTimer(t.id);
  }
}

module.exports = { createNotes, press, submitPrompt, flushTimers };
