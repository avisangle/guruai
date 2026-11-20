// Copies the design tokens into the app. Re-run after any change to
// design/foundations/tokens.json:  npm run build:theme
//
//   design/foundations/tokens.json -> src/ui/generated/tokens.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '../../design/foundations/tokens.json');
const out = path.join(here, '../src/ui/generated');

fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(src, path.join(out, 'tokens.json'));
console.log('wrote src/ui/generated/tokens.json');
