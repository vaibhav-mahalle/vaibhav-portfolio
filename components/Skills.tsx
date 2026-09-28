import Reveal from "@/components/motion/Reveal";

const skillGroups = [
  {
    label: "GenAI/LLM",
    span: "md:col-span-2",
    highlight: true,
    items: [
      "LangGraph",
      "OpenAI & Gemini APIs",
      "RAG (ChromaDB)",
      "LLM-as-judge (LangSmith)",
    ],
  },
  {
    label: "Languages",
    span: "",
    items: ["Java", "Python", "SQL"],
  },
  {
    label: "Core Java",
    span: "",
    items: ["Collections", "Streams API", "Concurrency", "Multithreading"],
  },
  {
    label: "Databases & Messaging",
    span: "md:col-span-2",
    items: [
      "MySQL",
      "Cassandra",
      "Redshift",
      "Redis",
      "ChromaDB",
      "AWS SQS",
      "Kafka",
      "Kinesis Firehose",
    ],
  },
  {
    label: "Frameworks",
    span: "",
    items: ["Spring", "Spring Boot", "JUnit", "Mockito", "FastAPI"],
  },
  {
    label: "Cloud",
    span: "",
    items: [
      "AWS S3",
      "API Gateway",
      "Lambda",
      "EC2",
      "EKS (Kubernetes)",
      "CloudFront",
      "CloudWatch",
    ],
  },
  {
    label: "CI/CD & DevOps",
    span: "",
    items: ["Jenkins", "Docker", "Prometheus", "Grafana"],
  },
  {
    label: "Competencies",
    span: "md:col-span-2",
    highlight: true,
    items: [
      "DSA",
      "LLD/HLD System Design",
      "Microservices",
      "Distributed Systems",
      "Event-Driven Architecture",
      "RESTful APIs",
      "OAuth 2.0",
    ],
  },
];

export default function Skills() {
  return (
    <section id="skills" className="max-w-content mx-auto px-6 py-28">
      <Reveal>
        <h2 className="text-3xl md:text-4xl font-semibold mb-12">
          Skills &amp; Stack
        </h2>
      </Reveal>

      <div className="grid md:grid-cols-3 gap-4">
        {skillGroups.map((group, i) => (
          <Reveal key={group.label} delay={i * 0.05} className={group.span}>
            <div
              className={`h-full rounded-lg border p-5 transition-colors ${
                group.highlight
                  ? "border-accent/30 bg-accent/[0.04]"
                  : "border-white/10 bg-white/[0.02]"
              }`}
            >
              <h3 className="font-mono text-xs text-muted uppercase tracking-wide mb-3">
                {group.label}
              </h3>
              <div className="flex flex-wrap gap-2">
                {group.items.map((item) => (
                  <span
                    key={item}
                    className="text-xs rounded-full border border-white/15 px-3 py-1 text-body hover:border-accent/60 hover:text-accent transition-colors"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
