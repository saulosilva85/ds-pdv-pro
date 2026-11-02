'use strict';

// =====================================================================
// DS PDV PRO — backup automatico do banco SQLite.
//  - Backup online (API db.backup do better-sqlite3), sem parar as vendas.
//  - Um backup por dia, apos a hora configurada (padrao 23h) e tambem um
//    imediato se ainda nao existir nenhum.
//  - Rotacao: mantem os N mais recentes (padrao 14).
//  - Copia opcional para uma segunda pasta (pen drive / pasta de rede).
//  - Copia de seguranca automatica antes de qualquer restauracao.
// =====================================================================

const fs = require('fs');
const path = require('path');

const PREFIXO_ARQ = 'ds_pdv_pro-';
const RE_ARQ = /^ds_pdv_pro-(auto|manual|pre-restore)-(\d{8})-(\d{6})\.db$/;

function pad(n) { return String(n).padStart(2, '0'); }

function carimbo(d = new Date()) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function dataDoCarimbo(d = new Date()) {
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}

async function criarBackup(db, dir, tipo = 'auto', agora = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, PREFIXO_ARQ + tipo + '-' + carimbo(agora) + '.db');
  await db.backup(destino);
  return destino;
}

function listarBackups(dir) {
  let nomes = [];
  try { nomes = fs.readdirSync(dir); } catch (_) { return []; }
  return nomes
    .map((nome) => {
      const m = nome.match(RE_ARQ);
      if (!m) return null;
      let tamanho = 0;
      try { tamanho = fs.statSync(path.join(dir, nome)).size; } catch (_) { return null; }
      return { nome, tipo: m[1], dia: m[2], hora: m[3], tamanho };
    })
    .filter(Boolean)
    .sort((a, b) => (b.dia + b.hora).localeCompare(a.dia + a.hora));
}

// Mantem os `manter` mais recentes de cada tipo; apaga o restante.
function rotacionar(dir, manter, tipo) {
  const doTipo = listarBackups(dir).filter((b) => b.tipo === tipo);
  const apagados = [];
  for (const b of doTipo.slice(Math.max(0, manter))) {
    try { fs.unlinkSync(path.join(dir, b.nome)); apagados.push(b.nome); } catch (_) {}
  }
  return apagados;
}

// Decide se esta na hora de um backup automatico.
function precisaBackupAutomatico(dir, hora, agora = new Date()) {
  const autos = listarBackups(dir).filter((b) => b.tipo === 'auto');
  if (autos.length === 0) return true; // primeira execucao
  if (agora.getHours() < hora) return false;
  const hoje = dataDoCarimbo(agora);
  return !autos.some((b) => b.dia === hoje);
}

// Valida um arquivo .db antes de restaurar: precisa abrir, passar no
// integrity_check e conter as tabelas essenciais do PDV.
function validarArquivoBanco(Database, arquivo) {
  const obrigatorias = ['usuarios', 'produtos', 'vendas', 'venda_itens', 'caixa'];
  let d;
  try {
    d = new Database(arquivo, { readonly: true });
    const integ = d.prepare('PRAGMA integrity_check').all();
    const ok = integ.length === 1 && String(Object.values(integ[0])[0]).toLowerCase() === 'ok';
    if (!ok) return { ok: false, erro: 'o arquivo esta corrompido (integrity_check falhou)' };
    const tabelas = new Set(
      d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );
    const faltando = obrigatorias.filter((t) => !tabelas.has(t));
    if (faltando.length) {
      return { ok: false, erro: 'nao parece um banco do DS PDV PRO (faltam: ' + faltando.join(', ') + ')' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: 'arquivo invalido: ' + e.message };
  } finally {
    try { if (d) d.close(); } catch (_) {}
  }
}

class AgendadorBackup {
  // getDb: funcao que devolve a conexao atual (o restore troca a conexao).
  constructor({ getDb, dir, dirExtra = '', hora = 23, manter = 14, log = () => {} }) {
    this.getDb = getDb;
    this.dir = dir;
    this.dirExtra = dirExtra;
    this.hora = hora;
    this.manter = manter;
    this.log = log;
    this.timer = null;
    this.rodando = false;
  }

  async executar(tipo = 'auto') {
    if (this.rodando) return null;
    this.rodando = true;
    try {
      const arquivo = await criarBackup(this.getDb(), this.dir, tipo);
      this.log('Backup ' + tipo + ' criado:', arquivo);
      rotacionar(this.dir, tipo === 'auto' ? this.manter : 5, tipo);
      if (this.dirExtra) {
        try {
          fs.mkdirSync(this.dirExtra, { recursive: true });
          fs.copyFileSync(arquivo, path.join(this.dirExtra, path.basename(arquivo)));
          rotacionar(this.dirExtra, tipo === 'auto' ? this.manter : 5, tipo);
        } catch (e) {
          this.log('Aviso: nao foi possivel copiar o backup para', this.dirExtra, '-', e.message);
        }
      }
      return arquivo;
    } catch (e) {
      this.log('ERRO no backup ' + tipo + ':', e.message);
      return null;
    } finally {
      this.rodando = false;
    }
  }

  async verificar() {
    if (precisaBackupAutomatico(this.dir, this.hora)) await this.executar('auto');
  }

  iniciar() {
    // Primeira verificacao apos 30s (deixa o servidor subir), depois a cada minuto.
    setTimeout(() => { this.verificar(); }, 30 * 1000).unref();
    this.timer = setInterval(() => { this.verificar(); }, 60 * 1000);
    this.timer.unref();
  }

  parar() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = {
  criarBackup,
  listarBackups,
  rotacionar,
  precisaBackupAutomatico,
  validarArquivoBanco,
  AgendadorBackup,
};
