import { marked } from 'marked';
import raw from './posts.generated.json';

type RawPost = {
  slug: string;
  title: string;
  subtitle: string;
  date: string;
  publishAt: string;
  status: string;
  series: string;
  part: number | null;
  tags: string[];
  words: number;
  body: string;
};

export type Post = Omit<RawPost, 'body' | 'words'> & {
  readingMinutes: number;
  html: string;
};

export type SeriesEntry = {
  slug: string;
  title: string;
  part: number;
  date: string;
  live: boolean;
};

// Posts go live at 09:00 India time on their date unless publishAt says otherwise.
function liveAt(p: RawPost): number {
  const iso = p.publishAt || `${p.date}T09:00:00+05:30`;
  return new Date(iso).getTime();
}

function isLive(p: RawPost, now: number): boolean {
  return p.status === 'published' && !Number.isNaN(liveAt(p)) && liveAt(p) <= now;
}

function toPost(p: RawPost): Post {
  const { body, words, ...rest } = p;
  return {
    ...rest,
    readingMinutes: Math.max(1, Math.round(words / 230)),
    html: marked.parse(body, { async: false }) as string,
  };
}

const all = raw as RawPost[];

export function getAllPosts(now: number = Date.now()): Post[] {
  return all
    .filter((p) => isLive(p, now))
    .sort((a, b) => liveAt(b) - liveAt(a))
    .map(toPost);
}

export function getPost(slug: string, now: number = Date.now()): Post | undefined {
  const p = all.find((x) => x.slug === slug);
  return p && isLive(p, now) ? toPost(p) : undefined;
}

// All parts of a series, including scheduled ones (title and date only).
export function getSeries(series: string, now: number = Date.now()): SeriesEntry[] {
  if (!series) return [];
  return all
    .filter((p) => p.series === series && p.status === 'published')
    .sort((a, b) => (a.part ?? 0) - (b.part ?? 0))
    .map((p) => ({ slug: p.slug, title: p.title, part: p.part ?? 0, date: p.date, live: isLive(p, now) }));
}

export function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
