# System PDV PRO

Sistema de Frente de Loja (PDV) para lojas — vendas, produtos, estoque,
clientes, caixa, contas a pagar/receber, NFe de entrada, relatórios,
usuários/perfis e backup. Funciona como **aplicativo desktop Windows**
(instalador `.exe`) com **banco SQLite embutido** e operação **em rede**
(um Servidor + vários Caixas / computadores administrativos).

> O layout/front-end (`index.html` e `app.html`) é mantido exatamente como
> está. O que este repositório acrescenta é o **backend** (servidor de rede
> Node + SQLite) e o **empacotamento desktop** (Tauri 2) que fazem o sistema
> funcionar de ponta a ponta.

---

## Arquitetura

```
┌─────────────────────────── Máquina SERVIDOR ───────────────────────────┐
│  System PDV PRO.exe (Tauri)                                             │
│   ├─ WebView  ──► index.html / app.html  (front-end, inalterado)        │
│   └─ Servidor embutido (Node + better-sqlite3)  http://0.0.0.0:8765     │
│        ├─ /api/sql/exec, /api/sql/exec-batch  (banco SQLite)            │
│        ├─ /api/auth/login, /api/health, /api/identidade                 │
│        ├─ /api/backup/dump, /api/backup/restore                         │
│        ├─ /api/caixas-clientes/register                                 │
│        └─ WebSocket /ws  (sincroniza telas entre caixas)                │
│        Banco: %APPDATA%/com.systempdvpro.app/data/system_pdv_pro.db     │
└────────────────────────────────────────────────────────────────────────┘
            ▲                         ▲                         ▲
            │ LAN (http 8765 / ws)    │                         │
   ┌────────┴────────┐       ┌────────┴────────┐       ┌────────┴────────┐
   │ CAIXA 02        │       │ CAIXA 03        │       │ ADMINISTRATIVO  │
   │ System PDV PRO  │  ...  │ System PDV PRO  │  ...  │ System PDV PRO  │
   │ (Máquina add.)  │       │ (Máquina add.)  │       │ (Máquina add.)  │
   └─────────────────┘       └─────────────────┘       └─────────────────┘
```

- **Servidor:** hospeda o banco e atende toda a rede. Tem acesso a todos os módulos.
- **Máquina adicional (caixa/administrativo):** aponta para o IP do Servidor; usa o mesmo banco em tempo real.

---

## Componentes do repositório

| Pasta / arquivo | Descrição |
|---|---|
| `index.html`, `app.html` | Front-end do sistema (inalterados). |
| `server/` | Servidor de rede Node + `better-sqlite3` (API + WebSocket). |
| `server/schema.js` | Schema do banco + seeds (espelha `criarEstrutura()` do `app.html`). |
| `src-tauri/` | App desktop Tauri 2 (Rust): persiste config, inicia o servidor embutido e faz a **impressão nativa** (cupom + gaveta). |
| `src-tauri/src/printing.rs` | Impressão ESC/POS via spooler do Windows (RAW): lista impressoras, imprime e aciona a gaveta. |
| `scripts/build-frontend.js` | Copia `index.html`/`app.html` para `dist/` (empacotado no app). |
| `ci/build-windows.yml` | CI que gera o instalador Windows `.exe` (copie para `.github/workflows/`). |

---

## Instalador Windows (.exe)

O nome do instalador gerado é:

```
System PDV PRO_2.0.0_x64-setup.exe
```

### Como gerar o instalador (GitHub Actions — recomendado)

Não é preciso ter Windows à mão: o build roda na nuvem.

> **Antes do primeiro uso:** copie o arquivo `ci/build-windows.yml` para
> `.github/workflows/build-windows.yml` e faça commit. (O workflow vem em
> `ci/` porque a automação não tem permissão para criar arquivos em
> `.github/workflows/` por você — basta mover uma vez.)

1. Faça `push` para o GitHub (qualquer branch) **ou** dispare manualmente o
   workflow **Build Windows Installer** na aba *Actions*.
2. Ao terminar, baixe o artefato **`System-PDV-PRO-setup`** — ele contém o
   `System PDV PRO_2.0.0_x64-setup.exe`.
3. Para publicar uma versão (release com download direto), crie uma tag `vX.Y.Z`
   (ex.: `git tag v2.0.0 && git push origin v2.0.0`); o `.exe` é anexado à release.

O CI já cuida de: instalar o `better-sqlite3` compilado para Windows x64,
baixar o runtime `node.exe` (mesma versão/ABI) e embutir tudo no instalador.

### Build local no Windows (opcional)

Pré-requisitos: Node.js 20.x, Rust (stable) + MSVC build tools.

```powershell
npm install
npm --prefix server install --omit=dev
# montar recursos embutidos:
mkdir src-tauri\resources\server -Force
Invoke-WebRequest https://nodejs.org/dist/v20.18.1/win-x64/node.exe -OutFile src-tauri\resources\node.exe
Copy-Item server\server.js,server\schema.js,server\package.json src-tauri\resources\server\
Copy-Item server\node_modules src-tauri\resources\server\node_modules -Recurse
npm run build
# instalador em: src-tauri\target\release\bundle\nsis\System PDV PRO_2.0.0_x64-setup.exe
```

---

## Instalação e uso na loja

### 1) Máquina Servidor
1. Instale o `System PDV PRO_2.0.0_x64-setup.exe`.
2. Abra o app → escolha **Servidor** → **Continuar**. O servidor embutido sobe
   automaticamente e o banco é criado no primeiro boot.
