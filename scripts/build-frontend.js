'use strict';

// Monta a pasta `dist/` que o Tauri empacota como frontend do app desktop.
// Apenas COPIA os HTMLs atuais (index.html / app.html) sem alterar nada —
// o layout permanece exatamente o mesmo.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const file of ['index.html', 'app.html']) {
  const src = path.join(root, file);
  if (!fs.existsSync(src)) {
    console.error('[build-frontend] arquivo ausente:', src);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(dist, file));
  console.log('[build-frontend] copiado', file);
}

console.log('[build-frontend] dist pronto em', dist);
