import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Header, Footer } from '@/components/SiteShell';
import { getAllPosts, getPost, formatDate } from '@/lib/posts';

export const dynamicParams = false;

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

export default function PostPage({ params }: { params: { slug: string } }) {
  const post = getPost(params.slug);
  if (!post) notFound();

  return (
    <>
      <Header />
      <main className="post-page page-wrap">
        <Link className="text-link back-link" href="/writing">← Writing</Link>
        <p className="eyebrow post-kicker">{formatDate(post.date)} · {post.readingMinutes} min read</p>
        <h1>{post.title}</h1>
        <p className="post-subtitle">{post.subtitle}</p>
        <article className="prose" dangerouslySetInnerHTML={{ __html: post.html }} />
        <Link className="text-link" href="/writing">More writing →</Link>
      </main>
      <Footer />
    </>
  );
}
