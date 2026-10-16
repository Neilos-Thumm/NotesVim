/*
 * notes-adapter.js
 *
 * Connects Obsidian's Vim engine (@replit/codemirror-vim-core, Resources/vim.js)
 * to Apple Notes.
 *
 * The engine expects a CodeMirror-5-style editor. This file implements that
 * interface over a plain-text model of the current note, modelled closely on
 * the CodeMirror 6 adapter that Obsidian uses (codemirror-vim/src/cm_adapter.ts,
 * MIT). The model is kept in sync with Notes through a small `native` object
 * supplied by the host (the Swift app, or the Node test harness):
 *
 *   native.read()                 -> { text, start, length, elementChanged } | null
 *   native.select(start, length)  -> bool   set Notes' selection
 *   native.replace(start, length, text) -> bool   replace a range in Notes
 *   native.undo() / native.redo() -> bool   true if Notes has already applied it
 *   native.visibleRange()         -> { start, length } | null
 *   native.scrollTo(offset)       -> bool
 *   native.setMode(name)          -> void   e.g. "normal", "insert", "visual line"
 *   native.notify(text, ms)       -> void
 *   native.openPrompt(prefix, desc, value) -> void   result arrives via NotesVim.promptSubmit/promptCancel
 *   native.closePrompt()          -> void
 *   native.clipboardRead() -> string, native.clipboardWrite(text) -> void
 *   native.setTimer(id, ms)       -> void   host calls NotesVim.fireTimer(id) later
 *   native.log(text)              -> void
 *
 * All offsets are UTF-16 code units, which is what both JavaScript strings and
 * the macOS Accessibility API use.
 */
