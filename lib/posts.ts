import fs from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

export type Post = {
  slug: string;
  title: string;
  subtitle: string;
  date: string;
  tags: string[];
  readingMinutes: number;
  html: string;
};

const POSTS_DIR = path.join(process.cwd(), 'content', 'writing');

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { data, body: match[2] };
}

function readPost(file: string): Post | null {
  const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
  const { data, body } = parseFrontmatter(raw);
  if (data.status !== 'published') return null;
  const words = body.split(/\s+/).filter(Boolean).length;
  return {
    slug: data.slug || file.replace(/\.md$/, ''),
    title: data.title || '',
    subtitle: data.subtitle || '',
    date: data.date || '',
    tags: (data.tags || '').replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean),
    readingMinutes: Math.max(1, Math.round(words / 230)),
    html: marked.parse(body, { async: false }) as string,
  };
}

export function getAllPosts(): Post[] {
  if (!fs.existsSync(POSTS_DIR)) return [];
  return fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map(readPost)
    .filter((p): p is Post => p !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function getPost(slug: string): Post | undefined {
  return getAllPosts().find((p) => p.slug === slug);
}

export function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
