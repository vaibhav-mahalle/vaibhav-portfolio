"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Reveal from "@/components/motion/Reveal";

type CaseStudy = {
  title: string;
  problem: string;
  approach: string;
  result: string;
  tags: string[];
  span?: string;
};

const caseStudies: CaseStudy[] = [
  {
    title: "GenAI Energy Assistant",
    span: "md:col-span-2",
    problem:
      "Utility customers ask free-form questions about usage and billing; support teams needed grounded, real-time answers without building a separate bot per use case.",
    approach:
      "Built the Python/FastAPI backend for a multi-agent chatbot — a LangGraph supervisor routes each query to specialized agents (usage, bill root-cause) whose LLM tools call internal APIs so every answer is grounded in the customer's live account data. Responses stream token-by-token over WebSockets/SSE using asyncio fan-out with semaphore-capped concurrency against rate-limited upstream APIs. Tariff knowledge is served through RAG over ChromaDB, and per-utility pilots roll out via configuration with no code forks; deployed as identical Docker artifacts on AWS EKS across dev/prod.",
    result:
      "Every prompt/model change is gated on a six-evaluator LLM-as-judge suite integrated with LangSmith before it ships — catching regressions before they reach a system customers talk to directly.",
    tags: ["Python", "FastAPI", "LangGraph", "RAG", "AWS EKS"],
  },
  {
    title: "Home Energy Report (HER)",
    problem:
      "Utility partners needed millions of personalized paper energy reports assembled and mailed every year, from 30+ interchangeable sections, without the pipeline falling behind during peak billing cycles.",
    approach:
      "Built the backend APIs and Cassandra/MySQL persistence layer in Java/Spring Boot, plus the PDF generation microservice itself — headless Chrome via CDP, driven by an event-driven SQS daemon that separates normal and priority queues. Report generation is multi-threaded with ExecutorService/CompletableFuture, coordinated with Redis distributed locking, with form population via Apache PDFBox before the finished PDF persists to S3. Led a team of 3 engineers and drove JUnit 5/Mockito-backed code review for on-time releases.",
    result:
      "Produces 3–5M paper reports a year across multiple utility partners. QR codes generated via an AWS Lambda image call link each paper report back to a digital session, with scan events streamed through Kinesis Firehose into Redshift for paper-to-digital tracking.",
    tags: ["Java", "Spring Boot", "Cassandra", "AWS SQS", "Redis"],
  },
  {
    title: "Email Notification System",
    problem:
      "The same energy-insight content going into paper reports also needed to reach customers by email at much higher cadence and volume, across four regions with different formatting needs (NA, EU, Canada, Japan).",
    approach:
      "Designed and built a scalable, event-driven email microservice in Java/Spring Boot with a plugin-based section-composition engine — 15+ injectable content providers (cost widgets, neighborhood comparisons, appliance breakdowns, energy tips) that compose per campaign without duplicating pipeline code. Delivery runs on AWS SQS with Velocity templates and SparkPost, exponential-backoff retry and SMTP fallback for deliverability, and publishes utility-export event streams via Kafka. Jenkins CI/CD automates testing and deployment on EC2, with Prometheus/Grafana and CloudWatch alerting on delivery rate, failures, and latency.",
    result:
      "Delivers 20M+ emails a year with visibility into failures before they become customer-facing incidents.",
    tags: ["Java", "Spring Boot", "Kafka", "AWS SQS"],
  },
  {
    title: "Utility Web Dashboard",
    problem:
      "A white-labeled customer dashboard needed to show usage across electric, gas, water, and solar net-metering for 300K+ active customers — fast, securely, and across multiple utility brands on shared infrastructure.",
    approach:
      "Built layered Spring Boot services and time-series aggregation REST APIs supporting multiple fuel types with configurable granularity. Secured the APIs with OAuth 2.0 (client_credentials and refresh_token grant types), JDBC-backed token persistence, and role-based access control.",
    result:
      "Optimized response times on high-traffic endpoints using Redis master-replica caching, in-memory TTL caching, selective data loading, and GZIP compression.",
    tags: ["Java", "Spring Boot", "OAuth 2.0", "Redis"],
  },
];

function CaseStudyCard({ cs, delay }: { cs: CaseStudy; delay: number }) {
  const [open, setOpen] = useState(false);

  return (
    <Reveal delay={delay} className={cs.span}>
      <div
        className={`h-full rounded-lg border p-6 flex flex-col gap-3 transition-colors ${
          open
            ? "border-accent/50 bg-white/[0.04]"
            : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]"
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-left flex items-start justify-between gap-4"
        >
          <span className="text-lg font-medium">{cs.title}</span>
          <span className="font-mono text-xs text-accent shrink-0 mt-1">
            {open ? "[−]" : "[+]"}
          </span>
        </button>

        <p className="text-sm text-muted leading-relaxed">
          <span className="text-body font-medium">Problem: </span>
          {cs.problem}
        </p>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              <div className="space-y-3 text-sm text-muted leading-relaxed pt-1">
                <p>
                  <span className="text-body font-medium">Approach: </span>
                  {cs.approach}
                </p>
                <p>
                  <span className="text-body font-medium">Result: </span>
                  {cs.result}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="mt-auto flex flex-wrap gap-2 pt-2">
          {cs.tags.map((tag) => (
            <span
              key={tag}
              className="font-mono text-xs rounded-full border border-white/15 px-3 py-1 text-muted"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

export default function Portfolio() {
  return (
    <section id="work" className="max-w-content mx-auto px-6 py-28">
      <Reveal>
        <h2 className="text-3xl md:text-4xl font-semibold mb-2">
          My Portfolio
        </h2>
        <p className="font-mono text-xs text-muted mb-12">
          # click a card to expand approach + result
        </p>
      </Reveal>

      <div className="grid md:grid-cols-2 gap-6">
        {caseStudies.map((cs, i) => (
          <CaseStudyCard key={cs.title} cs={cs} delay={i * 0.06} />
        ))}
      </div>
    </section>
  );
}
