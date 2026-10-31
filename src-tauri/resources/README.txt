Esta pasta recebe os recursos empacotados no instalador:

  resources/node.exe            -> runtime Node.js (Windows x64), baixado no CI
  resources/server/             -> servidor de rede (server.js, schema.js,
                                   package.json e node_modules com better-sqlite3
                                   compilado para Windows x64)

O conteudo e montado automaticamente pelo GitHub Actions
(.github/workflows/build-windows.yml) antes de rodar `tauri build`.
Em desenvolvimento (npm run tauri dev) o app cai para o `node` do PATH e
para ../server/server.js, entao esta pasta pode ficar so com este README.
