import Link from 'next/link';
import { projects, Project } from '@/lib/projects';

export function ProjectVisual({ project }: { project: Project }) {
  return (
    <div className={`project-visual ${project.tone}`} aria-hidden="true">
      <span className="visual-note">
        {project.slug === 'energy-assistant' ? 'A question becomes an answer.' : 'Small parts. One reliable system.'}
      </span>
      <div className="system-flow">
        {project.nodes.map((node, index) => (
          <span key={node} className={`node node-${index}`}>
            {index === 0 ? '○' : index === 3 ? '↗' : '▤'}
            <b>{node}</b>
          </span>
        ))}
      </div>
      <span className="visual-caption">{project.tags.join(' / ')}</span>
    </div>
  );
}

export default function WorkGrid() {
  return (
    <section id="work" className="work-section">
      <div className="section-bar">
        <p className="eyebrow">THINGS I’VE HELPED BUILD</p>
        <span>Selected projects · 01—04</span>
      </div>
      <div className="work-grid">
        {projects.map((project, index) => (
          <Link href={`/work/${project.slug}`} className={`work-card work-card-${index + 1}`} key={project.slug}>
            <ProjectVisual project={project} />
            <div className="card-copy">
              <span className="eyebrow">{project.impact}</span>
              <h2>{project.title}<span>↗</span></h2>
              <p>{project.summary}</p>
            </div>
          </Link>
        ))}
        <article id="writing" className="writing-card">
          <p className="eyebrow">A NOTE FROM THE LABS</p>
          <h2>When a lock expires, the old worker may still be working.</h2>
          <p>A timeout does not stop a slow worker from writing. A fencing token lets storage reject that stale write.</p>
          <a className="text-link" href="https://labss-three.vercel.app/labs/distributed-lock">Read the note and try the demo <span>↗</span></a>
        </article>
        <article id="labs" className="lab-card">
          <div className="lab-art" aria-hidden="true">
            <span>worker A <b>01</b></span><span className="lock">⌑</span><span>worker B <b>02</b></span>
            <em>stale write → blocked</em>
          </div>
          <div className="card-copy">
            <span className="eyebrow">LAB 001 · DISTRIBUTED SYSTEMS</span>
            <h2>Who owns the lock?</h2>
            <p>Watch two workers race for one lock. See a fencing token catch the stale write.</p>
            <a href="https://labss-three.vercel.app/labs/distributed-lock">Explore the experiment ↗</a>
            <a className="labs-index" href="https://labss-three.vercel.app/">All labs ↗</a>
          </div>
        </article>
      </div>
    </section>
  );
}
