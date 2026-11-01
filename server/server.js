'use strict';

// =====================================================================
// System PDV PRO — Servidor de rede (API HTTP + SQLite + WebSocket)
// ---------------------------------------------------------------------
// Implementa o contrato consumido pelo front-end (app.html / index.html),
// sem alterar o layout. O front envia SQL; este servidor executa via
// better-sqlite3 e devolve no formato esperado:
//   SELECT          -> { rows: [...] }
//   INSERT/UPDATE.. -> { lastID, changes }
//
// Seguranca (v2.1):
//   - Autenticacao por token assinado (HMAC) com expiracao.
//   - Modo de autenticacao (PDV_AUTH_MODE):
//       "soft"   (padrao) aceita requisicoes sem token, mas registra
//                quantas chegaram sem token. Compativel com o front atual.
//       "strict" exige token valido em /api/sql/* e /api/backup/*.
//     Troque para "strict" depois que o front-end enviar o token.
//   - Bloqueio de SQL perigoso (ATTACH, PRAGMA de escrita, extensoes...).
//   - CORS restrito a origens locais/da rede; validacao do cabecalho Host.
//   - Limitador de tentativas de login.
//   - Senhas nunca sao devolvidas pela API de login.
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
const {
  inicializarSchema, hashSenha, SENHA_PADRAO_MASTER_HASH, SCHEMA_VERSION,
} = require('./schema');
const sec = require('./security');
const bkp = require('./backup');

const VERSION = '2.1.0';
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

