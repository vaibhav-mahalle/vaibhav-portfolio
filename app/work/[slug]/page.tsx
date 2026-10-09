import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { projects } from '@/lib/projects';
import { Header, Footer } from '@/components/SiteShell';
import { ProjectVisual } from '@/components/WorkGrid';

export function generateStaticParams() {
  return projects.map((project) => ({ slug: project.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const project = projects.find((item) => item.slug === params.slug);
  return {
    title: project ? `${project.title} — Vaibhav Mahalle` : 'Project not found',
    description: project?.summary,
    alternates: { canonical: `/work/${params.slug}` },
  };
}

export default function WorkPage({ params }: { params: { slug: string } }) {
  const project = projects.find((item) => item.slug === params.slug);
  if (!project) notFound();

  return (
    <>
      <Header />
      <main className="project-page page-wrap">
        <Link className="text-link back-link" href="/#work">← Selected work</Link>
        <p className="eyebrow project-kicker">{project.impact}</p>
        <h1>{project.title}</h1>
        <p className="project-summary">{project.summary}</p>
        <ProjectVisual project={project} />
        <ul className="project-tags" aria-label={`${project.title} technologies`}>
          {project.tags.map((tag) => <li key={tag}>{tag}</li>)}
        </ul>
        <div className="case-layout">
          <aside>
            <span className="eyebrow">ROLE &amp; SCOPE</span>
            <p>{project.contribution}</p>
            <span className="eyebrow">AT A GLANCE</span>
            <p>{project.impact}</p>
          </aside>
          <div className="case-sections">
            <section>
              <h2>The problem</h2>
              <p>{project.problem}</p>
            </section>
            <section>
              <h2>What I built</h2>
              <p>{project.approach}</p>
            </section>
            <section>
              <h2>The result</h2>
              <p>{project.result}</p>
            </section>
          </div>
        </div>
        <Link className="text-link" href="/#work">Explore more work →</Link>
      </main>
      <Footer />
    </>
  );
}
