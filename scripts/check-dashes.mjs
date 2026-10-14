// Fails when any given file contains an em dash or an en dash.
import { readFileSync } from 'node:fs';

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

const bad = [];
for (const file of process.argv.slice(2)) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (line.includes(EM) || line.includes(EN)) bad.push(`${file}:${i + 1}`);
  });
}
if (bad.length > 0) {
  console.error('Em dashes or en dashes are not allowed. Found in:');
  for (const b of bad) console.error('  ' + b);
  process.exit(1);
}
