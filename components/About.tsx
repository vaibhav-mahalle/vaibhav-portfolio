import Reveal from "@/components/motion/Reveal";

const entries = [
  {
    date: "2022-11 → present",
    tag: "work",
    title: "Software Engineer 2 — Bidgely",
    detail:
      "Backend APIs and distributed pipelines for a report-generation platform used across multiple utility partners, plus Python/FastAPI services for a production multi-agent GenAI chatbot.",
  },
  {
    date: "2021-02 → 2022-05",
    tag: "work",
    title: "Software Engineer — Accenture",
    detail:
      "White-labeled dashboard services for 300K+ utility customers.",
  },
  {
    date: "2020-11",
    tag: "education",
    title: "B.E., Information Technology",
    detail: "Sinhgad College of Engineering, Pune University.",
  },
];

export default function About() {
  return (
    <section id="about" className="max-w-content mx-auto px-6 py-28">
      <Reveal>
        <h2 className="text-3xl md:text-4xl font-semibold mb-2">About Me</h2>
        <p className="font-mono text-xs text-muted mb-10">
          # based in Bangalore · java/spring boot, python, aws, genai/llm
        </p>
      </Reveal>

      <div className="relative pl-6 border-l border-white/10 space-y-10">
        {entries.map((entry, i) => (
          <Reveal key={entry.title} delay={i * 0.08}>
            <div className="relative">
              <span className="absolute -left-[27px] top-1 w-2.5 h-2.5 rounded-full bg-accent" />
              <p className="font-mono text-xs text-accent mb-1">
                {entry.date} <span className="text-muted">// {entry.tag}</span>
              </p>
              <h3 className="text-lg font-medium">{entry.title}</h3>
              <p className="mt-1 text-muted text-sm leading-relaxed max-w-2xl">
                {entry.detail}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