// Seguranca
const AUTH_MODE = (process.env.PDV_AUTH_MODE || 'soft').toLowerCase() === 'strict' ? 'strict' : 'soft';
const EXTRA_HOSTS = (process.env.PDV_ALLOWED_HOSTS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// Backup
const BACKUP_DIR = process.env.PDV_BACKUP_DIR || path.join(DATA_DIR, 'backups');
const BACKUP_DIR_EXTRA = process.env.PDV_BACKUP_DIR_EXTRA || '';
const BACKUP_HORA = Math.min(23, Math.max(0, parseInt(process.env.PDV_BACKUP_HORA || '23', 10) || 23));
const BACKUP_MANTER = Math.max(1, parseInt(process.env.PDV_BACKUP_MANTER || '14', 10) || 14);
const BACKUP_DESLIGADO = process.env.PDV_BACKUP_AUTO === '0';

function log(...args) {
  const ts = new Date().toISOString();
  console.log('[' + ts + ']', ...args);
}

// --------------------------- Banco de dados ---------------------------
function openDatabase() {
  const d = new Database(DB_PATH);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = OFF');
  d.pragma('busy_timeout = 5000');
  inicializarSchema(d, log);
  return d;
}

// `let` (nao `const`): o restore reabre o banco no mesmo processo,
// reatribuindo esta variavel. Todas as rotas referenciam `db` por nome,
// entao passam a usar a nova conexao automaticamente.
let db = openDatabase();
log('Banco pronto em', DB_PATH, '(schema v' + SCHEMA_VERSION + ')');

function avisarSenhaPadrao() {
  try {
    const r = db.prepare("SELECT COUNT(*) AS c FROM usuarios WHERE login='master' AND senha=? AND ativo=1")
      .get(SENHA_PADRAO_MASTER_HASH);
    if (r.c > 0) {
      log('ATENCAO: o usuario "master" ainda usa a senha padrao. Troque-a em Usuarios.');
    }
  } catch (_) { /* ignora */ }
}
avisarSenhaPadrao();

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
const SECRET = sec.carregarSegredo(DATA_DIR);
const limitadorLogin = new sec.LimitadorLogin();
setInterval(() => limitadorLogin.limpar(), 5 * 60 * 1000).unref();

function ipDe(req) {
  return (req.socket && req.socket.remoteAddress) || 'desconhecido';
}

// Carrega nivel + permissoes do usuario do token (para as regras por tabela).
function carregarUsuarioAuth(id) {
  const u = db.prepare('SELECT id, login, nivel, perfil_id, ativo FROM usuarios WHERE id=?').get(id);
  if (!u || !u.ativo) return null;
  let permissoes = [];
  if (u.perfil_id) {
    const p = db.prepare('SELECT permissoes FROM perfis WHERE id=?').get(u.perfil_id);
    if (p && p.permissoes) {
      try { permissoes = JSON.parse(p.permissoes); } catch (_) { permissoes = []; }
    }
  }
  return { id: u.id, login: u.login, nivel: u.nivel, permissoes };
}

let semTokenDesdeUltimoLog = 0;
setInterval(() => {
  if (semTokenDesdeUltimoLog > 0 && AUTH_MODE === 'soft') {
    log('Auditoria: ' + semTokenDesdeUltimoLog + ' requisicao(oes) sem token no ultimo minuto (modo soft).');
  }
  semTokenDesdeUltimoLog = 0;
}, 60 * 1000).unref();

// Middleware: identifica o usuario pelo token. Em modo strict, recusa sem token.
function autenticar(req, res, next) {
  const token = sec.extrairToken(req);
  const dados = token ? sec.verificarToken(SECRET, token) : null;
  if (dados) {
    const u = carregarUsuarioAuth(dados.id);
    if (u) { req.usuarioAuth = u; return next(); }
  }
  if (AUTH_MODE === 'strict') {
    return res.status(401).json({ error: 'Sessao invalida ou expirada. Faca login novamente.' });
  }
  semTokenDesdeUltimoLog += 1;
  req.usuarioAuth = null;
  return next();
}

// ------------------------------ App -----------------------------------
const app = express();
app.disable('x-powered-by');

// Protecao contra DNS rebinding: o Host precisa ser local/da rede.
app.use((req, res, next) => {
  if (!sec.hostHeaderAceito(req.headers.host, EXTRA_HOSTS)) {
    return res.status(421).json({ error: 'Host nao permitido' });
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(cors({
  origin: (origin, cb) => cb(null, sec.origemAceita(origin, EXTRA_HOSTS)),
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Auth-Token', 'X-Token'],
}));
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
  if (typeof login !== 'string' || typeof senha !== 'string' || !login || !senha) {
    return res.status(400).json({ error: 'login/senha ausentes' });
  }
  const ip = ipDe(req);
  const espera = limitadorLogin.bloqueadoPorSegundos(ip, login);
  if (espera > 0) {
    res.setHeader('Retry-After', String(espera));
    return res.status(429).json({
      error: 'Muitas tentativas. Aguarde ' + Math.ceil(espera / 60) + ' minuto(s) e tente novamente.',
    });
  }
  try {
    const usuario = db.prepare('SELECT * FROM usuarios WHERE login=? AND ativo=1').get(login);
    if (!usuario || !sec.senhaConfere(usuario.senha, senha, hashSenha)) {
      limitadorLogin.registrarFalha(ip, login);
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }
    limitadorLogin.registrarSucesso(ip, login);
    const senhaPadrao = usuario.senha === SENHA_PADRAO_MASTER_HASH;
    const seguro = Object.assign({}, usuario);
    delete seguro.senha; // nunca devolve a senha/hash ao cliente
    res.json({
      usuario: seguro,
      token: sec.criarToken(SECRET, usuario),
      senha_padrao: senhaPadrao,
    });
  } catch (e) {
    log('login erro:', e.message);
    res.status(500).json({ error: 'Erro interno ao autenticar' });
  }
});

app.post('/api/logout', (req, res) => res.json({ ok: true }));

// SQL do front-end — protegido por token (modo strict), com bloqueios.
function validarSql(req, sql) {
  const motivo = sec.motivoBloqueioSql(sql);
  if (motivo) return { status: 400, error: motivo };
  if (req.usuarioAuth) {
    const negadas = sec.tabelasNegadas(sql, req.usuarioAuth);
    if (negadas.length) {
      return { status: 403, error: 'Sem permissao para alterar: ' + negadas.join(', ') };
    }
  }
  return null;
}

app.post('/api/sql/exec', autenticar, (req, res) => {
  const { sql, params } = req.body || {};
  if (typeof sql !== 'string' || !sql.trim()) {
    return res.status(400).json({ error: 'sql ausente' });
  }
  const bloqueio = validarSql(req, sql);
  if (bloqueio) {
    log('exec bloqueado:', bloqueio.error, '| sql:', sql.slice(0, 80));
    return res.status(bloqueio.status).json({ error: bloqueio.error });
  }
  try {
    res.json(execOne(sql, params));
  } catch (e) {
    log('exec erro:', e.message, '| sql:', sql.slice(0, 120));
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sql/exec-batch', autenticar, (req, res) => {
  const { statements } = req.body || {};
  if (!Array.isArray(statements)) {
    return res.status(400).json({ error: 'statements ausente' });
  }
  if (statements.length > 2000) {
    return res.status(400).json({ error: 'lote muito grande' });
  }
  for (const s of statements) {
    if (!s || typeof s.sql !== 'string' || !s.sql.trim()) {
      return res.status(400).json({ error: 'statement invalido no lote' });
    }
    const bloqueio = validarSql(req, s.sql);
    if (bloqueio) {
      log('batch bloqueado:', bloqueio.error, '| sql:', s.sql.slice(0, 80));
      return res.status(bloqueio.status).json({ error: bloqueio.error });
    }
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
app.post('/api/sql/notify', autenticar, (req, res) => {
  const { entidade, ids } = req.body || {};
  broadcast({ type: 'notify', entidade: entidade || null, ids: Array.isArray(ids) ? ids : [] });
  res.json({ ok: true });
});

// Registro de caixa adicional (chamado pelo index.html no setup, ANTES do
// login — por isso nao exige token). Campos sao validados/limitados.
function texto(v, max) {
  return typeof v === 'string' && v ? v.slice(0, max) : null;
}
app.post('/api/caixas-clientes/register', (req, res) => {
  const b = req.body || {};
  const identificador = texto(b.identificador, 80) || crypto.randomUUID();
  const nome = texto(b.nome, 120);
  const hostname = texto(b.hostname, 120);
  const versaoCliente = texto(b.versao_cliente, 40);
  const ip = ipDe(req);
  try {
    db.prepare(
      `INSERT INTO caixas_clientes (identificador, nome, hostname, versao_cliente, ip, ultimo_acesso)
       VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(identificador) DO UPDATE SET
         nome=excluded.nome, hostname=excluded.hostname,
         versao_cliente=excluded.versao_cliente, ip=excluded.ip,
         ultimo_acesso=CURRENT_TIMESTAMP`
    ).run(identificador, nome, hostname, versaoCliente, ip);
    broadcast({ type: 'caixa-registrado', identificador, nome });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------ Backup --------------------------------
const agendador = new bkp.AgendadorBackup({
  getDb: () => db,
  dir: BACKUP_DIR,
  dirExtra: BACKUP_DIR_EXTRA,
  hora: BACKUP_HORA,
  manter: BACKUP_MANTER,
  log,
});

// Backup: dump binario do arquivo .db (consumido por db.export()).
// Usa a API de backup online (copia consistente, sem travar as vendas).
app.get('/api/backup/dump', autenticar, async (req, res) => {
  const tmp = path.join(DATA_DIR, 'dump-' + crypto.randomBytes(6).toString('hex') + '.tmp');
  try {
    await db.backup(tmp);
    const buf = fs.readFileSync(tmp);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="system_pdv_pro.db"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

// Lista os backups automaticos existentes no servidor.
app.get('/api/backup/lista', autenticar, (req, res) => {
  res.json({ pasta: BACKUP_DIR, backups: bkp.listarBackups(BACKUP_DIR) });
});

// Dispara um backup agora (grava na pasta de backups do servidor).
app.post('/api/backup/agora', autenticar, async (req, res) => {
  const arquivo = await agendador.executar('manual');
  if (!arquivo) return res.status(500).json({ error: 'falha ao criar o backup (veja o log do servidor)' });
  res.json({ ok: true, arquivo: path.basename(arquivo) });
});

// Restore: substitui o banco por um .db enviado (multipart-free: corpo bruto).
app.post('/api/backup/restore', autenticar, express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
  const tmp = DB_PATH + '.restore';
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'arquivo vazio' });
    fs.writeFileSync(tmp, req.body);

    // Valida integridade e estrutura ANTES de tocar no banco atual.
    const v = bkp.validarArquivoBanco(Database, tmp);
    if (!v.ok) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      return res.status(400).json({ error: v.erro });
    }

    // Copia de seguranca do banco atual (permite desfazer a restauracao).
    const seguranca = await agendador.executar('pre-restore');

    // Fecha a conexao atual e remove os arquivos WAL/SHM do banco antigo —
    // se ficassem no disco, o SQLite tentaria reaplica-los sobre o banco
    // restaurado, "desfazendo" parte da restauracao.
    db.close();
    for (const ext of ['-wal', '-shm']) {
      try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
    }
    fs.copyFileSync(tmp, DB_PATH);
    fs.unlinkSync(tmp);
    // Reabre o banco no MESMO processo (sem matar o servidor).
    db = openDatabase();
    broadcast({ type: 'restore' });
    res.json({ ok: true, restart: false, copia_seguranca: seguranca ? path.basename(seguranca) : null });
    log('Backup restaurado — banco reaberto no mesmo processo.');
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    // Se o banco foi fechado e a reabertura falhou, tenta recuperar a conexao.
    try { db.prepare('SELECT 1').get(); } catch (_) {
      try { db = openDatabase(); } catch (e2) { log('ERRO ao reabrir banco apos falha de restore:', e2.message); }
    }
    res.status(500).json({ error: e.message });
  }
});

// ---------------------- Estaticos (index/app) -------------------------
app.use(express.static(STATIC_DIR, { extensions: ['html'], dotfiles: 'ignore' }));
app.get('/', (req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));

// Erros nao tratados nas rotas (ex.: JSON invalido) -> resposta limpa.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalido' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Corpo da requisicao muito grande' });
  }
  log('erro nao tratado:', err && err.message);
  res.status(500).json({ error: 'Erro interno' });
});

// ---------------------- HTTP + WebSocket ------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  // Mesma regra de origem do CORS (o WebSocket nao passa pelo middleware cors).
  verifyClient: (info) => sec.origemAceita(info.origin, EXTRA_HOSTS) &&
    sec.hostHeaderAceito(info.req.headers.host, EXTRA_HOSTS),
});

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
}, 30000).unref();

