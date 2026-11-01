'use strict';

// =====================================================================
// System PDV PRO — utilitarios de seguranca do servidor.
// Sem dependencias externas (somente modulos nativos do Node), para poder
// ser testado isoladamente.
// =====================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ------------------------------ Segredo -------------------------------
// O segredo que assina os tokens fica em disco (DATA_DIR/.token_secret),
// para que as sessoes dos caixas sobrevivam a uma reinicializacao do
// servidor. Se o arquivo nao puder ser lido/gravado, cai para um segredo
// em memoria (as sessoes expiram ao reiniciar).
function carregarSegredo(dataDir) {
  const file = path.join(dataDir, '.token_secret');
  try {
    const existente = fs.readFileSync(file, 'utf8').trim();
    if (existente.length >= 32) return existente;
  } catch (_) { /* arquivo ainda nao existe */ }
  const novo = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, novo, { mode: 0o600 });
  } catch (_) { /* segue com segredo em memoria */ }
  return novo;
}

// ------------------------------- Tokens -------------------------------
const TOKEN_TTL_MS_PADRAO = 12 * 60 * 60 * 1000; // 12 horas

function criarToken(segredo, usuario, agora = Date.now(), ttlMs = TOKEN_TTL_MS_PADRAO) {
  const payload = Buffer.from(JSON.stringify({
    id: usuario.id,
    login: usuario.login,
    iat: agora,
    exp: agora + ttlMs,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', segredo).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function iguaisSeguro(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Devolve o payload do token ou null (assinatura invalida, expirado, etc.).
function verificarToken(segredo, token, agora = Date.now()) {
  if (typeof token !== 'string') return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const [payload, sig] = partes;
  const esperado = crypto.createHmac('sha256', segredo).update(payload).digest('base64url');
  if (!iguaisSeguro(sig, esperado)) return null;
  try {
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!dados || typeof dados.id === 'undefined') return null;
    if (typeof dados.exp !== 'number' || dados.exp < agora) return null;
    return dados;
  } catch (_) {
    return null;
  }
}

// Aceita o token em varios lugares, para ser compativel com o front-end.
function extrairToken(req) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const h = req.headers['x-auth-token'] || req.headers['x-token'];
  if (typeof h === 'string' && h) return h.trim();
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  if (req.body && typeof req.body === 'object' && typeof req.body.token === 'string') {
    return req.body.token;
  }
  return null;
}

// ------------------------------- Senhas -------------------------------
// O front-end atual guarda e envia o "hash" calculado por hashSenha()
// (app.html). Aceitamos tanto o hash pronto quanto a senha em texto puro
// (que e convertida pelo mesmo algoritmo), com comparacao em tempo
// constante. Quando o front-end passar a enviar a senha em texto puro, o
// servidor podera migrar o armazenamento para scrypt sem mudar este contrato.
function senhaConfere(armazenado, informado, hashSenhaFn) {
  if (typeof armazenado !== 'string' || typeof informado !== 'string') return false;
  if (!armazenado || !informado) return false;
  if (iguaisSeguro(armazenado, informado)) return true;
  return iguaisSeguro(armazenado, hashSenhaFn(informado));
}

// -------------------------- Limitador de login ------------------------
class LimitadorLogin {
  constructor({ maxFalhas = 5, janelaMs = 10 * 60 * 1000, bloqueioMs = 5 * 60 * 1000 } = {}) {
    this.maxFalhas = maxFalhas;
    this.janelaMs = janelaMs;
    this.bloqueioMs = bloqueioMs;
    this.mapa = new Map();
  }

  _chave(ip, login) {
    return String(ip) + '|' + String(login || '').toLowerCase();
  }

  // Segundos restantes de bloqueio (0 = liberado).
  bloqueadoPorSegundos(ip, login, agora = Date.now()) {
    const e = this.mapa.get(this._chave(ip, login));
    if (!e || !e.ate || e.ate <= agora) return 0;
    return Math.ceil((e.ate - agora) / 1000);
  }

  registrarFalha(ip, login, agora = Date.now()) {
    const k = this._chave(ip, login);
    let e = this.mapa.get(k);
    if (!e || agora - e.inicio > this.janelaMs) {
      e = { falhas: 0, inicio: agora, ate: 0 };
    }
    e.falhas += 1;
    if (e.falhas >= this.maxFalhas) {
      e.ate = agora + this.bloqueioMs;
      e.falhas = 0;
      e.inicio = agora;
    }
    this.mapa.set(k, e);
  }

  registrarSucesso(ip, login) {
    this.mapa.delete(this._chave(ip, login));
  }

  limpar(agora = Date.now()) {
    for (const [k, e] of this.mapa) {
      if ((!e.ate || e.ate <= agora) && agora - e.inicio > this.janelaMs) this.mapa.delete(k);
    }
  }
}

// ------------------------- Origem / Host permitidos -------------------
function ipv4Privado(h) {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 169 && b === 254);
}

function ehIp(h) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
}

