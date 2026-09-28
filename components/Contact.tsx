import Reveal from "@/components/motion/Reveal";

const links = [
  { label: "Email", href: "mailto:vaibhavmahalle95@gmail.com" },
  { label: "LinkedIn", href: "https://www.linkedin.com/in/vaibhav-mahalle" },
  { label: "GitHub", href: "https://github.com/vaibhav-mahalle" },
];

export default function Contact() {
  return (
    <section
      id="contact"
      className="relative max-w-content mx-auto px-6 py-28 text-center overflow-hidden"
    >
      <div className="absolute inset-x-6 inset-y-6 rounded-2xl border border-accent/20 bg-accent/[0.03]" />

      <Reveal className="relative">
        <p className="font-mono text-xs tracking-[0.3em] text-accent uppercase mb-6">
          let&apos;s talk
        </p>
        <h2 className="text-4xl md:text-6xl font-semibold leading-tight">
          Building something <span className="text-accent">interesting?</span>
        </h2>
        <p className="mt-4 text-muted max-w-xl mx-auto">
          Interested in backend, distributed systems, or GenAI opportunities?
          Let&apos;s connect!
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.href.startsWith("http") ? "_blank" : undefined}
              rel={link.href.startsWith("http") ? "noreferrer" : undefined}
              className="font-mono text-sm rounded-md border border-white/15 px-6 py-3 font-medium hover:border-accent hover:text-accent transition-colors"
            >
              {link.label}
            </a>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