3. Faça login (usuário inicial **`master`**, senha **`master`** — troque depois
   em *Usuários*).
4. Anote o IP da máquina na rede (ex.: `192.168.0.10`). Garanta que a porta
   **8765 (TCP)** esteja liberada no Firewall do Windows para a rede local.

### 2) Máquinas adicionais (caixas / administrativo)
1. Instale o mesmo `.exe`.
2. Abra o app → escolha **Máquina adicional** → informe
   `http://IP_DO_SERVIDOR:8765` (ex.: `http://192.168.0.10:8765`) → **Testar
   conexão** → **Continuar**.
3. Faça login normalmente. Todas as máquinas compartilham o mesmo banco.

---

## Rodar o servidor sem o desktop (dev / teste)

```bash
cd server
npm install
npm start            # sobe em http://0.0.0.0:8765 e serve index.html/app.html
# abra http://localhost:8765 no navegador
```

Variáveis de ambiente úteis:

| Variável | Padrão | Descrição |
|---|---|---|
| `PDV_PORT` | `8765` | Porta do servidor. |
| `PDV_HOST` | `0.0.0.0` | Interface de escuta (LAN). |
| `PDV_DATA_DIR` | `server/data` | Pasta do banco SQLite. |
| `PDV_STATIC_DIR` | raiz do repo | Pasta com `index.html`/`app.html`. |

### Rodar o desktop em modo dev

```bash
npm install
npm run dev          # Tauri dev; usa o `node` do PATH e ../server/server.js
```

---

## Usuários iniciais (seeds)

| Login | Senha | Nível |
|---|---|---|
| `master` | `master` | master |

> Há também um usuário administrativo interno do desenvolvedor. **Troque/relmova
> as credenciais padrão antes de comercializar.**

---

## Impressão de cupom e gaveta

No **app desktop (Windows)** a impressão é **nativa**: o cupom sai direto na
impressora escolhida, sem o diálogo do Windows, respeitando todo o módulo
*Configurações de Impressora*.

- **Selecionar Impressora:** o seletor é preenchido automaticamente com as
  impressoras instaladas no Windows (comando `list_printers`). Basta escolher.
- **Largura do Papel:** `58 mm` → 32 colunas, `80 mm` → 48 colunas.
  (`A4` continua usando o diálogo do navegador.)
- **Vias / Recibos automáticos:** imprime o número de vias configurado por
  categoria (à vista / prazo / parcelamento), com corte parcial entre elas.
- **Abertura Automática da Gaveta:** quando `Sim`, envia o pulso ESC/POS
  nos **pinos 2 e 5** (`ESC p 0 25 250` + `ESC p 1 25 250`) junto com o cupom
  (ou sozinho, se a impressão da categoria estiver desligada). A gaveta abre
  no pino que estiver conectado; o outro pulso é ignorado.
- **Acentuação:** o texto é codificado em **CP850** (`ESC t 2`); caracteres
  fora da tabela caem para ASCII sem acento, nunca quebrando a impressão.

No **navegador** (sem Tauri) ou com papel **A4**, mantém-se o fluxo anterior
(diálogo de impressão via iframe), também respeitando vias e largura.

### Compatibilidade de impressoras térmicas

O sistema é compatível com **qualquer impressora térmica ESC/POS** — o padrão
de fato do mercado, usado por **Bematech, Elgin, Epson, Daruma, Sweda, Tanca,
Control iD**, entre outras. O funcionamento não depende da marca, e sim de:

1. O **driver da impressora instalado no Windows** (ela precisa aparecer em
   *Dispositivos e Impressoras*). O seletor lista automaticamente o que o
   Windows conhece.
2. A impressora **aceitar dados RAW/ESC/POS** — praticamente todas as térmicas
   de cupom aceitam. Enviamos os bytes diretamente pelo spooler em modo RAW,
   sem passar por conversão de driver.

Recomendações por marca (todas ESC/POS, funcionam sem ajuste):
- **Bematech** (MP-4200 TH, MP-2800 TH…): 80/58 mm, gaveta nos pinos 2/5 — OK.
- **Elgin** (i9, i7, i8): 80/58 mm, CP850 — OK.
- **Epson** (TM-T20, TM-T88): referência ESC/POS — OK.
- **Daruma / Sweda / Tanca / Control iD**: ESC/POS padrão — OK.

Se uma impressora específica usar uma tabela de código diferente (acentos
estranhos) ou um comando de gaveta proprietário, o ajuste é pontual em
`src-tauri/src/printing.rs` (gaveta) e na função `_escposCupom` do `app.html`
(tabela de código). Nesse caso, informe **marca + modelo**.

> Comandos Tauri usados: `list_printers`, `print_raw(printer, data)` e
> `open_drawer(printer)` — implementados em `src-tauri/src/printing.rs`.

---

## Backup

- **Exportar:** módulo *Backup / Restaurar* → gera o `.db` via `/api/backup/dump`.
- **Restaurar:** envia o `.db` para `/api/backup/restore` (o servidor valida e reinicia).

---

## Notas técnicas

- O front-end envia **SQL puro** para `/api/sql/exec` (`{sql, params}` →
  `{rows}` ou `{lastID, changes}`). A finalização de venda usa
  `/api/sql/exec-batch` (transação atômica via `better-sqlite3.transaction`).
- O schema e os seeds são criados pelo servidor no boot e também pela
  `criarEstrutura()` do `app.html` (idempotente).
- Banco em modo **WAL** para melhor concorrência entre caixas.
