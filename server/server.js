'use strict';

// =====================================================================
// System PDV PRO — Servidor de rede (API HTTP + SQLite + WebSocket)
// ---------------------------------------------------------------------
// Implementa exatamente o contrato consumido pelo front-end (app.html /
// index.html), sem alterar o layout. O front envia SQL puro; este
// servidor executa via better-sqlite3 e devolve no formato esperado:
//   SELECT          -> { rows: [...] }
//   INSERT/UPDATE.. -> { lastID, changes }
// =====================================================================

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const { inicializarSchema } = require('./schema');

const VERSION = '2.0.0';
const PORT = parseInt(process.env.PDV_PORT || '8765', 10);
const HOST = process.env.PDV_HOST || '0.0.0.0';

// Diretorio de dados: por padrao ./data ao lado do server.js. Em producao
// (Tauri) o app passa PDV_DATA_DIR apontando para a pasta de dados do app.
const DATA_DIR = process.env.PDV_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.PDV_DB_PATH || path.join(DATA_DIR, 'system_pdv_pro.db');

// Diretorio dos arquivos estaticos (index.html / app.html). Por padrao a
// raiz do repositorio (um nivel acima de server/).
const STATIC_DIR = process.env.PDV_STATIC_DIR || path.join(__dirname, '..');

function log(...args) {
  const ts = new Date().toISOString();
  console.log('[' + ts + ']', ...args);
}

// --------------------------- Banco de dados ---------------------------
function openDatabase() {
  const d = new Database(DB_PATH);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = OFF');
  inicializarSchema(d);
  return d;
}

// `let` (nao `const`): o restore reabre o banco no mesmo processo,
// reatribuindo esta variavel. Todas as rotas referenciam `db` por nome,
// entao passam a usar a nova conexao automaticamente.
let db = openDatabase();
log('Banco pronto em', DB_PATH);

