'use strict';

// Schema e seeds do System PDV PRO replicados 1:1 do contrato definido em
// app.html (funcao criarEstrutura). O servidor cria as tabelas e os seeds
// no boot, garantindo que login e operacao funcionem mesmo antes do
// front-end rodar a sua propria criarEstrutura() (que e idempotente).

// Hash identico ao hashSenha() do app.html — precisa bater byte a byte
// para o login funcionar tanto pela API quanto pelo fallback SQL.
function hashSenha(senha) {
  let hash = 0;
  const str = 'pdvpro_' + senha + '_salt2026';
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return 'H' + Math.abs(hash).toString(36) + '_' + str.length;
}

const PERMISSOES_TODAS = [
  'dashboard', 'pdv', 'produtos', 'produtos_novo', 'produtos_editar',
  'produtos_excluir', 'categorias', 'clientes', 'clientes_excluir',
  'fornecedores', 'vendas', 'vendas_cancelar', 'caixa', 'caixa_abrir',
  'caixa_fechar', 'caixa_sangria', 'caixa_suprimento', 'estoque',
  'estoque_movimentar', 'nfe_entrada', 'nfe_entrada_importar', 'contas_pagar',
  'contas_receber', 'relatorios', 'usuarios', 'perfis', 'empresa',
  'config_vendas', 'impressora', 'backup'
];

const PERMISSOES_GERENTE = [
  'dashboard', 'pdv', 'produtos', 'produtos_novo', 'produtos_editar',
  'categorias', 'clientes', 'fornecedores',
  'vendas', 'vendas_cancelar', 'caixa', 'caixa_abrir', 'caixa_fechar',
  'caixa_sangria', 'caixa_suprimento',
  'estoque', 'estoque_movimentar',
  'nfe_entrada', 'nfe_entrada_importar', 'contas_pagar', 'contas_receber',
  'relatorios', 'empresa', 'config_vendas', 'impressora', 'backup'
];

