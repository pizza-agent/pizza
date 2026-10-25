// Minimal VT100/xterm screen emulator for driving pizza TUI tests.
export class Screen {
  constructor(cols = 80, rows = 24) {
    this.cols = cols; this.rows = rows;
    this.grid = []; this.cx = 0; this.cy = 0;
    this.wrapNext = false; this.pending = "";
    this.clear();
    this.out = ""; // raw transcript
  }
  clear() {
    this.grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(" "));
  }
  ensure() { while (this.grid.length < this.rows) this.grid.push(Array(this.cols).fill(" ")); }
  feed(data) {
    this.out += data;
    data = this.pending + data;
    this.pending = "";
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\x1b") {
        const consumed = this.tryEscape(data, i);
        if (consumed === -1) { this.pending = data.slice(i); return; } // incomplete — wait for more
        i += consumed; continue;
      }
      else if (ch === "\r") { this.cx = 0; this.wrapNext = false; i++; continue; }
      else if (ch === "\n") { this.newline(); i++; continue; }
      else if (ch === "\x08") { this.cx = Math.max(0, this.cx - 1); i++; continue; }
      else if (ch === "\x07" || ch === "\x00" || ch === "\x0b" || ch === "\x0c" || ch === "\x0e" || ch === "\x0f") { i++; continue; }
      else if (ch === "\t") { this.cx = Math.min(this.cols - 1, (this.cx & ~7) + 8); i++; continue; }
      else if (ch < " ") { i++; continue; }
      // printable char — find full char (surrogate pairs)
      let c = ch;
      const code = data.codePointAt(i);
      if (code > 0xffff) { c = data.slice(i, i + 2); i += 2; } else i++;
      const w = this.widthOf(code);
      if (w === 0) { // combining char: append to prev cell
        if (this.cx > 0) this.grid[this.cy][this.cx - 1] += c;
        continue;
      }
      if (this.wrapNext) { this.newline(); }
      if (this.cy >= this.rows) { this.scroll(); this.cy = this.rows - 1; }
      this.ensure();
      this.grid[this.cy][this.cx] = c;
      if (w === 2) { if (this.cx + 1 < this.cols) this.grid[this.cy][this.cx + 1] = ""; this.cx += 2; }
      else this.cx += 1;
      if (this.cx >= this.cols) { this.cx = this.cols - 1; this.wrapNext = true; }
    }
  }
  // returns consumed length, or -1 if sequence incomplete
  tryEscape(data, i) {
    const next = data[i + 1];
    if (next === undefined) return -1;
    if (next === "[") {
      const m = /^\x1b\[([0-9;?>=<!]*)([a-zA-Z@`~$"'#%&()*+,\-./])/.exec(data.slice(i, i + 64));
      if (m) { this.csi(m[1], m[2]); return m[0].length; }
      // maybe incomplete
      if (/^\x1b\[[0-9;?>=<!]*$/.test(data.slice(i))) return -1;
      return 2;
    }
    if (next === "]") {
      const end = data.indexOf("\x07", i); const st = data.indexOf("\x1b\\", i);
      let e = -1;
      if (end !== -1 && (st === -1 || end < st)) e = end + 1;
      else if (st !== -1) e = st + 2;
      if (e === -1) return data.length - i > 2000 ? data.length - i : -1; // possibly incomplete
      return e - i;
    }
    if (next === "(" || next === ")") { return data.length >= i + 3 ? 3 : -1; }
    if (next === "M") { this.cy = Math.max(0, this.cy - 1); return 2; }
    if (next === "D") { this.cy = Math.min(this.rows - 1, this.cy + 1); return 2; }
    if (next === "E") { this.cy = Math.min(this.rows - 1, this.cy + 1); this.cx = 0; return 2; }
    if (next === "7" || next === "8") return 2;
    return 2;
  }
  widthOf(code) {
    if (code === 0) return 0;
    if (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd))) return 2;
    if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x1ab0 && code <= 0x1aff) ||
      (code >= 0x1dc0 && code <= 0x1dff) || (code >= 0x20d0 && code <= 0x20ff) ||
      (code >= 0xfe20 && code <= 0xfe2f)) return 0;
    return 1;
  }
  newline() {
    this.cx = 0; this.wrapNext = false;
    this.cy++;
    if (this.cy >= this.rows) { this.scroll(); this.cy = this.rows - 1; }
  }
  scroll() { this.grid.shift(); this.grid.push(Array(this.cols).fill(" ")); }
  csi(param, cmd) {
    const clean = param.replace(/^[?>=<!]/, "");
    const p = clean.split(";").map(x => x === "" ? 0 : parseInt(x, 10));
    const n = p[0] || 1;
    switch (cmd) {
      case "A": this.cy = Math.max(0, this.cy - n); break;
      case "B": this.cy = Math.min(this.rows - 1, this.cy + n); break;
      case "C": this.cx = Math.min(this.cols - 1, this.cx + n); break;
      case "D": this.cx = Math.max(0, this.cx - n); break;
      case "E": this.cy = Math.min(this.rows - 1, this.cy + n); this.cx = 0; break;
      case "F": this.cy = Math.max(0, this.cy - n); this.cx = 0; break;
      case "G": this.cx = Math.min(this.cols - 1, n - 1); break;
      case "H": case "f": this.cy = Math.min(this.rows - 1, (p[0] || 1) - 1); this.cx = Math.min(this.cols - 1, (p[1] || 1) - 1); break;
      case "J":
        if (p[0] === 2 || p[0] === 3) this.clear();
        else if (p[0] === 1) { for (let y = 0; y <= this.cy; y++) { const e = y === this.cy ? this.cx : this.cols - 1; for (let x = 0; x <= e; x++) this.grid[y][x] = " "; } }
        else { for (let y = this.cy; y < this.rows; y++) { const s = y === this.cy ? this.cx : 0; for (let x = s; x < this.cols; x++) this.grid[y][x] = " "; } }
        break;
      case "K":
        if (p[0] === 2) for (let x = 0; x < this.cols; x++) this.grid[this.cy][x] = " ";
        else if (p[0] === 1) for (let x = 0; x <= this.cx; x++) this.grid[this.cy][x] = " ";
        else for (let x = this.cx; x < this.cols; x++) this.grid[this.cy][x] = " ";
        break;
      case "L": for (let i = 0; i < n; i++) { this.grid.splice(this.cy, 0, Array(this.cols).fill(" ")); this.grid.pop(); } break;
      case "M": for (let i = 0; i < n; i++) { this.grid.splice(this.cy, 1); this.grid.push(Array(this.cols).fill(" ")); } break;
      case "P": for (let i = 0; i < n; i++) { this.grid[this.cy].splice(this.cx, 1); this.grid[this.cy].push(" "); } break;
      case "@": for (let i = 0; i < n; i++) { this.grid[this.cy].splice(this.cx, 0, " "); this.grid[this.cy].pop(); } break;
      case "S": for (let i = 0; i < n; i++) this.scroll(); break;
      case "T": for (let i = 0; i < n; i++) { this.grid.unshift(Array(this.cols).fill(" ")); this.grid.pop(); } break;
      case "X": for (let i = 0; i < n && this.cx + i < this.cols; i++) this.grid[this.cy][this.cx + i] = " "; break;
      case "d": this.cy = Math.min(this.rows - 1, n - 1); break;
      case "m": case "r": case "s": case "u": case "h": case "l": case "t": case "q": break;
      default: break;
    }
  }
  text() { return this.grid.map(r => r.join("").replace(/\s+$/, "")).join("\n"); }
  contains(sub) { return this.text().includes(sub); }
  row(y) { return this.grid[y] ? this.grid[y].join("").replace(/\s+$/, "") : ""; }
}
