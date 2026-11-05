// Remove build outputs and incremental build info across the workspace.
import { rmSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const roots = ['packages', 'apps', 'examples'];
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) {
    for (const target of ['dist', 'tsconfig.tsbuildinfo']) {
      rmSync(path.join(root, name, target), { recursive: true, force: true });
    }
  }
}
console.log('cleaned dist/ and tsbuildinfo files');
