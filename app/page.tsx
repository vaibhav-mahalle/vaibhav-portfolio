import Link from 'next/link';
import { Header, Footer } from '@/components/SiteShell';
import WorkGrid from '@/components/WorkGrid';

export default function Home() {
  return (
    <>
      <Header />
      <main className="page-wrap">
        <section className="intro" id="home">
          <p className="eyebrow">BACKEND ENGINEER · BANGALORE, INDIA</p>
          <h1>Hi, I’m Vaibhav.<br />I build systems that help<br /><em>everyday life work better.</em></h1>
          <div className="intro-bottom">
            <p>I work across Java, distributed systems, and production AI. My recent work supports millions of energy reports and customer emails.</p>
            <div className="intro-actions">
              <a className="button" href="/resume.pdf">Resume ↗</a>
              <a href="#contact">Email me ↗</a>
            </div>
          </div>
        </section>

        <WorkGrid />

        <section id="about" className="about-teaser">
          <div className="about-marker" aria-hidden="true"><span lang="mr">अ आ इ</span><i>→</i><span>ABC</span></div>
          <div>
            <p className="eyebrow">A LITTLE ABOUT ME</p>
            <h2>Before the systems,<br />there were village roads.</h2>
            <p>Marathi letters. A walk to school. A ladies’ bicycle. A milk route. The world grew one road at a time.</p>
            <Link className="text-link" href="/about">A few more turns <span>→</span></Link>
          </div>
        </section>

        <section id="experience" className="experience">
          <h2>Places I’ve learned and built</h2>
          <div>
            <p><strong>Software Engineer 2 · Bidgely</strong><span>Nov 2022 — present</span>Backend platforms and production AI.</p>
            <p><strong>Software Engineer · Accenture</strong><span>Feb 2021 — May 2022</span>Utility dashboard services.</p>
            <p><strong>B.E. · Information Technology</strong><span>Nov 2020</span>Sinhgad College of Engineering, Pune University.</p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