const PERMISSOES_CAIXA = [
  'dashboard', 'pdv', 'clientes', 'caixa', 'caixa_abrir', 'caixa_fechar',
  'caixa_sangria', 'caixa_suprimento', 'vendas'
];

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL, login TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL, nivel TEXT NOT NULL,
      perfil_id INTEGER, ativo INTEGER DEFAULT 1,
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS empresa (
      id INTEGER PRIMARY KEY, razao_social TEXT, nome_fantasia TEXT,
      cnpj TEXT, ie TEXT, endereco TEXT, telefone TEXT, email TEXT,
      logo TEXT, rodape TEXT
    );
    CREATE TABLE IF NOT EXISTS categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, descricao TEXT
    );
    CREATE TRIGGER IF NOT EXISTS reset_categorias_sequence
    AFTER DELETE ON categorias
    WHEN NOT EXISTS (SELECT 1 FROM categorias)
    BEGIN
      DELETE FROM sqlite_sequence WHERE name='categorias';
    END;
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, codigo_barras TEXT,
      nome TEXT NOT NULL, descricao TEXT, categoria_id INTEGER,
      preco_custo REAL DEFAULT 0, preco_venda REAL NOT NULL,
      estoque REAL DEFAULT 0, estoque_minimo REAL DEFAULT 0,
      unidade TEXT DEFAULT 'UN', ncm TEXT, cfop TEXT,
      permite_estoque_negativo INTEGER DEFAULT 1,
      foto TEXT,
      ativo INTEGER DEFAULT 1, criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT DEFAULT 'PF',
      nome TEXT NOT NULL, cpf_cnpj TEXT, rg_ie TEXT,
      email TEXT, telefone TEXT, endereco TEXT, cidade TEXT, uf TEXT, cep TEXT,
      observacoes TEXT, ativo INTEGER DEFAULT 1, criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS fornecedores (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL,
      cnpj TEXT, email TEXT, telefone TEXT, endereco TEXT, contato TEXT,
      ativo INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, numero TEXT,
      data TEXT DEFAULT CURRENT_TIMESTAMP, cliente_id INTEGER,
      usuario_id INTEGER NOT NULL, subtotal REAL NOT NULL,
      desconto REAL DEFAULT 0, acrescimo REAL DEFAULT 0, total REAL NOT NULL,
      forma_pagamento TEXT, status TEXT DEFAULT 'finalizada',
      tipo_cupom TEXT, observacoes TEXT, caixa_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS venda_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT, venda_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL, produto_nome TEXT, quantidade REAL NOT NULL,
      preco_unitario REAL NOT NULL, desconto REAL DEFAULT 0, subtotal REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS movimentacao_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT, produto_id INTEGER NOT NULL,
      tipo TEXT NOT NULL, quantidade REAL NOT NULL, motivo TEXT,
      data TEXT DEFAULT CURRENT_TIMESTAMP, usuario_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS caixa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_abertura TEXT DEFAULT CURRENT_TIMESTAMP, data_fechamento TEXT,
      valor_abertura REAL DEFAULT 0, valor_fechamento REAL DEFAULT 0,
      total_vendas REAL DEFAULT 0, status TEXT DEFAULT 'aberto',
      usuario_id INTEGER, observacoes TEXT, turno INTEGER DEFAULT 1,
      total_sangrias REAL DEFAULT 0, total_suprimentos REAL DEFAULT 0, caixa_identificador TEXT
    );
    CREATE TABLE IF NOT EXISTS caixa_movimentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caixa_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      valor REAL NOT NULL,
      motivo TEXT,
      data TEXT DEFAULT CURRENT_TIMESTAMP,
      usuario_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY, valor TEXT
    );
    CREATE TABLE IF NOT EXISTS perfis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT UNIQUE NOT NULL,
      descricao TEXT,
      permissoes TEXT,
      sistema INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS notas_entrada (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT, serie TEXT, chave TEXT,
      fornecedor_id INTEGER, fornecedor_nome TEXT, cnpj_fornecedor TEXT,
      data_emissao TEXT, data_entrada TEXT DEFAULT CURRENT_TIMESTAMP,
      valor_total REAL DEFAULT 0, observacoes TEXT,
      origem TEXT DEFAULT 'manual', usuario_id INTEGER,
      xml_content TEXT,
      status TEXT DEFAULT 'lancada'
    );
    CREATE TABLE IF NOT EXISTS nota_entrada_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nota_id INTEGER NOT NULL, produto_id INTEGER,
      codigo TEXT, descricao TEXT, ncm TEXT, cfop TEXT,
      unidade TEXT, quantidade REAL DEFAULT 0,
      valor_unitario REAL DEFAULT 0, valor_total REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS contas_pagar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      descricao TEXT NOT NULL, fornecedor_id INTEGER, fornecedor_nome TEXT,
      nota_id INTEGER,
      valor REAL NOT NULL, data_emissao TEXT DEFAULT CURRENT_TIMESTAMP,
      data_vencimento TEXT, data_pagamento TEXT,
      valor_pago REAL DEFAULT 0, forma_pagamento TEXT,
      status TEXT DEFAULT 'em_aberto', categoria TEXT,
      observacoes TEXT, usuario_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS contas_receber (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      descricao TEXT NOT NULL, cliente_id INTEGER, venda_id INTEGER,
      valor REAL NOT NULL, data_emissao TEXT DEFAULT CURRENT_TIMESTAMP,
      data_vencimento TEXT, data_recebimento TEXT,
      valor_recebido REAL DEFAULT 0, forma_recebimento TEXT,
      status TEXT DEFAULT 'em_aberto', categoria TEXT,
      observacoes TEXT, usuario_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS caixas_clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identificador TEXT UNIQUE,
      nome TEXT, hostname TEXT, versao_cliente TEXT,
      ip TEXT, ultimo_acesso TEXT DEFAULT CURRENT_TIMESTAMP,
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    );
`;

// ----------------------------------------------------------------------
// Hashes de credenciais conhecidas/comprometidas.
//  - SENHA_PADRAO_MASTER_HASH: hash da senha de fabrica do usuario `master`.
//    Nao e bloqueada (o sistema precisa de um primeiro acesso), mas o login
//    avisa o front-end (`senha_padrao: true`) e o servidor registra aviso.
//  - HASH_ADMIN_LEGADO: hash da senha do antigo usuario `admin` embutido
//    nas versoes anteriores. Essa senha foi publicada no repositorio, entao
//    qualquer usuario com esse hash e desativado automaticamente (migracao
//    + triggers), mesmo que o front-end (criarEstrutura) tente recria-lo.
// ----------------------------------------------------------------------
const SENHA_PADRAO_MASTER_HASH = 'Hf3ucht_22';
const HASH_ADMIN_LEGADO = 'Hi5mpb0_28';

// ----------------------------- Migrations -----------------------------
// Controladas por PRAGMA user_version. Cada migration roda uma unica vez
// por banco (e e idempotente, para bancos antigos que partem de versao 0).
// Para evoluir o schema no futuro: ADICIONE uma nova funcao ao final do
// array — nunca edite as anteriores.
const MIGRATIONS = [
  // v1 — estrutura base (identica ao criarEstrutura() do app.html)
  function v1_base(db) {
    db.exec(SCHEMA_SQL);
  },

  // v2 — indices de desempenho (relatorios e PDV ficam lentos sem eles
  // conforme o historico de vendas cresce). Falha de um indice nunca
  // impede a inicializacao.
  function v2_indices(db, log) {
    const indices = [
      'CREATE INDEX IF NOT EXISTS idx_vendas_data ON vendas(data)',
      'CREATE INDEX IF NOT EXISTS idx_vendas_status_data ON vendas(status, data)',
      'CREATE INDEX IF NOT EXISTS idx_vendas_caixa ON vendas(caixa_id)',
      'CREATE INDEX IF NOT EXISTS idx_vendas_cliente ON vendas(cliente_id)',
      'CREATE INDEX IF NOT EXISTS idx_venda_itens_venda ON venda_itens(venda_id)',
      'CREATE INDEX IF NOT EXISTS idx_venda_itens_produto ON venda_itens(produto_id)',
      'CREATE INDEX IF NOT EXISTS idx_produtos_codigo ON produtos(codigo)',
      'CREATE INDEX IF NOT EXISTS idx_produtos_barras ON produtos(codigo_barras)',
      'CREATE INDEX IF NOT EXISTS idx_produtos_categoria ON produtos(categoria_id)',
      'CREATE INDEX IF NOT EXISTS idx_mov_estoque_produto ON movimentacao_estoque(produto_id, data)',
      'CREATE INDEX IF NOT EXISTS idx_caixa_mov_caixa ON caixa_movimentos(caixa_id)',
      'CREATE INDEX IF NOT EXISTS idx_contas_pagar_status_venc ON contas_pagar(status, data_vencimento)',
      'CREATE INDEX IF NOT EXISTS idx_contas_receber_status_venc ON contas_receber(status, data_vencimento)',
    ];
    for (const sql of indices) {
      try { db.exec(sql); } catch (e) { log('migracao v2: indice ignorado:', e.message); }
    }
  },

  // v3 — seguranca: neutraliza a credencial `admin` publicada no repositorio.
  function v3_bloqueia_admin_legado(db) {
    db.prepare('UPDATE usuarios SET ativo = 0 WHERE senha = ?').run(HASH_ADMIN_LEGADO);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_bloqueia_senha_legada_ins
      AFTER INSERT ON usuarios
      WHEN NEW.senha = '${HASH_ADMIN_LEGADO}'
      BEGIN
        UPDATE usuarios SET ativo = 0 WHERE id = NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_bloqueia_senha_legada_upd
      AFTER UPDATE ON usuarios
      WHEN NEW.senha = '${HASH_ADMIN_LEGADO}' AND COALESCE(NEW.ativo, 1) <> 0
      BEGIN
        UPDATE usuarios SET ativo = 0 WHERE id = NEW.id;
      END;
    `);
  },
];

