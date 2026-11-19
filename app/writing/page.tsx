import type { Metadata } from 'next';
import Link from 'next/link';
import { Header, Footer } from '@/components/SiteShell';
import { getAllPosts, formatDate } from '@/lib/posts';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Writing — Vaibhav Mahalle',
  description: 'Essays on backend systems, data pipelines and reliability.',
  alternates: { canonical: '/writing' },
};

export default function WritingIndex() {
  const posts = getAllPosts();
  return (
    <>
      <Header />
      <main className="writing-page page-wrap">
        <p className="eyebrow">WRITING</p>
        <h1>Notes on systems that have to be right.</h1>
        <ul className="post-list">
          {posts.map((post) => (
            <li key={post.slug}>
              <Link href={`/writing/${post.slug}`}>
                <span className="post-meta">{formatDate(post.date)} · {post.readingMinutes} min read</span>
                <h2>{post.title}</h2>
                <p>{post.subtitle}</p>
              </Link>
            </li>
          ))}
        </ul>
      </main>
      <Footer />
    </>
  );
}
