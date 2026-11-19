import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Header, Footer } from '@/components/SiteShell';
import { getAllPosts, getPost, getSeries, formatDate, type SeriesEntry } from '@/lib/posts';

// Regenerate at most hourly, so scheduled posts appear without a new deploy.
export const revalidate = 3600;
export const dynamicParams = true;

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const post = getPost(params.slug);
  if (!post) return { title: 'Post not found' };
  return {
    title: `${post.title} — Vaibhav Mahalle`,
    description: post.subtitle,
    alternates: { canonical: `/writing/${post.slug}` },
    openGraph: { title: post.title, description: post.subtitle, type: 'article', publishedTime: post.date },
  };
}

function SeriesBox({ entries, current }: { entries: SeriesEntry[]; current: string }) {
  const parts = entries.filter((e) => e.part > 0);
  const hub = entries.find((e) => e.part === 0);
  return (
    <nav className="series-box" aria-label="Series">
      <p className="eyebrow">THE SERIES</p>
      {hub && (
        <p className="series-hub">
          {hub.slug === current ? <strong>Overview: {hub.title}</strong> : <Link href={`/writing/${hub.slug}`}>Overview: {hub.title}</Link>}
        </p>
      )}
      <ol>
        {parts.map((e) => (
          <li key={e.slug} className={e.slug === current ? 'current' : undefined}>
            <span className="series-part">Part {e.part}</span>
            {e.slug === current ? (
              <strong>{e.title}</strong>
            ) : e.live ? (
              <Link href={`/writing/${e.slug}`}>{e.title}</Link>
            ) : (
              <span className="series-upcoming">{e.title} <em>· {formatDate(e.date)}</em></span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export default function PostPage({ params }: { params: { slug: string } }) {
  const post = getPost(params.slug);
  if (!post) notFound();

  const series = getSeries(post.series);
  const idx = series.findIndex((e) => e.slug === post.slug);
  const prev = idx > 0 ? series[idx - 1] : undefined;
  const next = idx >= 0 && idx < series.length - 1 && series[idx + 1].live ? series[idx + 1] : undefined;
  const label = post.part && post.part > 0 ? `Part ${post.part} of ${series.filter((e) => e.part > 0).length} · ` : '';

  return (
    <>
      <Header />
      <main className="post-page page-wrap">
        <Link className="text-link back-link" href="/writing">← Writing</Link>
        <p className="eyebrow post-kicker">{label}{formatDate(post.date)} · {post.readingMinutes} min read</p>
        <h1>{post.title}</h1>
        <p className="post-subtitle">{post.subtitle}</p>
        {series.length > 1 && <SeriesBox entries={series} current={post.slug} />}
        <article className="prose" dangerouslySetInnerHTML={{ __html: post.html }} />
        {series.length > 1 && (
          <div className="series-nav">
            {prev ? <Link className="text-link" href={`/writing/${prev.slug}`}>← {prev.part === 0 ? 'Overview' : `Part ${prev.part}`}: {prev.title}</Link> : <span />}
            {next ? <Link className="text-link" href={`/writing/${next.slug}`}>{`Part ${next.part}`}: {next.title} →</Link> : <span />}
          </div>
        )}
        <Link className="text-link" href="/writing">More writing →</Link>
      </main>
      <Footer />
    </>
  );
}
