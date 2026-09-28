"use client";

import { motion, useReducedMotion } from "framer-motion";

const headlineWords = ["I", "build", "backend", "systems", "that", "scale."];

const container = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.06 },
  },
};

const word = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: "easeOut" as const },
  },
};

export default function Hero() {
  const reduceMotion = useReducedMotion();

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center text-center px-6 pt-24 overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.15]"
        style={{
          backgroundImage:
            "radial-gradient(circle, #3f3f46 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage:
            "radial-gradient(ellipse 60% 50% at 50% 40%, black, transparent)",
        }}
      />

      <p className="relative font-mono text-xs tracking-[0.3em] text-accent uppercase mb-6">
        vaibhav mahalle
      </p>

      {reduceMotion ? (
        <h1 className="relative text-5xl md:text-7xl font-semibold leading-tight max-w-4xl">
          I build backend systems that <span className="text-accent">scale.</span>
        </h1>
      ) : (
        <motion.h1
          className="relative text-5xl md:text-7xl font-semibold leading-tight max-w-4xl"
          variants={container}
          initial="hidden"
          animate="show"
        >
          {headlineWords.map((w, i) => (
            <motion.span
              key={i}
              variants={word}
              className={`inline-block mr-[0.25em] ${
                w === "scale." ? "text-accent" : ""
              }`}
            >
              {w}
            </motion.span>
          ))}
        </motion.h1>
      )}

      <p className="relative mt-6 max-w-2xl text-muted text-base md:text-lg">
        Backend engineer with 5+ years building distributed, event-driven
        Java/Spring Boot microservices on AWS — high-throughput pipelines
        (3&ndash;5M reports, 20M+ emails/year) and a production GenAI/LLM
        multi-agent chatbot. Strong in HLD/LLD, multi-tenant SaaS, and
        mentoring.
        <span className="inline-block w-[2px] h-4 bg-accent ml-1 align-middle animate-pulse" />
      </p>

      <div className="relative mt-10 flex items-center gap-6">
        <a
          href="/resume.pdf"
          className="inline-flex items-center gap-2 rounded-md bg-white text-black px-6 py-3 text-sm font-medium hover:bg-zinc-200 hover:shadow-[0_0_20px_rgba(52,211,153,0.35)] transition-all"
        >
          Download Resume
        </a>

        <div className="flex items-center gap-4 font-mono text-sm">
          <a
            href="https://www.linkedin.com/in/vaibhav-mahalle"
            target="_blank"
            rel="noreferrer"
            aria-label="LinkedIn"
            className="text-muted hover:text-accent transition-colors"
          >
            LinkedIn
          </a>
          <a
            href="https://github.com/vaibhav-mahalle"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            className="text-muted hover:text-accent transition-colors"
          >
            GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