server.listen(PORT, HOST, () => {
  log(`System PDV PRO Server v${VERSION} ouvindo em http://${HOST}:${PORT}`);
  log('Autenticacao: modo ' + AUTH_MODE + (AUTH_MODE === 'soft'
    ? ' (requisicoes sem token sao aceitas; use PDV_AUTH_MODE=strict apos atualizar o front-end)'
    : ' (token obrigatorio)'));
  const nets = os.networkInterfaces();
  Object.values(nets).flat().forEach((ni) => {
    if (ni && ni.family === 'IPv4' && !ni.internal) {
      log(`  Rede: http://${ni.address}:${PORT}  (use este endereco nos caixas)`);
    }
  });
  if (!BACKUP_DESLIGADO) {
    agendador.iniciar();
    log('Backup automatico: diario apos as ' + BACKUP_HORA + 'h em ' + BACKUP_DIR +
      ' (mantem ' + BACKUP_MANTER + ')' + (BACKUP_DIR_EXTRA ? ' + copia em ' + BACKUP_DIR_EXTRA : ''));
  }
});

// Erros inesperados nao devem derrubar o servidor em silencio.
process.on('uncaughtException', (e) => { log('uncaughtException:', e && e.stack || e); });
process.on('unhandledRejection', (e) => { log('unhandledRejection:', e && e.stack || e); });

let encerrando = false;
function encerrar() {
  if (encerrando) return;
  encerrando = true;
  log('Encerrando...');
  agendador.parar();
  try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