(function (global) {
  'use strict';

  var native = global.native;

  // ---------------------------------------------------------------------------
  // Browser shims. The engine was written for a browser; JavaScriptCore has no
  // window, document, timers or console.
  // ---------------------------------------------------------------------------
  if (typeof global.window === 'undefined') global.window = global;

  if (typeof global.console === 'undefined') {
    var log = function () {
      native.log(Array.prototype.map.call(arguments, String).join(' '));
    };
    global.console = { log: log, error: log, warn: log, info: log };
  }

  var timers = {};
  var nextTimerId = 1;
  if (!global.__hostTimers) {
    global.setTimeout = function (fn, ms) {
      var id = nextTimerId++;
      timers[id] = fn;
      native.setTimer(id, ms || 0);
      return id;
    };
    global.clearTimeout = function (id) {
      if (id) delete timers[id];
    };
  }

  function FakeNode(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.attributes = {};
    this.value = '';
    this.parentElement = null;
    this._listeners = {};
  }
  FakeNode.prototype.appendChild = function (child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  };
  FakeNode.prototype.setAttribute = function (k, v) { this.attributes[k] = v; };
  FakeNode.prototype.getAttribute = function (k) { return this.attributes[k]; };
  FakeNode.prototype.addEventListener = function (type, f) {
    (this._listeners[type] = this._listeners[type] || []).push(f);
  };
  FakeNode.prototype.removeEventListener = function (type, f) {
    var arr = this._listeners[type];
    if (!arr) return;
    var i = arr.indexOf(f);
    if (i > -1) arr.splice(i, 1);
  };
  FakeNode.prototype.dispatch = function (type, e) {
    var arr = (this._listeners[type] || []).slice();
    for (var i = 0; i < arr.length; i++) arr[i](e);
  };
  FakeNode.prototype.getElementsByTagName = function (tag) {
    var out = [];
    var want = String(tag).toUpperCase();
    (function walk(n) {
      for (var i = 0; i < n.children.length; i++) {
        var c = n.children[i];
        if (c.nodeType !== 1) continue;
        if (c.tagName === want) out.push(c);
        walk(c);
      }
    })(this);
    return out;
  };
  FakeNode.prototype.remove = function () {};
  FakeNode.prototype.focus = function () {};
  FakeNode.prototype.blur = function () {};
  FakeNode.prototype.select = function () {};
  FakeNode.prototype.contains = function () { return false; };
  Object.defineProperty(FakeNode.prototype, 'textContent', {
    get: function () {
      return this.children.map(function (c) { return c.textContent; }).join('');
    },
    set: function (v) {
      this.children = [{ nodeType: 3, textContent: String(v) }];
    }
  });
  Object.defineProperty(FakeNode.prototype, 'innerText', {
    get: function () { return this.textContent; }
  });

  if (typeof global.document === 'undefined') {
    global.document = {
      createElement: function (tag) { return new FakeNode(tag); },
      createTextNode: function (text) { return { nodeType: 3, textContent: String(text) }; },
      activeElement: null
    };
  }

  if (typeof global.navigator === 'undefined') {
    global.navigator = { platform: 'MacIntel', userAgent: 'NotesVim' };
  }
  if (!global.navigator.clipboard) {
    global.navigator.clipboard = {
      writeText: function (text) {
        native.clipboardWrite(String(text));
        return Promise.resolve();
      },
      readText: function () {
        return Promise.resolve(native.clipboardRead() || '');
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Text model
  // ---------------------------------------------------------------------------
  function Pos(line, ch, sticky) {
    this.line = line;
    this.ch = ch;
    if (sticky) this.sticky = sticky;
  }

  function Doc(text) { this.set(text); }
  Doc.prototype.set = function (text) {
    this.text = text;
    var starts = [0];
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.starts = starts;
  };
  Doc.prototype.lines = function () { return this.starts.length; };
  Doc.prototype.lineFrom = function (row) { return this.starts[row]; };
  Doc.prototype.lineTo = function (row) {
    return row + 1 < this.starts.length ? this.starts[row + 1] - 1 : this.text.length;
  };
  Doc.prototype.lineText = function (row) {
    return this.text.slice(this.lineFrom(row), this.lineTo(row));
  };
  // Same clamping rules as the CodeMirror 6 adapter's indexFromPos.
  Doc.prototype.indexFromPos = function (pos) {
    var ch = pos.ch;
    var row = pos.line;
    if (row < 0) { row = 0; ch = 0; }
    if (row >= this.starts.length) { row = this.starts.length - 1; ch = Number.MAX_VALUE; }
    var from = this.lineFrom(row);
    var to = this.lineTo(row);
    return Math.min(from + Math.max(0, ch || 0), to);
  };
  Doc.prototype.posFromIndex = function (offset) {
    offset = Math.max(0, Math.min(offset, this.text.length));
    var lo = 0;
    var hi = this.starts.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return new Pos(lo, offset - this.starts[lo]);
  };

  // Map a position through one change (CodeMirror 6 semantics).
  // trackDel: return null when the position was inside deleted text.
  function mapPos(pos, change, assoc, trackDel) {
    var from = change.from;
    var to = change.to;
    var len = change.insert.length;
    if (pos < from) return pos;
    if (pos > to) return pos + len - (to - from);
    if (trackDel && from < pos && pos < to) return null;
    var side = to === from ? assoc : pos === from ? -1 : pos === to ? 1 : assoc;
    return side < 0 ? from : from + len;
  }

  // Changes are given in coordinates of the document before the edit; apply
  // the highest one first so earlier offsets stay valid.
  function sortChangesDescending(changes) {
    return changes.slice().sort(function (a, b) { return b.from - a.from; });
  }

  function mapThrough(pos, changesDesc, assoc, trackDel) {
    for (var i = 0; i < changesDesc.length; i++) {
      if (pos === null) return null;
      pos = mapPos(pos, changesDesc[i], assoc, trackDel);
    }
    return pos;
  }

  // ---------------------------------------------------------------------------
  // Events (same helpers as the CodeMirror 6 adapter)
  // ---------------------------------------------------------------------------
  function on(emitter, type, f) {
    if (emitter.addEventListener) {
      emitter.addEventListener(type, f, false);
    } else {
      var map = emitter._handlers || (emitter._handlers = {});
      map[type] = (map[type] || []).concat(f);
    }
  }
  function off(emitter, type, f) {
    if (emitter.removeEventListener) {
      emitter.removeEventListener(type, f, false);
    } else {
      var map = emitter._handlers;
      var arr = map && map[type];
      if (arr) {
        var index = arr.indexOf(f);
        if (index > -1) map[type] = arr.slice(0, index).concat(arr.slice(index + 1));
      }
    }
  }
  function signal(emitter, type) {
    var handlers = emitter._handlers && emitter._handlers[type];
    if (!handlers) return;
    var args = Array.prototype.slice.call(arguments, 2);
    handlers = handlers.slice();
    for (var i = 0; i < handlers.length; ++i) handlers[i].apply(null, args);
  }
  function signalTo(handlers) {
    if (!handlers) return;
    var args = Array.prototype.slice.call(arguments, 1);
    for (var i = 0; i < handlers.length; ++i) handlers[i].apply(null, args);
  }

  var wordChar;
  try {
    wordChar = new RegExp('[\\w\\p{Alphabetic}\\p{Number}_]', 'u');
  } catch (_) {
    wordChar = /[\w]/;
  }

  // ---------------------------------------------------------------------------
  // CodeMirror 5 StringStream (used by the engine's ex-command parser)
  // ---------------------------------------------------------------------------
  function countColumn(string, end, tabSize) {
    if (end == null) end = string.length;
    var n = 0;
    for (var i = 0; i < end; i++) {
      if (string.charAt(i) === '\t') n += tabSize - (n % tabSize);
      else n++;
    }
    return n;
  }
  function StringStream(string, tabSize) {
    this.pos = this.start = 0;
    this.string = string;
    this.tabSize = tabSize || 8;
    this.lineStart = 0;
  }
  StringStream.prototype = {
    eol: function () { return this.pos >= this.string.length; },
    sol: function () { return this.pos === this.lineStart; },
    peek: function () { return this.string.charAt(this.pos) || undefined; },
    next: function () {
      if (this.pos < this.string.length) return this.string.charAt(this.pos++);
    },
    eat: function (match) {
      var ch = this.string.charAt(this.pos);
      var ok;
      if (typeof match === 'string') ok = ch === match;
      else ok = ch && (match.test ? match.test(ch) : match(ch));
      if (ok) { ++this.pos; return ch; }
    },
    eatWhile: function (match) {
      var start = this.pos;
      while (this.eat(match)) { /* keep eating */ }
      return this.pos > start;
    },
    eatSpace: function () {
      var start = this.pos;
      while (/[\s ]/.test(this.string.charAt(this.pos))) ++this.pos;
      return this.pos > start;
    },
    skipToEnd: function () { this.pos = this.string.length; },
    skipTo: function (ch) {
      var found = this.string.indexOf(ch, this.pos);
      if (found > -1) { this.pos = found; return true; }
    },
    backUp: function (n) { this.pos -= n; },
    column: function () { return countColumn(this.string, this.start, this.tabSize); },
    indentation: function () { return countColumn(this.string, null, this.tabSize); },
    match: function (pattern, consume, caseInsensitive) {
      if (typeof pattern === 'string') {
        var cased = function (str) { return caseInsensitive ? str.toLowerCase() : str; };
        var substr = this.string.substr(this.pos, pattern.length);
        if (cased(substr) === cased(pattern)) {
          if (consume !== false) this.pos += pattern.length;
          return true;
        }
      } else {
        var match = this.string.slice(this.pos).match(pattern);
        if (match && match.index > 0) return null;
        if (match && consume !== false) this.pos += match[0].length;
        return match;
      }
    },
    current: function () { return this.string.slice(this.start, this.pos); }
  };

  // ---------------------------------------------------------------------------
  // Marker (bookmarks, marks, insert-end tracking)
  // ---------------------------------------------------------------------------
  function Marker(cm, offset, assoc) {
    this.cm = cm;
    this.id = cm.$mid++;
    this.offset = offset;
    this.assoc = assoc;
    cm.marks[this.id] = this;
  }
  Marker.prototype.clear = function () { delete this.cm.marks[this.id]; };
  Marker.prototype.find = function () {
    if (this.offset == null) return null;
    return this.cm.posFromIndex(this.offset);
  };
  Marker.prototype.update = function (changesDesc) {
    if (this.offset != null) this.offset = mapThrough(this.offset, changesDesc, this.assoc, true);
  };

  // ---------------------------------------------------------------------------
  // Brackets and hard wrap (ported from the CodeMirror 6 adapter)
  // ---------------------------------------------------------------------------
  var matching = { '(': ')>', ')': '(<', '[': ']>', ']': '[<', '{': '}>', '}': '{<', '<': '>>', '>': '<<' };

  function bracketRegex(config) {
    return (config && config.bracketRegex) || /[(){}[\]]/;
  }

  function scanForBracket(cm, where, dir, style, config) {
    var maxScanLen = (config && config.maxScanLineLength) || 10000;
    var maxScanLines = (config && config.maxScanLines) || 1000;
    var stack = [];
    var re = bracketRegex(config);
    var lineEnd = dir > 0 ? Math.min(where.line + maxScanLines, cm.lastLine() + 1)
      : Math.max(cm.firstLine() - 1, where.line - maxScanLines);
    for (var lineNo = where.line; lineNo != lineEnd; lineNo += dir) {
      var line = cm.getLine(lineNo);
      if (!line) continue;
      var pos = dir > 0 ? 0 : line.length - 1;
      var end = dir > 0 ? line.length : -1;
      if (line.length > maxScanLen) continue;
      if (lineNo == where.line) pos = where.ch - (dir < 0 ? 1 : 0);
      for (; pos != end; pos += dir) {
        var ch = line.charAt(pos);
        if (re.test(ch)) {
          var match = matching[ch];
          if (match && (match.charAt(1) == '>') == (dir > 0)) stack.push(ch);
          else if (!stack.length) return { pos: new Pos(lineNo, pos), ch: ch };
          else stack.pop();
        }
      }
    }
    return lineNo - dir == (dir > 0 ? cm.lastLine() : cm.firstLine()) ? false : null;
  }

  function hardWrap(cm, options) {
    var max = options.column || cm.getOption('textwidth') || 80;
    var allowMerge = options.allowMerge != false;
    var row = Math.min(options.from, options.to);
    var endRow = Math.max(options.from, options.to);
    while (row <= endRow) {
      var line = cm.getLine(row);
      if (line.length > max) {
        var space = findSpace(line, max, 5);
        if (space) {
          var indentation = /^\s*/.exec(line)[0];
          cm.replaceRange('\n' + indentation, new Pos(row, space.start), new Pos(row, space.end));
        }
        endRow++;
      } else if (allowMerge && /\S/.test(line) && row != endRow) {
        var nextLine = cm.getLine(row + 1);
        if (nextLine && /\S/.test(nextLine)) {
          var trimmedLine = line.replace(/\s+$/, '');
          var trimmedNextLine = nextLine.replace(/^\s+/, '');
          var mergedLine = trimmedLine + ' ' + trimmedNextLine;
          var space2 = findSpace(mergedLine, max, 5);
          if ((space2 && space2.start > trimmedLine.length) || mergedLine.length < max) {
            cm.replaceRange(' ', new Pos(row, trimmedLine.length),
              new Pos(row + 1, nextLine.length - trimmedNextLine.length));
            row--;
            endRow--;
          } else if (trimmedLine.length < line.length) {
            cm.replaceRange('', new Pos(row, trimmedLine.length), new Pos(row, line.length));
          }
        }
      }
      row++;
    }
    return row;

    function findSpace(line, max, min) {
      if (line.length < max) return;
      var before = line.slice(0, max);
      var after = line.slice(max);
      var spaceAfter = /^(?:(\s+)|(\S+)(\s+))/.exec(after);
      var spaceBefore = /(?:(\s+)|(\s+)(\S+))$/.exec(before);
      var start = 0;
      var end = 0;
      if (spaceBefore && !spaceBefore[2]) {
        start = max - spaceBefore[1].length;
        end = max;
      }
      if (spaceAfter && !spaceAfter[2]) {
        if (!start) start = max;
        end = max + spaceAfter[1].length;
      }
      if (start) return { start: start, end: end };
      if (spaceBefore && spaceBefore[2] && spaceBefore.index > min) {
        return { start: spaceBefore.index, end: spaceBefore.index + spaceBefore[2].length };
      }
      if (spaceAfter && spaceAfter[2]) {
        start = max + spaceAfter[2].length;
        return { start: start, end: start + spaceAfter[3].length };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The editor the engine talks to
  // ---------------------------------------------------------------------------
  var LINE_HEIGHT = 20; // virtual units for charCoords/scrollInfo; Notes has no fixed grid
  var CHAR_WIDTH = 8;

  function NotesCM() {
    this.state = {};
    this.marks = Object.create(null);
    this.$mid = 0;
    this.curOp = null;
    this.options = {};
    this._handlers = {};
    this.doc = new Doc('');
    this.ranges = [{ anchor: 0, head: 0 }];
    this.primIndex = 0;
    this.$lastChangeEndOffset = 0;
    this.$lineHandleChanges = undefined;
    this.virtualSelection = null;
    this._inputField = new FakeNode('textarea');
    this._wrapper = new FakeNode('div');
    // Host-sync bookkeeping
    this._lastPushed = null;   // { start, length } we last put on screen
    this._skipPush = false;    // true when Notes still has to apply an async edit
  }

  NotesCM.isMac = true;
  NotesCM.Pos = Pos;
  NotesCM.StringStream = StringStream;
  NotesCM.isWordChar = function (ch) { return wordChar.test(ch); };
  NotesCM.addClass = function () {};
  NotesCM.rmClass = function () {};
  NotesCM.e_preventDefault = function (e) { if (e && e.preventDefault) e.preventDefault(); };
  NotesCM.e_stop = function (e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (e && e.preventDefault) e.preventDefault();
  };
  NotesCM.on = on;
  NotesCM.off = off;
  NotesCM.signal = signal;
  NotesCM.findMatchingTag = function () { return null; };
  NotesCM.findEnclosingTag = function () { return undefined; };
  NotesCM.keyName = undefined;

  NotesCM.commands = {
    cursorCharLeft: function (cm) { cm.moveH(-1, 'char'); },
    undo: function (cm) { cm._history(true); },
    redo: function (cm) { cm._history(false); },
    newlineAndIndent: function (cm) {
      // Keep the current line's leading whitespace, like CodeMirror does.
      var ranges = cm.ranges;
      var changes = ranges.map(function (r) {
        var from = Math.min(r.anchor, r.head);
        var to = Math.max(r.anchor, r.head);
        var row = cm.doc.posFromIndex(from).line;
        var indent = /^[ \t]*/.exec(cm.doc.lineText(row))[0];
        return { from: from, to: to, insert: '\n' + indent };
      });
      var after = changes.map(function (c) { return c.from + c.insert.length; });
      cm._dispatch(changes, after.map(function (o) { return { anchor: o, head: o }; }));
    },
    indentAuto: function () {},
    newlineAndIndentContinueComment: undefined,
    save: undefined
  };

  NotesCM.keys = {
    Left: function (cm) { cm.moveH(-1, 'char'); },
    Right: function (cm) { cm.moveH(1, 'char'); },
    Up: function (cm) { cm._moveV(-1); },
    Down: function (cm) { cm._moveV(1); },
    Backspace: function (cm) { cm._deleteChar(-1); },
    Delete: function (cm) { cm._deleteChar(1); }
  };
  NotesCM.lookupKey = function (key, map, handle) {
    var result = NotesCM.keys[key];
    if (!result && /^Arrow/.test(key)) result = NotesCM.keys[key.slice(5)];
    if (result) handle(result);
  };

  var P = NotesCM.prototype;

  P.on = function (type, f) { on(this, type, f); };
  P.off = function (type, f) { off(this, type, f); };
  P.signal = function (type, e, handlers) { signal(this, type, e, handlers); };

  // --- positions -------------------------------------------------------------
  P.indexFromPos = function (pos) { return this.doc.indexFromPos(pos); };
  P.posFromIndex = function (offset) { return this.doc.posFromIndex(offset); };
  P.firstLine = function () { return 0; };
  P.lastLine = function () { return this.doc.lines() - 1; };
  P.lineCount = function () { return this.doc.lines(); };
  P.getLine = function (row) {
    if (row < 0 || row >= this.doc.lines()) return '';
    return this.doc.lineText(row);
  };
  P.clipPos = function (p) {
    var ch = p.ch;
    var row = p.line;
    var lines = this.doc.lines();
    if (row < 0) { row = 0; ch = 0; }
    if (row >= lines) { row = lines - 1; ch = Number.MAX_VALUE; }
    var len = this.doc.lineTo(row) - this.doc.lineFrom(row);
    ch = Math.min(Math.max(0, ch), len);
    return new Pos(row, ch);
  };
  P.getValue = function () { return this.doc.text; };
  P.setValue = function (text) {
    this._dispatch([{ from: 0, to: this.doc.text.length, insert: text }], [{ anchor: 0, head: 0 }]);
  };
  P.getRange = function (s, e) {
    var a = this.indexFromPos(s);
    var b = this.indexFromPos(e);
    return this.doc.text.slice(Math.min(a, b), Math.max(a, b));
  };

  // --- selection -------------------------------------------------------------
  P._main = function () { return this.ranges[this.primIndex] || this.ranges[0]; };

  P.getCursor = function (p) {
    var sel = this._main();
    var offset;
    if (p == 'head' || !p) offset = sel.head;
    else if (p == 'anchor') offset = sel.anchor;
    else if (p == 'start') offset = Math.min(sel.anchor, sel.head);
    else if (p == 'end') offset = Math.max(sel.anchor, sel.head);
    else throw new Error('Invalid cursor type');
    return this.posFromIndex(offset);
  };
  P.setCursor = function (line, ch) {
    if (typeof line === 'object') { ch = line.ch; line = line.line; }
    var offset = this.indexFromPos({ line: line, ch: ch || 0 });
    this._dispatch(null, [{ anchor: offset, head: offset }]);
    if (this.curOp && !this.curOp.isVimOp) this.onBeforeEndOperation();
  };
  P.listSelections = function () {
    var doc = this.doc;
    return this.ranges.map(function (r) {
      return { anchor: doc.posFromIndex(r.anchor), head: doc.posFromIndex(r.head) };
    });
  };
  P.setSelections = function (p, primIndex) {
    var self = this;
    var ranges = p.map(function (x) {
      return { anchor: self.indexFromPos(x.anchor), head: self.indexFromPos(x.head) };
    });
    this._dispatch(null, ranges, primIndex);
  };
  P.setSelection = function (anchor, head, options) {
    this.setSelections([{ anchor: anchor, head: head }], 0);
    if (options && options.origin == '*mouse') this.onBeforeEndOperation();
  };
  P.getSelection = function () { return this.getSelections().join('\n'); };
  P.getSelections = function () {
    var text = this.doc.text;
    return this.ranges.map(function (r) {
      return text.slice(Math.min(r.anchor, r.head), Math.max(r.anchor, r.head));
    });
  };
  P.somethingSelected = function () {
    return this.ranges.some(function (r) { return r.anchor !== r.head; });
  };

  // --- editing ---------------------------------------------------------------
  P.replaceRange = function (text, s, e) {
    if (!e) e = s;
    var from = this.indexFromPos(s);
    var to = this.indexFromPos(e);
    if (from > to) { var t = from; from = to; to = t; }
    this._dispatch([{ from: from, to: to, insert: text }]);
  };
  P.replaceSelection = function (text) {
    // CodeMirror 6 replaceSelection: replace every range, cursor after the text.
    var changes = [];
    var after = [];
    var shift = 0;
    var sorted = this.ranges.map(function (r, i) { return { r: r, i: i }; })
      .sort(function (a, b) { return Math.min(a.r.anchor, a.r.head) - Math.min(b.r.anchor, b.r.head); });
    var newRanges = new Array(this.ranges.length);
    sorted.forEach(function (item) {
      var from = Math.min(item.r.anchor, item.r.head);
      var to = Math.max(item.r.anchor, item.r.head);
      changes.push({ from: from, to: to, insert: text });
      var pos = from + shift + text.length;
      newRanges[item.i] = { anchor: pos, head: pos };
      shift += text.length - (to - from);
    });
    this._dispatch(changes, newRanges, this.primIndex);
  };
  P.replaceSelections = function (replacements) {
    var changes = this.ranges.map(function (r, i) {
      return { from: Math.min(r.anchor, r.head), to: Math.max(r.anchor, r.head), insert: replacements[i] || '' };
    });
    this._dispatch(changes);
  };
  P.overWriteSelection = function (text) {
    var doc = this.doc.text;
    var ranges = this.ranges.map(function (x) {
      if (x.anchor === x.head) {
        var ch = x.head < doc.length ? doc.charAt(x.head) : '';
        if (ch && ch !== '\n') return { anchor: x.head, head: x.head + 1 };
      }
      return x;
    });
    this._dispatch(null, ranges, this.primIndex);
    this.replaceSelection(text);
  };
  P._deleteChar = function (dir) {
    var len = this.doc.text.length;
    var changes = [];
    this.ranges.forEach(function (r) {
      var from = Math.min(r.anchor, r.head);
      var to = Math.max(r.anchor, r.head);
      if (from === to) {
        if (dir < 0 && from > 0) from--;
        else if (dir > 0 && to < len) to++;
      }
      if (from !== to) changes.push({ from: from, to: to, insert: '' });
    });
    if (changes.length) this._dispatch(changes);
  };
  P._moveV = function (dir) {
    var cur = this.getCursor();
    this.setCursor(this.clipPos(new Pos(cur.line + dir, cur.ch)));
  };
  P.moveH = function (increment, unit) {
    if (unit == 'char') {
      var cur = this.getCursor();
      this.setCursor(cur.line, cur.ch + increment);
    }
  };

  // The single entry point for edits made by the engine. Applies the changes
  // to the local model, mirrors them into Notes, maps selections and marks,
  // and records the change exactly like the CodeMirror 6 adapter's onChange.
  P._dispatch = function (changes, newRanges, primIndex, fromHost) {
    var hadChanges = changes && changes.length;
    var selectionSet = !!newRanges;
    if (hadChanges) {
      var desc = sortChangesDescending(changes.filter(function (c) {
        return !(c.from === c.to && c.insert === '');
      }));
      if (desc.length) {
        var text = this.doc.text;
        for (var i = 0; i < desc.length; i++) {
          var c = desc[i];
          text = text.slice(0, c.from) + c.insert + text.slice(c.to);
          if (!fromHost) this._nativeReplace(c.from, c.to, c.insert);
        }
        this.doc.set(text);
        if (!newRanges) {
          this.ranges = this.ranges.map(function (r) {
            if (r.anchor === r.head) {
              var p = mapThrough(r.head, desc, -1);
              return { anchor: p, head: p };
            }
            var fwd = r.anchor <= r.head;
            var from = mapThrough(Math.min(r.anchor, r.head), desc, 1);
            var to = mapThrough(Math.max(r.anchor, r.head), desc, -1);
            if (to < from) to = from;
            return fwd ? { anchor: from, head: to } : { anchor: to, head: from };
          });
        }
        this._onChange(desc);
      }
    }
    if (newRanges) {
      var max = this.doc.text.length;
      this.ranges = newRanges.map(function (r) {
        return { anchor: Math.max(0, Math.min(r.anchor, max)), head: Math.max(0, Math.min(r.head, max)) };
      });
      this.primIndex = primIndex != null && primIndex < this.ranges.length ? primIndex : 0;
    }
    if (selectionSet) this.onSelectionChange();
    if (this.curOp && !this.curOp.isVimOp) this.onBeforeEndOperation();
  };

  P._nativeReplace = function (from, to, insert) {
    var ok = native.replace(from, to - from, insert);
    if (!ok) this._skipPush = true; // Notes will apply it asynchronously
  };

  P._onChange = function (desc) {
    if (this.$lineHandleChanges) this.$lineHandleChanges.push(desc);
    for (var id in this.marks) this.marks[id].update(desc);
    var curOp = this.curOp = this.curOp || { $d: 0 };
    // desc is highest-first; walk it lowest-first like iterChanges does.
    var shift = 0;
    for (var i = desc.length - 1; i >= 0; i--) {
      var c = desc[i];
      var fromB = c.from + shift;
      var toB = fromB + c.insert.length;
      shift += c.insert.length - (c.to - c.from);
      if (curOp.$changeStart == null || curOp.$changeStart > fromB) curOp.$changeStart = fromB;
      this.$lastChangeEndOffset = toB;
      var change = { text: c.insert.split('\n') };
      if (!curOp.lastChange) {
        curOp.lastChange = curOp.change = change;
      } else {
        curOp.lastChange.next = curOp.lastChange = change;
      }
    }
    if (!curOp.changeHandlers) {
      curOp.changeHandlers = this._handlers.change && this._handlers.change.slice();
    }
  };
  P.onSelectionChange = function () {
    var curOp = this.curOp = this.curOp || { $d: 0 };
    if (!curOp.cursorActivityHandlers) {
      curOp.cursorActivityHandlers = this._handlers.cursorActivity && this._handlers.cursorActivity.slice();
    }
    curOp.cursorActivity = true;
  };
  P.operation = function (fn) {
    if (!this.curOp) this.curOp = { $d: 0 };
    this.curOp.$d++;
    var result;
    try {
      result = fn();
    } finally {
      if (this.curOp) {
        this.curOp.$d--;
        if (!this.curOp.$d) this.onBeforeEndOperation();
      }
    }
    return result;
  };
  P.onBeforeEndOperation = function () {
    var op = this.curOp;
    var scrollIntoView = false;
    if (op) {
      if (op.change) signalTo(op.changeHandlers, this, op.change);
      if (op.cursorActivity) {
        signalTo(op.cursorActivityHandlers, this, null);
        if (op.isVimOp) scrollIntoView = true;
      }
      this.curOp = null;
    }
    if (scrollIntoView) this.scrollIntoView();
  };
  P.getLastEditEnd = function () { return this.posFromIndex(this.$lastChangeEndOffset); };

  P._history = function (isUndo) {
    if (this.curOp) this.curOp.$changeStart = undefined;
    var before = this.doc.text;
    var applied = isUndo ? native.undo() : native.redo();
    if (!applied) {
      // Notes will apply it after this key returns; don't fight it.
      this._skipPush = true;
      return;
    }
    this.sync();
    if (this.curOp) {
      // The engine expects the cursor at the start of what changed.
      var start = firstDifference(before, this.doc.text);
      if (start != null) this.curOp.$changeStart = start;
    }
    var changeStart = this.curOp && this.curOp.$changeStart;
    if (changeStart != null) {
      this._dispatch(null, [{ anchor: changeStart, head: changeStart }]);
    }
  };

  function firstDifference(a, b) {
    if (a === b) return null;
    var n = Math.min(a.length, b.length);
    var i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  }

  // --- line handles (used by :g) --------------------------------------------
  P.getLineHandle = function (row) {
    if (!this.$lineHandleChanges) this.$lineHandleChanges = [];
    return { row: row, index: this.indexFromPos(new Pos(row, 0)) };
  };
  P.getLineNumber = function (handle) {
    var updates = this.$lineHandleChanges;
    if (!updates) return null;
    var offset = handle.index;
    for (var i = 0; i < updates.length; i++) {
      offset = mapThrough(offset, updates[i], 1, true);
      if (offset == null) return null;
    }
    var pos = this.posFromIndex(offset);
    return pos.ch == 0 ? pos.line : null;
  };
  P.releaseLineHandles = function () { this.$lineHandleChanges = undefined; };

  // --- misc editor API -------------------------------------------------------
  P.getInputField = function () { return this._inputField; };
  P.getWrapperElement = function () { return this._wrapper; };
  P.focus = function () {};
  P.blur = function () {};
  P.refresh = function () {};
  P.destroy = function () {};
  P.foldCode = function () {};
  P.defaultTextHeight = function () { return LINE_HEIGHT; };
  P.getMode = function () { return { name: this.getOption('mode') }; };
  P.getTokenTypeAt = function () { return ''; };
  P.addOverlay = function (o) { return o; };
  P.removeOverlay = function () {};
  P.toggleOverwrite = function (onOff) { this.state.overwrite = onOff; };

  P.setOption = function (name, val) {
    if (name === 'keyMap') this.state.keyMap = val;
    else if (name === 'textwidth') this.state.textwidth = val;
    this.options[name] = val;
  };
  P.getOption = function (name) {
    switch (name) {
      case 'firstLineNumber': return 1;
      case 'tabSize': return 4;
      case 'readOnly': return false;
      case 'indentWithTabs': return true;
      case 'indentUnit': return 4;
      case 'textwidth': return this.state.textwidth;
      case 'keyMap': return this.state.keyMap || 'vim';
    }
    return this.options[name];
  };

  P.execCommand = function (name) {
    if (Object.prototype.hasOwnProperty.call(NotesCM.commands, name) && NotesCM.commands[name]) {
      NotesCM.commands[name](this);
    } else if (name == 'goLineLeft') {
      var cur = this.getCursor();
      this.setCursor(cur.line, 0);
    } else if (name == 'goLineRight') {
      var c2 = this.getCursor();
      var len = this.getLine(c2.line).length;
      this.setCursor(c2.line, Math.max(0, len - 1));
    } else {
      console.log(name + ' is not implemented');
    }
  };

  P.setBookmark = function (cursor, options) {
    var assoc = options && options.insertLeft ? 1 : -1;
    return new Marker(this, this.indexFromPos(cursor), assoc);
  };

  P.findMatchingBracket = function (pos) {
    var text = this.doc.text;
    var offset = this.indexFromPos(pos);
    var pairs = { '(': ')', '[': ']', '{': '}' };
    var reverse = { ')': '(', ']': '[', '}': '{' };
    var ch = text.charAt(offset);
    var open, close, dir;
    if (pairs[ch]) { open = ch; close = pairs[ch]; dir = 1; }
    else if (reverse[ch]) { open = ch; close = reverse[ch]; dir = -1; }
    else return { to: undefined };
    var depth = 0;
    for (var i = offset; i >= 0 && i < text.length; i += dir) {
      var c = text.charAt(i);
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return { to: this.posFromIndex(i) };
      }
    }
    return { to: undefined };
  };
  P.scanForBracket = function (pos, dir, style, config) {
    return scanForBracket(this, pos, dir, style, config);
  };

  // Indentation uses tabs, which is what the Tab key inserts in Notes.
  P.indentLine = function (line, more) {
    var text = this.getLine(line);
    if (more) {
      this.replaceRange('\t', new Pos(line, 0));
    } else {
      var m = /^(\t| {1,4})/.exec(text);
      if (m) this.replaceRange('', new Pos(line, 0), new Pos(line, m[0].length));
    }
  };
  P._selectedLines = function () {
    var seen = {};
    var rows = [];
    var doc = this.doc;
    this.ranges.forEach(function (r) {
      var a = doc.posFromIndex(Math.min(r.anchor, r.head)).line;
      var b = doc.posFromIndex(Math.max(r.anchor, r.head)).line;
      for (var i = a; i <= b; i++) if (!seen[i]) { seen[i] = true; rows.push(i); }
    });
    return rows.sort(function (x, y) { return y - x; });
  };
  P.indentMore = function () {
    var self = this;
    this.operation(function () {
      self._selectedLines().forEach(function (row) { self.indentLine(row, true); });
    });
  };
  P.indentLess = function () {
    var self = this;
    this.operation(function () {
      self._selectedLines().forEach(function (row) { self.indentLine(row, false); });
    });
  };

  P.hardWrap = function (options) { return hardWrap(this, options); };

  // --- search ----------------------------------------------------------------
  P.getSearchCursor = function (query, pos) {
    var cm = this;
    var last = null;          // { from, to, match } in offsets
    var lastResult = null;    // same in Pos
    var afterEmptyMatch = false;
    if (pos.ch == undefined) pos.ch = Number.MAX_VALUE;
    var firstOffset = this.indexFromPos(pos);
    var flags = 'gm' + (query.ignoreCase ? 'i' : '') + (query.unicode ? 'u' : '');

    function regex() { return new RegExp(query.source, flags); }
    function nextMatch(from) {
      var text = cm.doc.text;
      if (from > text.length) return null;
      var re = regex();
      re.lastIndex = from;
      var m = re.exec(text);
      if (!m) return null;
      return { from: m.index, to: m.index + m[0].length, match: m };
    }
    function prevMatchBefore(endAt) {
      var text = cm.doc.text;
      var re = regex();
      var found = null;
      var m;
      while ((m = re.exec(text)) !== null) {
        if (m.index >= endAt) break;
        found = { from: m.index, to: m.index + m[0].length, match: m };
        if (m[0].length === 0) re.lastIndex++;
      }
      return found;
    }
    return {
      findNext: function () { return this.find(false); },
      findPrevious: function () { return this.find(true); },
      find: function (back) {
        if (back) {
          var endAt = last ? (afterEmptyMatch ? last.to - 1 : last.from) : firstOffset;
          last = endAt < 0 ? null : prevMatchBefore(endAt);
        } else {
          var startFrom = last ? (afterEmptyMatch ? last.to + 1 : last.to) : firstOffset;
          last = nextMatch(startFrom);
        }
        lastResult = last && {
          from: cm.posFromIndex(last.from),
          to: cm.posFromIndex(last.to),
          match: last.match
        };
        afterEmptyMatch = last ? last.from == last.to : false;
        return last && last.match;
      },
      from: function () { return lastResult && lastResult.from; },
      to: function () { return lastResult && lastResult.to; },
      replace: function (text) {
        if (last) {
          cm._dispatch([{ from: last.from, to: last.to, insert: text }]);
          last.to = last.from + text.length;
          if (lastResult) lastResult.to = cm.posFromIndex(last.to);
        }
      },
      get match() { return lastResult && lastResult.match; }
    };
  };

  // --- vertical movement and scrolling ----------------------------------------
  P._visibleLines = function () {
    var vis = native.visibleRange();
    if (!vis) return null;
    var first = this.doc.posFromIndex(vis.start).line;
    var last = this.doc.posFromIndex(vis.start + vis.length).line;
    return { first: first, last: last, count: Math.max(1, last - first + 1) };
  };
  P.findPosV = function (start, amount, unit, goalColumn) {
    var lines = unit == 'page' ? ((this._visibleLines() || { count: 30 }).count) : 1;
    var target = start.line + Math.round(amount) * lines;
    var lastLine = this.lastLine();
    var clamped = Math.max(0, Math.min(target, lastLine));
    var ch = goalColumn != null ? goalColumn : start.ch;
    var pos = this.clipPos(new Pos(clamped, ch));
    if (target !== clamped) {
      // Nowhere to go: CodeMirror moves to the document edge and flags it.
      pos = amount < 0 ? new Pos(0, 0) : this.clipPos(new Pos(lastLine, Number.MAX_VALUE));
      if ((amount < 0 && start.line == 0) || (amount > 0 && start.line == lastLine)) pos.hitSide = true;
    }
    return pos;
  };
  P.charCoords = function (pos) {
    return { left: pos.ch * CHAR_WIDTH, top: pos.line * LINE_HEIGHT, bottom: (pos.line + 1) * LINE_HEIGHT };
  };
  P.coordsChar = function (coords) {
    return this.clipPos(new Pos(Math.floor(coords.top / LINE_HEIGHT), Math.round(coords.left / CHAR_WIDTH)));
  };
  P.getScrollInfo = function () {
    var vis = this._visibleLines() || { first: 0, count: 30 };
    return {
      left: 0,
      top: vis.first * LINE_HEIGHT,
      height: this.doc.lines() * LINE_HEIGHT,
      width: 1000,
      clientHeight: vis.count * LINE_HEIGHT,
      clientWidth: 1000
    };
  };
  P.scrollTo = function (x, y) {
    if (y == null) return;
    var row = Math.max(0, Math.min(Math.round(y / LINE_HEIGHT), this.lastLine()));
    native.scrollTo(this.doc.lineFrom(row));
  };
  P.scrollIntoView = function (pos) {
    var offset = pos ? this.indexFromPos(pos) : this._main().head;
    var vis = native.visibleRange();
    if (vis && offset >= vis.start && offset <= vis.start + vis.length) return;
    native.scrollTo(offset);
  };

  // --- multiple selections (visual block) ----------------------------------
  P.isInMultiSelectMode = function () { return this.ranges.length > 1; };
  P.virtualSelectionMode = function () { return !!this.virtualSelection; };
  P.forEachSelection = function (command) {
    var ranges = this.ranges.slice();
    var prim = this.primIndex;
    this.virtualSelection = { ranges: ranges };
    for (var i = 0; i < ranges.length; i++) {
      var range = this.virtualSelection.ranges[i];
      if (!range) continue;
      this._dispatch(null, [range]);
      command();
      this.virtualSelection.ranges[i] = this.ranges[0];
    }
    this._dispatch(null, this.virtualSelection.ranges, prim);
    this.virtualSelection = null;
  };

  // --- prompts and messages (the ":" and "/" bar) ---------------------------
  var activePrompt = null;

  function templateParts(template) {
    var input = template.getElementsByTagName ? template.getElementsByTagName('input')[0] : null;
    var prefix = '';
    var desc = '';
    if (input && input.parentElement) {
      prefix = input.parentElement.textContent;
      var all = template.textContent;
      desc = all.slice(all.indexOf(prefix) + prefix.length).trim();
    } else {
      prefix = template.textContent || '';
    }
    return { prefix: prefix, desc: desc, input: input };
  }

  function fakeKeyEvent(key, keyCode) {
    return {
      key: key, keyCode: keyCode, code: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
      preventDefault: function () {}, stopPropagation: function () {}
    };
  }

  P.openDialog = function (template, callback, options) {
    options = options || {};
    var cm = this;
    this._closeNotification();
    var parts = templateParts(template);
    var input = parts.input || new FakeNode('input');
    if (options.value) input.value = options.value;
    var closed = false;
    var prompt = {
      input: input,
      callback: callback,
      options: options,
      close: function (newVal) {
        if (typeof newVal === 'string') { input.value = newVal; return; }
        if (closed) return;
        closed = true;
        if (activePrompt === prompt) activePrompt = null;
        cm.state.dialog = null;
        native.closePrompt();
        if (options.onClose) options.onClose(template);
      }
    };
    activePrompt = prompt;
    cm.state.dialog = template;
    native.openPrompt(parts.prefix, parts.desc, input.value || '');
    return prompt.close;
  };

  P.openNotification = function (template, options) {
    var duration = options && typeof options.duration !== 'undefined' ? options.duration : 5000;
    var text = template && template.textContent != null ? template.textContent : String(template);
    native.notify(text, duration || 0);
    var self = this;
    var close = function () { if (self._notificationClose === close) self._notificationClose = null; };
    this._notificationClose = close;
    return close;
  };
  P._closeNotification = function () {
    if (this._notificationClose) this._notificationClose();
  };

  // ---------------------------------------------------------------------------
  // Host sync
  // ---------------------------------------------------------------------------

  // Pull Notes' text and selection into the model. Differences in the text are
  // replayed as a change so the engine records typing done in insert mode
  // (needed for "." and macros), the same way CodeMirror reports input.
  P.sync = function () {
    var st = native.read();
    if (!st) return false;
    var text = st.text;
    var start = st.start;
    var end = st.start + st.length;

    var vimState = this.state.vim;
    if (st.length === 1 && (st.elementChanged || !this._lastPushed) && vimState &&
        !vimState.insertMode && !vimState.visualMode && NotesVim.options.blockCursor) {
      // Most likely a block cursor we drew before losing track of it (another
      // note, or a restart); treat it as the caret instead of a selection.
      end = start;
    }

    if (st.elementChanged) {
      // A different note: start fresh without replaying anything.
      this.doc.set(text);
      this.marks = Object.create(null);
      this.ranges = [{ anchor: start, head: end }];
      this.primIndex = 0;
      this._lastPushed = null;
      var vim = this.state.vim;
      if (vim && vim.visualMode && start === end) {
        Vim.handleKey(this, '<Esc>', 'user');
      }
      return true;
    }

    // The selection we drew ourselves (e.g. the one-character block cursor)
    // is not a real selection; read it as "unchanged".
    var pushed = this._lastPushed;
    var selectionIsOurs = pushed && pushed.start === st.start && pushed.length === st.length;

    var oldText = this.doc.text;
    var textChanged = text !== oldText;
    if (!textChanged && selectionIsOurs) return true;

    this.curOp = this.curOp || { $d: 0 };
    var op = this.curOp;
    op.$d++;
    try {
      if (textChanged) {
        var a = 0;
        var maxA = Math.min(oldText.length, text.length);
        while (a < maxA && oldText.charCodeAt(a) === text.charCodeAt(a)) a++;
        var b = 0;
        var maxB = Math.min(oldText.length - a, text.length - a);
        while (b < maxB && oldText.charCodeAt(oldText.length - 1 - b) === text.charCodeAt(text.length - 1 - b)) b++;
        var change = { from: a, to: oldText.length - b, insert: text.slice(a, text.length - b) };
        this._dispatch([change], null, null, true);
      }
      if (!selectionIsOurs || textChanged) {
        var anchor = start;
        var head = end;
        var main = this._main();
        if (main && main.head < main.anchor) { anchor = end; head = start; }
        if (selectionIsOurs) {
          // Text changed but the selection is still the block we drew: keep the caret.
          var caret = this._main().head;
          anchor = head = caret;
        }
        this.ranges = [{ anchor: anchor, head: head }];
        this.primIndex = 0;
        this.onSelectionChange();
      }
    } finally {
      op.$d--;
      if (!op.$d) this.onBeforeEndOperation();
    }
    return true;
  };

  // Put the model's selection on screen. In normal mode, the cursor is drawn
  // as a one-character selection so it looks like Vim's block cursor.
  P.push = function () {
    if (this._skipPush) {
      this._skipPush = false;
      this._lastPushed = null;
      return;
    }
    var vim = this.state.vim;
    var main = this._main();
    var start = Math.min(main.anchor, main.head);
    var length = Math.abs(main.head - main.anchor);
    var blockCursor = NotesVim.options.blockCursor;
    if (vim && !vim.insertMode && !vim.visualMode && length === 0 && blockCursor) {
      var ch = this.doc.text.charAt(start);
      if (ch && ch !== '\n') length = 1;
    }
    var pushed = this._lastPushed;
    if (pushed && pushed.start === start && pushed.length === length) return;
    if (native.select(start, length)) {
      this._lastPushed = { start: start, length: length };
    } else {
      this._lastPushed = null;
    }
  };

  // ---------------------------------------------------------------------------
  // Public API used by the host
  // ---------------------------------------------------------------------------
  var Vim = global.initVim(NotesCM);
  var cm = new NotesCM();

  var NotesVim = {
    Vim: Vim,
    cm: cm,
    options: { blockCursor: true },

    init: function (opts) {
      opts = opts || {};
      if (opts.blockCursor === false) NotesVim.options.blockCursor = false;
      cm.on('vim-mode-change', function (e) {
        var mode = e.mode;
        if (e.subMode) mode += e.subMode === 'linewise' ? ' line' : ' block';
        if (cm.state.vim) cm.state.vim.mode = mode;
        native.setMode(mode);
      });
      cm.on('vim-command-done', function () {
        if (cm.state.vim) cm.state.vim.status = '';
      });
      Vim.enterVimMode(cm);
      if (opts.vimrc) NotesVim.loadVimrc(opts.vimrc);
      if (opts.startInInsertMode) {
        Vim.handleKey(cm, 'i', 'user');
      }
      native.setMode(cm.state.vim && cm.state.vim.insertMode ? 'insert' : 'normal');
    },

    // Lines of an Obsidian-style .vimrc: map, nmap, imap, set, noremap...
    loadVimrc: function (source) {
      String(source).split(/\r?\n/).forEach(function (line) {
        line = line.replace(/^\s+/, '');
        if (!line || line.charAt(0) === '"') return;
        // Obsidian-only commands from the vimrc plugin; nothing to call in Notes.
        if (/^(exmap|obcommand|jscommand|jsfile|amap)\b/.test(line)) {
          native.log('vimrc: skipped Obsidian-only line "' + line + '"');
          return;
        }
        try {
          Vim.handleEx(cm, line);
        } catch (e) {
          native.log('vimrc: could not run "' + line + '": ' + e);
        }
      });
    },

    // evt: { key, code, ctrlKey, altKey, metaKey, shiftKey }
    // Returns true if the key was used by Vim and must not reach Notes.
    handleKey: function (evt) {
      if (!cm.sync()) return false;
      var vim = cm.state.vim || Vim.maybeInitVimState_(cm);
      var key = Vim.vimKeyFromEvent(evt, vim);
      if (!key) return false;

      if (vim.insertMode && (evt.key === 'Backspace' || evt.key === 'Delete')) {
        // Recorded for "." the same way CodeMirror's input field reports it.
        cm.getInputField().dispatch('keydown', fakeKeyEvent(evt.key, evt.key === 'Backspace' ? 8 : 46));
      }

      if (key == '<Esc>' && !vim.insertMode && !vim.visualMode) {
        var searchState = vim.searchState_;
        if (searchState && searchState.getOverlay && searchState.getOverlay()) {
          cm.removeOverlay(searchState.getOverlay());
          searchState.setOverlay(null);
        }
      }

      vim.status = (vim.status || '') + key;
      var result;
      try {
        result = Vim.multiSelectHandleKey(cm, key, 'user');
      } catch (e) {
        native.log('Vim error on ' + key + ': ' + (e && e.stack || e));
        result = true;
      }
      vim = Vim.maybeInitVimState_(cm);

      // Visual-block insert (<C-v> then I/A/c): CodeMirror types into every
      // cursor at once, but Notes only has one caret, so type for it.
      if (!result && vim.insertMode && cm.ranges.length > 1 && !evt.metaKey && !evt.ctrlKey) {
        if (evt.key && evt.key.length === 1) {
          cm.replaceSelection(evt.key);
          result = true;
        } else if (evt.key === 'Enter') {
          cm.replaceSelection('\n');
          result = true;
        } else if (evt.key === 'Tab') {
          cm.replaceSelection('\t');
          result = true;
        } else if (evt.key === 'Backspace') {
          cm._deleteChar(-1);
          result = true;
        }
      }

      if (!result && vim.insertMode && cm.state.overwrite) {
        if (evt.key && evt.key.length == 1 && !evt.ctrlKey && !evt.metaKey) {
          result = true;
          cm.overWriteSelection(evt.key);
        } else if (evt.key == 'Backspace') {
          result = true;
          NotesCM.commands.cursorCharLeft(cm);
        }
      }

      if (result) NotesCM.signal(cm, 'vim-keypress', key);
      if (result || !vim.insertMode) {
        cm.push();
        // Some commands finish in a promise (e.g. "+p reading the clipboard).
        Promise.resolve().then(function () { cm.push(); });
      } else {
        // Plain typing: Notes owns the caret; don't move it from under the key.
        cm._lastPushed = null;
      }

      // Outside insert mode nothing may be typed into the note, even for keys
      // Vim does not use (same as CodeMirror's disableInput).
      if (!vim.insertMode) return true;
      return !!result;
    },

    // The ":" / "/" bar was submitted with Enter.
    promptSubmit: function (value) {
      var prompt = activePrompt;
      if (!prompt) return;
      cm.sync();
      prompt.input.value = value;
      var opts = prompt.options;
      var handled = false;
      if (opts.onKeyDown) {
        handled = opts.onKeyDown(fakeKeyEvent('Enter', 13), value, prompt.close);
      }
      if (!handled) {
        try {
          if (prompt.callback) prompt.callback(value);
        } catch (e) {
          native.log('Vim command error: ' + (e && e.stack || e));
        }
        if (opts.closeOnEnter !== false) prompt.close();
      }
      cm.push();
    },

    // The bar was dismissed with Escape.
    promptCancel: function () {
      var prompt = activePrompt;
      if (!prompt) return;
      cm.sync();
      var opts = prompt.options;
      var handled = false;
      if (opts.onKeyDown) {
        handled = opts.onKeyDown(fakeKeyEvent('Escape', 27), prompt.input.value, prompt.close);
      }
      if (!handled) prompt.close();
      if (activePrompt === prompt) prompt.close();
      cm.push();
    },

    fireTimer: function (id) {
      var fn = timers[id];
      if (!fn) return;
      delete timers[id];
      cm.sync();
      try {
        fn();
      } catch (e) {
        native.log('timer error: ' + (e && e.stack || e));
      }
      cm.push();
    },

    // Called when focus moves to another note or app; forget our drawn cursor.
    forgetScreen: function () {
      cm._lastPushed = null;
    },

    mode: function () {
      var vim = cm.state.vim;
      if (!vim) return 'normal';
      return vim.mode || (vim.insertMode ? 'insert' : vim.visualMode ? 'visual' : 'normal');
    }
  };

  global.NotesVim = NotesVim;
  global.NotesCM = NotesCM;
})(typeof globalThis !== 'undefined' ? globalThis : this);