// Hostname aceito: localhost, IPs, nomes de rede local (sem ponto, .local,
// .lan, .home.arpa, .internal) e os hosts extras da variavel
// PDV_ALLOWED_HOSTS (ex.: dominio proprio de acesso remoto).
function hostnameAceito(hostname, extras = []) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (extras.includes(h)) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true; // inclui tauri.localhost
  if (ehIp(h)) return true;
  if (!h.includes('.')) return true; // nome NetBIOS/hostname simples da rede local
  return ['.local', '.lan', '.home.arpa', '.internal'].some((suf) => h.endsWith(suf));
}

// Valida o cabecalho Host (protecao contra DNS rebinding).
function hostHeaderAceito(hostHeader, extras = []) {
  if (!hostHeader) return false;
  let host = String(hostHeader);
  if (host.startsWith('[')) {
    host = host.slice(0, host.indexOf(']') + 1);
  } else {
    host = host.replace(/:\d+$/, '');
  }
  return hostnameAceito(host, extras);
}

// Valida o cabecalho Origin (CORS). Sem Origin = requisicao nao-navegador
// ou mesma origem: permitido.
function origemAceita(origin, extras = []) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.protocol === 'tauri:') return u.hostname === 'localhost';
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return hostnameAceito(u.hostname, extras);
  } catch (_) {
    return false;
  }
}

// ------------------------------ SQL guard -----------------------------
// O front-end envia SQL puro (contrato legado). Enquanto esse contrato
// existir, bloqueamos o que nunca e necessario e e perigoso: anexar outros
// bancos, extensoes, PRAGMAs de escrita e VACUUM INTO.
const PRAGMAS_PERMITIDOS = new Set([
  'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info',
  'index_xinfo', 'foreign_key_list', 'foreign_keys', 'user_version',
  'database_list',
]);

function removerComentarios(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

// Devolve uma mensagem de bloqueio ou null se o SQL e aceitavel.
function motivoBloqueioSql(sql) {
  const s = removerComentarios(sql).trim();
  const verbo = (s.match(/^[a-z]+/i) || [''])[0].toLowerCase();
  if (verbo === 'attach' || verbo === 'detach') return 'ATTACH/DETACH nao e permitido';
  if (verbo === 'vacuum') return 'VACUUM nao e permitido';
  if (verbo === 'pragma') {
    const nome = (s.match(/^pragma\s+(?:\w+\.)?(\w+)/i) || [])[1];
    if (!nome || !PRAGMAS_PERMITIDOS.has(nome.toLowerCase())) {
      return 'PRAGMA nao permitido: ' + (nome || '?');
    }
  }
  if (/\bload_extension\s*\(/i.test(s)) return 'load_extension nao e permitido';
  if (/\bwritable_schema\b/i.test(s)) return 'writable_schema nao e permitido';
  return null;
}

// Tabelas alvo de comandos que ESCREVEM (INSERT/UPDATE/DELETE/DDL).
const ESCRITA_RE = new RegExp(
  '\\b(?:insert\\s+(?:or\\s+\\w+\\s+)?into|replace\\s+into|update\\s+(?:or\\s+\\w+\\s+)?|' +
  'delete\\s+from|drop\\s+(?:table|view)\\s+(?:if\\s+exists\\s+)?|alter\\s+table|' +
  'create\\s+(?:temp(?:orary)?\\s+)?(?:table|view)\\s+(?:if\\s+not\\s+exists\\s+)?)' +
  '\\s*["`\\[]?(?:main\\.)?([a-z_][a-z0-9_]*)',
  'gi'
);

function tabelasEscritas(sql) {
  const s = removerComentarios(sql);
  const out = new Set();
  let m;
  ESCRITA_RE.lastIndex = 0;
  while ((m = ESCRITA_RE.exec(s)) !== null) out.add(m[1].toLowerCase());
  return [...out];
}

// Tabelas sensiveis -> permissao do perfil necessaria para altera-las.
const TABELAS_PROTEGIDAS = {
  usuarios: 'usuarios',
  perfis: 'perfis',
  empresa: 'empresa',
};

// usuario: { nivel, permissoes: string[] }. Devolve a lista de tabelas
// protegidas que o usuario NAO pode alterar.
function tabelasNegadas(sql, usuario) {
  if (usuario && usuario.nivel === 'master') return [];
  const perms = new Set((usuario && usuario.permissoes) || []);
  return tabelasEscritas(sql).filter((t) => {
    const exigida = TABELAS_PROTEGIDAS[t];
    return exigida && !perms.has(exigida);
  });
}

module.exports = {
  carregarSegredo,
  criarToken,
  verificarToken,
  extrairToken,
  senhaConfere,
  LimitadorLogin,
  hostnameAceito,
  hostHeaderAceito,
  origemAceita,
  motivoBloqueioSql,
  tabelasEscritas,
  tabelasNegadas,
  ipv4Privado,
  TOKEN_TTL_MS_PADRAO,
};
