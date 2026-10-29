import Link from 'next/link';

export function Header() {
  return (
    <header className="site-header">
      <nav className="garden-nav" aria-label="Main navigation">
        <Link className="wordmark" href="/">Vaibhav</Link>
        <Link href="/#work">Projects</Link>
        <Link href="/#writing">Writing</Link>
        <Link href="/#labs">Labs</Link>
        <Link href="/about">About</Link>
      </nav>
      <nav className="social-nav" aria-label="Social links">
        <a href="https://www.linkedin.com/in/vaibhav-mahalle" aria-label="LinkedIn">in</a>
        <a href="https://github.com/vaibhav-mahalle" aria-label="GitHub">GitHub</a>
        <a className="nav-resume" href="/resume.pdf">Resume ↗</a>
      </nav>
    </header>
  );
}

export function Footer() {
  return (
    <footer id="contact" className="site-footer">
      <div>
        <p className="eyebrow">NEXT CONVERSATION</p>
        <h2>Let’s build something useful.</h2>
        <a href="mailto:vaibhavmahalle95@gmail.com">vaibhavmahalle95@gmail.com ↗</a>
      </div>
      <div className="footer-links">
        <a href="https://www.linkedin.com/in/vaibhav-mahalle">LinkedIn ↗</a>
        <a href="https://github.com/vaibhav-mahalle">GitHub ↗</a>
        <a href="/resume.pdf">Resume ↗</a>
      </div>
      <small>Vaibhav Mahalle · Senior Backend &amp; Systems Engineer</small>
    </footer>
  );
}
