import Link from 'next/link';
import { Header, Footer } from '@/components/SiteShell';
import WorkGrid from '@/components/WorkGrid';

export default function Home() {
  return (
    <>
      <Header />
      <main className="page-wrap">
        <section className="intro" id="home">
          <p className="eyebrow">SENIOR BACKEND &amp; SYSTEMS ENGINEER · BANGALORE, INDIA</p>
          <h1>Hi, I’m Vaibhav.<br />I build systems that help<br /><em>everyday life work better.</em></h1>
          <div className="intro-bottom">
            <p>With 5+ years in backend systems, I build Java/Spring Boot microservices, distributed platforms, and production multi-agent AI. My work supports millions of energy reports and customer emails each year.</p>
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

        <section id="experience" className="experience" aria-labelledby="experience-heading">
          <div className="experience-intro">
            <p className="eyebrow">EXPERIENCE</p>
            <h2 id="experience-heading">Systems at human scale.</h2>
            <p>Hands-on backend work, with leadership where the work needs it.</p>
          </div>
          <div className="experience-list">
            <article className="experience-role">
              <div className="experience-role-head">
                <h3>Software Engineer 2 · Bidgely</h3>
                <span>Nov 2022 — Present · Bangalore, India</span>
              </div>
              <p className="role-focus">Backend platforms · Production GenAI</p>
              <ul>
                <li>Led <strong>3 engineers</strong> on a report platform that produces <strong>3–5M paper reports</strong> each year. Mentored junior developers and drove code reviews.</li>
                <li>Built multi-agent AI services with LangGraph, semaphore-capped asyncio concurrency, streamed responses, and a <strong>six-evaluator</strong> LangSmith suite.</li>
              </ul>
            </article>
            <article className="experience-role">
              <div className="experience-role-head">
                <h3>Software Engineer · Accenture</h3>
                <span>Feb 2021 — May 2022 · Pune, India</span>
              </div>
              <p className="role-focus">Multi-tenant utility dashboards</p>
              <ul>
                <li>Built time-series APIs for electric, gas, water, and solar net-metering data across a dashboard with <strong>300K+ active customers</strong>.</li>
                <li>Secured services with OAuth 2.0 role-based access and improved high-traffic reads with Redis master-replica caching.</li>
              </ul>
            </article>
            <p className="education-note"><strong>B.E. Information Technology</strong> · Sinhgad College of Engineering, Pune University · Nov 2020</p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
