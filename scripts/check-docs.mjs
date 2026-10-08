/** Check relative Markdown link targets; this does not validate anchors or remote URLs. */
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';

const walk = async (directory) => {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await walk(location)));
    else if (location.endsWith('.md')) results.push(location);
  }
  return results;
};
let failures = 0;
for (const file of await walk('.')) {
  const content = await readFile(file, 'utf8');
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1].split('#')[0];
    if (!target || /^(https?:|mailto:)/u.test(target)) continue;
    try {
      await access(path.resolve(path.dirname(file), target));
    } catch {
      console.error(`${file}: missing link ${target}`);
      failures++;
    }
  }
}
if (failures) process.exit(1);
console.log('Relative documentation links are valid');
