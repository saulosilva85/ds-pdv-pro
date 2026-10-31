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

function inicializarSchema(db) {
  db.exec(SCHEMA_SQL);

  // Seeds idempotentes (espelham criarEstrutura do app.html).
  const seedUser = db.prepare(
    'INSERT INTO usuarios (nome, login, senha, nivel, ativo) VALUES (?, ?, ?, ?, 1)'
  );
  const countUser = db.prepare('SELECT COUNT(*) AS c FROM usuarios WHERE login=?');

  if (countUser.get('master').c === 0) {
    seedUser.run('Administrador Master', 'master', hashSenha('master'), 'master');
  }
  if (countUser.get('admin').c === 0) {
    seedUser.run('Administrador do Sistema', 'admin', hashSenha('Silv@193085!'), 'master');
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

module.exports = { inicializarSchema, hashSenha };