// better-sqlite3 nao aceita undefined nem boolean como parametro de bind.
function normParams(params) {
  if (!Array.isArray(params)) return [];
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

// Executa um unico statement e devolve no formato do contrato.
function execOne(sql, params) {
  const stmt = db.prepare(sql);
  const p = normParams(params);
  if (stmt.reader) {
    return { rows: stmt.all(...p) };
  }
  const info = stmt.run(...p);
  return { lastID: Number(info.lastInsertRowid), changes: info.changes };
}

// --------------------------- Auth (token) -----------------------------
// Token opaco assinado em memoria; o servidor aceita ausencia (modo soft),
// como documentado no app.html. Mantido por compatibilidade/futuro strict.
const SECRET = crypto.randomBytes(32).toString('hex');
function makeToken(usuario) {
  const payload = Buffer.from(JSON.stringify({
    id: usuario.id, login: usuario.login, t: Date.now(),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

// ------------------------------ App -----------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: VERSION, time: new Date().toISOString() });
});

// Usado pela tela de setup (index.html) para validar conexao do caixa.
app.get('/api/identidade', (req, res) => {
  res.json({ version: VERSION, nome: 'System PDV PRO', hostname: os.hostname() });
});

app.post('/api/auth/login', (req, res) => {
  const { login, senha } = req.body || {};
  if (!login || !senha) return res.status(400).json({ error: 'login/senha ausentes' });
  try {
    const usuario = db
      .prepare('SELECT * FROM usuarios WHERE login=? AND senha=? AND ativo=1')
      .get(login, senha);
    if (!usuario) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    res.json({ usuario, token: makeToken(usuario) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => res.json({ ok: true }));

app.post('/api/sql/exec', (req, res) => {
  const { sql, params } = req.body || {};
  if (typeof sql !== 'string' || !sql.trim()) {
    return res.status(400).json({ error: 'sql ausente' });
  }
  try {
    res.json(execOne(sql, params));
  } catch (e) {
    log('exec erro:', e.message, '| sql:', sql.slice(0, 120));
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sql/exec-batch', (req, res) => {
  const { statements } = req.body || {};
  if (!Array.isArray(statements)) {
    return res.status(400).json({ error: 'statements ausente' });
  }
  const runBatch = db.transaction((sts) => sts.map((s) => execOne(s.sql, s.params)));
  try {
    res.json({ results: runBatch(statements) });
  } catch (e) {
    log('exec-batch erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Notificacao em tempo real para os outros caixas (refresh de tela).
app.post('/api/sql/notify', (req, res) => {
  const { entidade, ids } = req.body || {};
  broadcast({ type: 'notify', entidade: entidade || null, ids: ids || [] });
  res.json({ ok: true });
});

// Registro de caixa adicional (chamado pelo index.html no setup).
app.post('/api/caixas-clientes/register', (req, res) => {
  const { identificador, nome, hostname, versao_cliente } = req.body || {};
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  try {
    db.prepare(
      `INSERT INTO caixas_clientes (identificador, nome, hostname, versao_cliente, ip, ultimo_acesso)
       VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(identificador) DO UPDATE SET
         nome=excluded.nome, hostname=excluded.hostname,
         versao_cliente=excluded.versao_cliente, ip=excluded.ip,
         ultimo_acesso=CURRENT_TIMESTAMP`
    ).run(identificador || crypto.randomUUID(), nome || null, hostname || null, versao_cliente || null, ip);
    broadcast({ type: 'caixa-registrado', identificador, nome });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backup: dump binario do arquivo .db (consumido por db.export()).
app.get('/api/backup/dump', (req, res) => {
  try {
    // Garante checkpoint do WAL para um dump consistente.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const buf = fs.readFileSync(DB_PATH);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="system_pdv_pro.db"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Restore: substitui o banco por um .db enviado (multipart-free: corpo bruto).
app.post('/api/backup/restore', express.raw({ type: '*/*', limit: '200mb' }), (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'arquivo vazio' });
    const tmp = DB_PATH + '.restore';
    fs.writeFileSync(tmp, req.body);
    // Valida que e um SQLite valido antes de aplicar.
    const test = new Database(tmp, { readonly: true });
    test.prepare('SELECT COUNT(*) FROM sqlite_master').get();
    test.close();
    // Fecha a conexao atual e remove os arquivos WAL/SHM do banco antigo —
    // se ficassem no disco, o SQLite tentaria reaplica-los sobre o banco
    // restaurado, "desfazendo" parte da restauracao.
    db.close();
    for (const ext of ['-wal', '-shm']) {
      try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
    }
    fs.copyFileSync(tmp, DB_PATH);
    fs.unlinkSync(tmp);
    // Reabre o banco no MESMO processo (sem matar o servidor). Antes o
    // servidor fazia process.exit(0) esperando um supervisor reinicia-lo,
    // mas no app desktop (Tauri) o processo Node nao era respawnado, o que
    // derrubava o servidor e impedia o login apos restaurar um backup.
    db = openDatabase();
    broadcast({ type: 'restore' });
    res.json({ ok: true, restart: false });
    log('Backup restaurado — banco reaberto no mesmo processo.');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------- Estaticos (index/app) -------------------------
app.use(express.static(STATIC_DIR, { extensions: ['html'] }));
app.get('/', (req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));

// ---------------------- HTTP + WebSocket ------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'hello', version: VERSION }));
});

function broadcast(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach((c) => { if (c.readyState === 1) { try { c.send(data); } catch (_) {} } });
}

// Heartbeat — derruba conexoes mortas de caixas que cairam.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, 30000);

server.listen(PORT, HOST, () => {
  log(`System PDV PRO Server v${VERSION} ouvindo em http://${HOST}:${PORT}`);
  const nets = os.networkInterfaces();
  Object.values(nets).flat().forEach((ni) => {
    if (ni && ni.family === 'IPv4' && !ni.internal) {
      log(`  Rede: http://${ni.address}:${PORT}  (use este endereco nos caixas)`);
    }
  });
});

process.on('SIGINT', () => { log('Encerrando...'); process.exit(0); });
process.on('SIGTERM', () => { log('Encerrando...'); process.exit(0); });
