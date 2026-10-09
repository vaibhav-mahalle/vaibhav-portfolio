import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { projects } from '@/lib/projects';
import { Header, Footer } from '@/components/SiteShell';
import { ProjectVisual } from '@/components/WorkGrid';
export function generateStaticParams() { return projects.map(p => ({ slug: p.slug })); }
export function generateMetadata({ params }: {
    params: {
        slug: string;
    };
}): Metadata { const p = projects.find(p => p.slug === params.slug); return { title: p ? `${p.title} — Vaibhav Mahalle` : 'Project not found', description: p?.summary, alternates: { canonical: `/work/${params.slug}` } }; }
export default function WorkPage({ params }: {
    params: {
        slug: string;
    };
}) { const p = projects.find(p => p.slug === params.slug); if (!p)
    notFound(); return <><Header /><main className="project-page page-wrap"><Link className="text-link" href="/#work">← Selected work</Link><p className="eyebrow">{p.tags.join(' / ')}</p><h1>{p.title}</h1><p className="project-summary">{p.summary}</p><ProjectVisual project={p}/><div className="case-layout"><aside><span className="eyebrow">CONTRIBUTION</span><p>Backend engineering</p><span className="eyebrow">IN PRACTICE</span><p>{p.impact}</p></aside><div>{[['The problem', p.problem], ['What I built', p.approach], ['The result', p.result]].map(([title, body]) => <section key={title}><h2>{title}</h2><p>{body}</p></section>)}</div></div><Link className="text-link" href="/#work">Explore more work →</Link></main><Footer /></>; }
