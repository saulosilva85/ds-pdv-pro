const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const Database = require('./adapter');
const S = '../';
const { inicializarSchema, hashSenha, zerarDados, HASH_ADMIN_LEGADO, SENHA_PADRAO_MASTER_HASH, SENHA_MASTER_ANTIGA_HASH, SCHEMA_VERSION } = require(S + 'schema');
const sec = require(S + 'security');
const bkp = require(S + 'backup');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-'));
const logs = [];
const log = (...a) => logs.push(a.join(' '));

test('schema: banco novo cria tudo, versao e seeds (sem admin legado)', () => {
  const dir = tmp(); const db = new Database(path.join(dir, 'a.db'));
  inicializarSchema(db, log);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  const users = db.prepare('SELECT login, ativo FROM usuarios').all();
  assert.deepEqual(users.map(u => u.login), ['master']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM perfis').get().c, 3);
  const idx = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").get().c;
  assert.ok(idx >= 10, 'indices criados: ' + idx);
});

test('schema: idempotente (rodar 2x nao quebra nem duplica)', () => {
  const db = new Database(path.join(tmp(), 'b.db'));
  inicializarSchema(db, log); inicializarSchema(db, log);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM usuarios').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM perfis').get().c, 3);
});

test('schema: banco ANTIGO com admin legado ativo -> admin e desativado, dados preservados', () => {
  const db = new Database(path.join(tmp(), 'c.db'));
  // simula instalacao antiga (versao 0): cria tabelas + admin legado + dados reais
  inicializarSchema(db, log);
  db.exec('PRAGMA user_version = 0');
  db.exec('DROP TRIGGER trg_bloqueia_senha_legada_ins; DROP TRIGGER trg_bloqueia_senha_legada_upd');
  db.prepare("INSERT INTO usuarios (nome,login,senha,nivel,ativo) VALUES ('Admin','admin',?, 'master',1)").run(HASH_ADMIN_LEGADO);
  db.prepare("INSERT INTO produtos (nome,preco_venda) VALUES ('Arroz',10)").run();
  inicializarSchema(db, log);
  assert.equal(db.prepare("SELECT ativo FROM usuarios WHERE login='admin'").get().ativo, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM produtos").get().c, 1);
  assert.equal(db.prepare("SELECT ativo FROM usuarios WHERE login='master'").get().ativo, 1);
});

test('schema: front-end recriando o admin legado (INSERT/UPDATE) e neutralizado por trigger', () => {
  const db = new Database(path.join(tmp(), 'd.db'));
  inicializarSchema(db, log);
  db.prepare("INSERT INTO usuarios (nome,login,senha,nivel,ativo) VALUES ('A','admin',?, 'master',1)").run(HASH_ADMIN_LEGADO);
  assert.equal(db.prepare("SELECT ativo FROM usuarios WHERE login='admin'").get().ativo, 0);
  db.prepare("UPDATE usuarios SET ativo=1 WHERE login='admin'").run();
  assert.equal(db.prepare("SELECT ativo FROM usuarios WHERE login='admin'").get().ativo, 0);
});

test('schema: se so existir master inativo, nao tenta recriar (sem violar UNIQUE)', () => {
  const db = new Database(path.join(tmp(), 'e.db'));
  inicializarSchema(db, log);
  db.prepare("UPDATE usuarios SET ativo=0 WHERE login='master'").run();
  assert.doesNotThrow(() => inicializarSchema(db, log));
});

test('senha: aceita hash pronto e texto puro; recusa errada', () => {
  const h = hashSenha('abc123');
  assert.ok(sec.senhaConfere(h, h, hashSenha));
  assert.ok(sec.senhaConfere(h, 'abc123', hashSenha));
  assert.ok(!sec.senhaConfere(h, 'errada', hashSenha));
  assert.ok(!sec.senhaConfere(h, '', hashSenha));
  assert.equal(hashSenha('master'), SENHA_MASTER_ANTIGA_HASH); // a antiga senha de fabrica continua sendo reconhecida so para migracao
});

test('token: valido, adulterado, expirado, formato invalido', () => {
  const seg = 'x'.repeat(64);
  const t = sec.criarToken(seg, { id: 7, login: 'ana' }, 1000, 5000);
  assert.equal(sec.verificarToken(seg, t, 2000).id, 7);
  assert.equal(sec.verificarToken(seg, t, 7000), null);               // expirado
  assert.equal(sec.verificarToken('outro'.repeat(10), t, 2000), null); // segredo diferente
  const [p, s] = t.split('.');
  const forjado = Buffer.from(JSON.stringify({ id: 1, login: 'master', exp: 9e15 })).toString('base64url');
  assert.equal(sec.verificarToken(seg, forjado + '.' + s, 2000), null); // payload forjado
  assert.equal(sec.verificarToken(seg, 'lixo', 2000), null);
  assert.equal(sec.verificarToken(seg, undefined, 2000), null);
});

test('token: extrai de Authorization, X-Auth-Token, query e body', () => {
  assert.equal(sec.extrairToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(sec.extrairToken({ headers: { 'x-auth-token': 'def' } }), 'def');
  assert.equal(sec.extrairToken({ headers: {}, query: { token: 'ghi' } }), 'ghi');
  assert.equal(sec.extrairToken({ headers: {}, body: { token: 'jkl' } }), 'jkl');
  assert.equal(sec.extrairToken({ headers: {} }), null);
});

test('segredo: persiste entre reinicios', () => {
  const dir = tmp();
  const a = sec.carregarSegredo(dir), b = sec.carregarSegredo(dir);
  assert.equal(a, b); assert.ok(a.length >= 32);
});

test('limitador de login: bloqueia na 5a falha, libera depois, sucesso zera', () => {
  const l = new sec.LimitadorLogin({ maxFalhas: 5, janelaMs: 600000, bloqueioMs: 300000 });
  for (let i = 0; i < 4; i++) l.registrarFalha('1.1.1.1', 'Ana', 1000);
  assert.equal(l.bloqueadoPorSegundos('1.1.1.1', 'ana', 1000), 0);
  l.registrarFalha('1.1.1.1', 'ana', 1000);
  assert.equal(l.bloqueadoPorSegundos('1.1.1.1', 'ana', 1000), 300);
  assert.equal(l.bloqueadoPorSegundos('1.1.1.1', 'ana', 1000 + 301000), 0);
  assert.equal(l.bloqueadoPorSegundos('2.2.2.2', 'ana', 1000), 0); // outro IP nao afetado
  l.registrarFalha('3.3.3.3', 'bia', 1); l.registrarSucesso('3.3.3.3', 'bia');
  assert.equal(l.mapa.size, 1); // so o bloqueio de 1.1.1.1/ana permanece
});

test('Host/Origin: aceita rede local, recusa sites externos e rebinding', () => {
  const ok = ['localhost:8765', '127.0.0.1:8765', '192.168.0.10:8765', 'SERVIDOR:8765', '[::1]:8765', 'caixa1.local:8765', 'tauri.localhost'];
  const ruim = ['evil.com', 'evil.com:8765', 'pdv.minhaloja.com.br', ''];
  ok.forEach(h => assert.ok(sec.hostHeaderAceito(h), 'deveria aceitar ' + h));
  ruim.forEach(h => assert.ok(!sec.hostHeaderAceito(h), 'deveria recusar ' + h));
  assert.ok(sec.hostHeaderAceito('pdv.minhaloja.com.br', ['pdv.minhaloja.com.br']));
  ['http://tauri.localhost', 'tauri://localhost', 'http://192.168.1.5:8765', 'http://localhost:1420', undefined]
    .forEach(o => assert.ok(sec.origemAceita(o), 'origem ' + o));
  ['https://evil.com', 'http://evil.com:8765', 'null', 'file://x', 'tauri://evil'].forEach(o => assert.ok(!sec.origemAceita(o), 'origem ' + o));
});

test('SQL guard: bloqueia perigosos, libera o uso normal do PDV', () => {
  const bloq = ["ATTACH DATABASE '/etc/x' AS x", "  /*x*/ attach 'a' as b", 'DETACH x', 'VACUUM INTO "/tmp/a.db"', 'VACUUM',
    'PRAGMA writable_schema=1', 'PRAGMA journal_mode=DELETE', "SELECT load_extension('x')"];
  bloq.forEach(s => assert.ok(sec.motivoBloqueioSql(s), 'deveria bloquear: ' + s));
  const ok = ['SELECT * FROM produtos WHERE nome LIKE ?', 'INSERT INTO vendas (total) VALUES (?)', 'UPDATE produtos SET estoque=estoque-? WHERE id=?',
    'CREATE TABLE IF NOT EXISTS x (id INTEGER)', 'ALTER TABLE produtos ADD COLUMN foto TEXT', 'PRAGMA table_info(produtos)',
    'CREATE INDEX IF NOT EXISTS i ON vendas(data)', 'DELETE FROM carrinho', "SELECT 'attach' AS palavra", 'BEGIN', 'COMMIT'];
  ok.forEach(s => assert.equal(sec.motivoBloqueioSql(s), null, 'deveria liberar: ' + s));
});

test('permissao por tabela: caixa nao altera usuarios/perfis; master e gerente com permissao sim', () => {
  const caixa = { nivel: 'caixa', permissoes: ['pdv', 'caixa'] };
  const master = { nivel: 'master', permissoes: [] };
  const gerente = { nivel: 'gerente', permissoes: ['usuarios', 'empresa'] };
  assert.deepEqual(sec.tabelasNegadas("UPDATE usuarios SET nivel='master' WHERE id=2", caixa), ['usuarios']);
  assert.deepEqual(sec.tabelasNegadas('DELETE FROM perfis', caixa), ['perfis']);
  assert.deepEqual(sec.tabelasNegadas('INSERT OR REPLACE INTO usuarios (nome) VALUES (1)', caixa), ['usuarios']);
  assert.deepEqual(sec.tabelasNegadas('update   "usuarios" set x=1', caixa), ['usuarios']);
  assert.deepEqual(sec.tabelasNegadas('UPDATE usuarios SET x=1', master), []);
  assert.deepEqual(sec.tabelasNegadas('UPDATE usuarios SET x=1', gerente), []);
  assert.deepEqual(sec.tabelasNegadas('UPDATE perfis SET x=1', gerente), ['perfis']);
  assert.deepEqual(sec.tabelasNegadas('SELECT * FROM usuarios', caixa), []);               // leitura nao e bloqueada
  assert.deepEqual(sec.tabelasNegadas('INSERT INTO vendas (total) VALUES (1)', caixa), []); // operacao normal
  assert.deepEqual(sec.tabelasNegadas('UPDATE caixa SET status=1', caixa), []);
});

test('backup: cria, lista, rotaciona e decide agendamento', async () => {
  const dir = tmp(), bdir = path.join(dir, 'bk');
  const db = new Database(path.join(dir, 'f.db')); inicializarSchema(db, log);
  assert.ok(bkp.precisaBackupAutomatico(bdir, 23, new Date(2026, 9, 31, 10)));          // nenhum ainda
  for (let i = 1; i <= 5; i++) await bkp.criarBackup(db, bdir, 'auto', new Date(2026, 9, i, 23, 0, 0));
  assert.equal(bkp.listarBackups(bdir).length, 5);
  assert.deepEqual(bkp.rotacionar(bdir, 3, 'auto').length, 2);
  assert.equal(bkp.listarBackups(bdir)[0].dia, '20261005');
  assert.ok(!bkp.precisaBackupAutomatico(bdir, 23, new Date(2026, 9, 5, 23, 30)));       // ja tem hoje
  assert.ok(!bkp.precisaBackupAutomatico(bdir, 23, new Date(2026, 9, 6, 10)));           // ainda nao deu a hora
  assert.ok(bkp.precisaBackupAutomatico(bdir, 23, new Date(2026, 9, 6, 23, 5)));         // hora e sem backup do dia
  assert.equal(bkp.listarBackups(bdir).filter(b => b.tipo === 'pre-restore').length, 0);
});

test('restore: valida banco bom, recusa lixo e banco de outro sistema', () => {
  const dir = tmp();
  const bom = path.join(dir, 'bom.db'); const d1 = new Database(bom); inicializarSchema(d1, log); d1.close();
  assert.ok(bkp.validarArquivoBanco(Database, bom).ok);
  const lixo = path.join(dir, 'lixo.db'); fs.writeFileSync(lixo, 'isto nao e sqlite');
  assert.ok(!bkp.validarArquivoBanco(Database, lixo).ok);
  const outro = path.join(dir, 'outro.db'); const d2 = new Database(outro); d2.exec('CREATE TABLE t(x)'); d2.close();
  const r = bkp.validarArquivoBanco(Database, outro);
  assert.ok(!r.ok && /faltam/.test(r.erro));
});

test('migration v4: restaurar backup antigo SEM as colunas novas -> colunas recriadas, dados mantidos', () => {
  const db = new Database(path.join(tmp(), 'g.db'));
  inicializarSchema(db, log);
  db.prepare("INSERT INTO produtos (nome,preco_venda) VALUES ('Feijao',8)").run();
  db.exec('DROP INDEX IF EXISTS idx_vendas_caixa'); // indice precisa sair antes da coluna
  db.exec('ALTER TABLE produtos DROP COLUMN foto; ALTER TABLE caixa DROP COLUMN total_sangrias; ALTER TABLE vendas DROP COLUMN caixa_id;');
  db.exec('PRAGMA user_version = 3');
  inicializarSchema(db, log);
  const cols = (t) => db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
  assert.ok(cols('produtos').includes('foto'));
  assert.ok(cols('caixa').includes('total_sangrias'));
  assert.ok(cols('vendas').includes('caixa_id'));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM produtos').get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='idx_vendas_caixa'").get().c, 1); // indice recriado
});

test('zerarDados: apaga tudo, recria master/perfis/empresa e nao revive o admin legado', () => {
  const db = new Database(path.join(tmp(), 'h.db'));
  inicializarSchema(db, log);
  db.prepare("INSERT INTO produtos (nome,preco_venda) VALUES ('X',1)").run();
  db.prepare("INSERT INTO usuarios (nome,login,senha,nivel,ativo) VALUES ('Ana','ana','H1_1','caixa',1)").run();
  db.prepare("INSERT INTO configuracoes (chave,valor) VALUES ('a','b')").run();
  zerarDados(db);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM produtos').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM configuracoes').get().c, 0);
  assert.deepEqual(db.prepare('SELECT login FROM usuarios').all().map(u => u.login), ['master']);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM perfis').get().c, 3);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM empresa').get().c, 1);
});

