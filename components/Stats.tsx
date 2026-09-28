import Reveal from "@/components/motion/Reveal";
import CountUp from "@/components/motion/CountUp";

const stats = [
  { value: 5, suffix: "+", label: "Years building backend systems" },
  { value: 5, prefix: "3–", suffix: "M", label: "Paper reports generated / year" },
  { value: 20, suffix: "M+", label: "Emails delivered / year" },
  { value: 300, suffix: "K+", label: "Active utility customers served" },
];

export default function Stats() {
  return (
    <section className="max-w-content mx-auto px-6 pb-20">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {stats.map((stat, i) => (
          <Reveal key={stat.label} delay={i * 0.08}>
            <div className="h-full rounded-lg border border-white/10 bg-white/[0.02] px-4 pt-4 pb-5 border-t-2 border-t-accent/70">
              <p className="font-mono text-3xl md:text-4xl font-semibold">
                <CountUp target={stat.value} prefix={stat.prefix} suffix={stat.suffix} />
              </p>
              <p className="mt-2 text-xs md:text-sm text-muted">{stat.label}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