function executarMigrations(db, log) {
  const atual = db.pragma('user_version', { simple: true });
  for (let v = atual; v < MIGRATIONS.length; v++) {
    const migracao = MIGRATIONS[v];
    const aplicar = db.transaction(() => {
      migracao(db, log);
      db.pragma('user_version = ' + (v + 1));
    });
    aplicar();
    log('Banco migrado para a versao ' + (v + 1) + ' (' + migracao.name + ')');
  }
}

// Seeds idempotentes (espelham criarEstrutura do app.html), exceto o antigo
// usuario `admin`, que nao e mais criado.
function aplicarSeeds(db) {
  const temMasterAtivo = db
    .prepare("SELECT COUNT(*) AS c FROM usuarios WHERE nivel='master' AND ativo=1 AND senha <> ?")
    .get(HASH_ADMIN_LEGADO).c > 0;
  if (!temMasterAtivo) {
    // Garante que sempre exista um acesso inicial. Se ja existe o login
    // `master` (ex.: inativo), nao tenta recriar para nao violar UNIQUE.
    const existe = db.prepare("SELECT id FROM usuarios WHERE login='master'").get();
    if (!existe) {
      db.prepare(
        'INSERT INTO usuarios (nome, login, senha, nivel, ativo) VALUES (?, ?, ?, ?, 1)'
      ).run('Administrador Master', 'master', hashSenha('master'), 'master');
    }
  }

  if (db.prepare('SELECT COUNT(*) AS c FROM empresa').get().c === 0) {
    db.prepare(
      "INSERT INTO empresa (id, razao_social, rodape) VALUES (1, 'Sua Empresa LTDA', 'Obrigado pela preferência!')"
    ).run();
  }

  if (db.prepare('SELECT COUNT(*) AS c FROM perfis').get().c === 0) {
    const seedPerfil = db.prepare(
      'INSERT INTO perfis (nome, descricao, permissoes, sistema) VALUES (?,?,?,1)'
    );
    seedPerfil.run('ADMINISTRADOR', 'Acesso total ao sistema', JSON.stringify(PERMISSOES_TODAS));
    seedPerfil.run('GERENTE', 'Acesso gerencial (sem configurações de sistema)', JSON.stringify(PERMISSOES_GERENTE));
    seedPerfil.run('CAIXA', 'Acesso apenas ao PDV e caixa', JSON.stringify(PERMISSOES_CAIXA));
  }
}

function inicializarSchema(db, log) {
  const logger = typeof log === 'function' ? log : () => {};
  executarMigrations(db, logger);
  aplicarSeeds(db);
}

module.exports = {
  inicializarSchema,
  hashSenha,
  PERMISSOES_TODAS,
  SENHA_PADRAO_MASTER_HASH,
  HASH_ADMIN_LEGADO,
  SCHEMA_VERSION: MIGRATIONS.length,
};