test('zerarDados: se falhar no meio, nada e apagado (transacao)', () => {
  const db = new Database(path.join(tmp(), 'i.db'));
  inicializarSchema(db, log);
  db.prepare("INSERT INTO produtos (nome,preco_venda) VALUES ('Y',1)").run();
  db.exec('DROP TABLE configuracoes'); // forca erro no DELETE da ultima tabela
  assert.throws(() => zerarDados(db));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM produtos').get().c, 1);
});

test('backup: novos arquivos usam o prefixo ds_pdv_pro', async () => {
  const dir = tmp(), bdir = path.join(dir, 'bk');
  const db = new Database(path.join(dir, 'j.db')); inicializarSchema(db, log);
  const novo = await bkp.criarBackup(db, bdir, 'auto', new Date(2026, 10, 3, 23, 0, 0));
  assert.match(path.basename(novo), /^ds_pdv_pro-auto-20261103-230000\.db$/);
  assert.equal(bkp.listarBackups(bdir).length, 1);
});

test('master: banco novo ja nasce com a senha padrao nova; a antiga "master" nao funciona mais', () => {
  const db = new Database(path.join(tmp(), 'k.db')); inicializarSchema(db, log);
  const m = db.prepare("SELECT senha FROM usuarios WHERE login='master'").get();
  assert.equal(m.senha, SENHA_PADRAO_MASTER_HASH);
  assert.ok(sec.senhaConfere(m.senha, SENHA_PADRAO_MASTER_HASH, hashSenha));
  assert.ok(!sec.senhaConfere(m.senha, 'master', hashSenha));
});

