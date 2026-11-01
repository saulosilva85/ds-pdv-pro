// Adaptador minimo: expoe a API do better-sqlite3 em cima do node:sqlite (so para testes).
const { DatabaseSync } = require('node:sqlite');
class Database {
  constructor(file, opts = {}) { this.d = new DatabaseSync(file, { readOnly: !!opts.readonly }); }
  exec(s) { return this.d.exec(s); }
  prepare(sql) {
    const st = this.d.prepare(sql);
    const reader = /^\s*(select|pragma|with)\b/i.test(sql.replace(/\/\*[\s\S]*?\*\//g,'').replace(/--[^\n]*/g,'')) ;
    return {
      reader,
      get: (...p) => st.get(...p), all: (...p) => st.all(...p),
      run: (...p) => { const r = st.run(...p); return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }; },
    };
  }
  pragma(s, o) {
    if (s.includes('=')) { this.d.exec('PRAGMA ' + s); return; }
    const rows = this.d.prepare('PRAGMA ' + s).all();
    return o && o.simple ? Object.values(rows[0])[0] : rows;
  }
  transaction(fn) { return (...a) => { this.d.exec('BEGIN'); try { const r = fn(...a); this.d.exec('COMMIT'); return r; } catch (e) { this.d.exec('ROLLBACK'); throw e; } }; }
  async backup(dest) { this.d.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'"); }
  close() { this.d.close(); }
}
module.exports = Database;
