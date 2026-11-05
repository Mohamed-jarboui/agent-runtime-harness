// Fail if tracked files contain credential-shaped strings. Defence in depth
// next to GitHub secret scanning; run in CI and before publishing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai key', /sk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ['github token', /gh[pousr]_[A-Za-z0-9]{36,}/],
  ['aws access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['slack token', /xox[abprs]-[A-Za-z0-9-]{20,}/],
];
// Test fixtures deliberately contain short fake keys that must not match the
// stricter patterns above; anything matching here is a real problem.
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
let problems = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const [name, pattern] of PATTERNS) {
    if (pattern.test(text)) {
      console.error(`possible ${name} in ${file}`);
      problems++;
    }
  }
}
const envFiles = files.filter((f) => /(^|\/)\.env$/.test(f) && f !== 'examples/sample-workspace/.env');
for (const f of envFiles) {
  console.error(`tracked .env file: ${f}`);
  problems++;
}
if (problems > 0) {
  console.error(`${problems} potential secret(s) found`);
  process.exit(1);
}
console.log(`no secrets found in ${files.length} tracked files`);