test('migration v5: master com a senha antiga passa para a nova; senha escolhida pelo dono nao e tocada', () => {
  const a = new Database(path.join(tmp(), 'l.db')); inicializarSchema(a, log);
  a.prepare("UPDATE usuarios SET senha=? WHERE login='master'").run(SENHA_MASTER_ANTIGA_HASH);
  a.exec('PRAGMA user_version = 4'); inicializarSchema(a, log);
  assert.equal(a.prepare("SELECT senha FROM usuarios WHERE login='master'").get().senha, SENHA_PADRAO_MASTER_HASH);

  const b = new Database(path.join(tmp(), 'm.db')); inicializarSchema(b, log);
  b.prepare("UPDATE usuarios SET senha='Hcustom_1' WHERE login='master'").run();
  b.exec('PRAGMA user_version = 4'); inicializarSchema(b, log);
  assert.equal(b.prepare("SELECT senha FROM usuarios WHERE login='master'").get().senha, 'Hcustom_1');
});

test('zerarDados: o master recriado usa a senha padrao nova', () => {
  const db = new Database(path.join(tmp(), 'n.db')); inicializarSchema(db, log);
  db.prepare("UPDATE usuarios SET senha='Hcustom_1' WHERE login='master'").run();
  zerarDados(db);
  assert.equal(db.prepare("SELECT senha FROM usuarios WHERE login='master'").get().senha, SENHA_PADRAO_MASTER_HASH);
});
