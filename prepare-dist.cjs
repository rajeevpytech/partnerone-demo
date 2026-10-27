'use strict';
// GitHub Pages serves the public files from the repository root. On a VPS,
// copy only this explicit public allowlist into the server's static directory.
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const files = ['index.html','runtime-config.js','app.js','tree-model.js','income-model.js','site-pages.js','reference-ui.js','production-ui.js','styles.css','portal-updates.css','landing.css','reference-layout.css','brand.css','production.css','living-hero.jpg'];
if (fs.existsSync(path.join(root,'index.html'))) {
  fs.mkdirSync(path.join(root,'dist'),{recursive:true});
  for (const name of files) {
    const source = path.join(root,name);
    if (!fs.existsSync(source)) throw new Error(`Missing public asset: ${name}`);
    fs.copyFileSync(source,path.join(root,'dist',name));
  }
  fs.cpSync(path.join(root,'assets'),path.join(root,'dist/assets'),{recursive:true});
}
if (!fs.existsSync(path.join(root,'dist/index.html'))) throw new Error('Missing dist/index.html');
console.log('Public assets prepared; server and database files are outside the static directory.');
