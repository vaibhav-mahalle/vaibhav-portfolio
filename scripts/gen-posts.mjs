// Reads content/writing/*.md and writes lib/posts.generated.json.
// The JSON is bundled with the server code, so pages can be regenerated
// (ISR) after deploy without reading the file system at runtime.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dir = path.join(root, 'content', 'writing');
const out = path.join(root, 'lib', 'posts.generated.json');

function parse(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    data[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { data, body: m[2] };
}

const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
const posts = files.map((f) => {
  const { data, body } = parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  return {
    slug: data.slug || f.replace(/\.md$/, ''),
    title: data.title || '',
    subtitle: data.subtitle || '',
    date: data.date || '',
    publishAt: data.publishAt || '',
    status: data.status || 'draft',
    series: data.series || '',
    part: data.part ? Number(data.part) : null,
    tags: (data.tags || '').replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean),
    words: body.split(/\s+/).filter(Boolean).length,
    body,
  };
});

fs.writeFileSync(out, JSON.stringify(posts));
console.log(`gen-posts: ${posts.length} post(s) -> lib/posts.generated.json`);
