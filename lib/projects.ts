export type Project = {
  slug: string;
  title: string;
  summary: string;
  impact: string;
  tags: string[];
  contribution: string;
  problem: string;
  approach: string;
  result: string;
  nodes: string[];
  tone: string;
};

export const projects: Project[] = [
  {
    slug: 'energy-assistant',
    title: 'Energy, explained.',
    summary: 'A production multi-agent assistant that grounds energy answers in live account data.',
    impact: 'Production multi-agent AI',
    tags: ['Python', 'FastAPI', 'LangGraph', 'LangSmith', 'ChromaDB'],
    contribution: 'Backend engineering · Python and FastAPI',
    problem: 'Customers need clear answers about energy use and bills, grounded in their own account data.',
    approach: 'I built Python and FastAPI endpoints around a LangGraph supervisor that routes questions to usage and bill root-cause agents. Their tools call internal account APIs, while ChromaDB retrieval supplies tariff knowledge. Asyncio fan-out uses semaphore-capped concurrency to protect rate-limited upstream APIs. Responses stream over WebSockets or SSE. A six-evaluator LLM-as-judge suite in LangSmith gates prompt and model changes.',
    result: 'Per-utility pilot configuration supports rollout without code forks. Docker containers run on AWS EKS with the same development and production artifacts.',
    nodes: ['Question', 'Supervisor', 'Account tools', 'Grounded answer'],
    tone: 'sage',
  },
  {
    slug: 'home-energy-reports',
    title: 'Millions of small details.',
    summary: 'An event-driven platform that creates 3–5M personalised paper reports each year.',
    impact: '3–5M reports per year',
    tags: ['Java', 'Spring Boot', 'SQS', 'Cassandra', 'MySQL', 'Redis', 'Kinesis Firehose', 'Redshift'],
    contribution: 'Led 3 engineers · Backend APIs and PDF generation',
    problem: 'Utility partners need personalised reports assembled from composable sections during peak billing cycles.',
    approach: 'I developed backend APIs and Cassandra/MySQL persistence for a distributed report platform with 30+ composable sections. I built a PDF service with headless Chrome through CDP4. An AWS SQS daemon handles normal and priority queues. ExecutorService and CompletableFuture support concurrent generation; Redis distributed locks coordinate workers. Apache PDFBox populates forms before PDFs go to S3. QR scan events stream through Kinesis Firehose into Redshift.',
    result: 'The platform produces 3–5M paper reports each year across multiple utility partners. I led a team of three engineers, mentored junior developers, and drove JUnit 5 and Mockito-backed code reviews.',
    nodes: ['Event triggers', 'Priority SQS', 'Chrome workers', 'S3 / Redshift'],
    tone: 'peach',
  },
  {
    slug: 'email-notifications',
    title: 'The right message, at scale.',
    summary: 'A composable notification service that delivers 20M+ emails each year.',
    impact: '20M+ emails per year',
    tags: ['Java', 'Spring Boot', 'Kafka', 'SQS', 'Velocity', 'SparkPost', 'Prometheus', 'Grafana'],
    contribution: 'Designed and built · Java and Spring Boot',
    problem: 'Energy insights must reach customers across regions with different content and format needs.',
    approach: 'I designed and built an event-driven Java/Spring Boot service with a plugin-based composition engine and 15+ injectable content providers. Velocity templates compose each message. SQS controls delivery; SparkPost retries use exponential backoff with SMTP fallback. Kafka publishes utility-export events. Prometheus, Grafana, and CloudWatch track delivery rates, failures, and latency.',
    result: 'The service delivers 20M+ emails each year across four regions. Utility campaigns reuse providers without duplicate pipeline code.',
    nodes: ['Kafka events', '15+ providers', 'SQS queue', 'SMTP fallback'],
    tone: 'lilac',
  },
  {
    slug: 'utility-dashboard',
    title: 'A clearer view of energy.',
    summary: 'Time-series services for a white-label utility dashboard used by 300K+ customers.',
    impact: '300K+ active customers',
    tags: ['Java', 'Spring Boot', 'OAuth 2.0', 'Redis', 'MySQL'],
    contribution: 'Backend APIs · Accenture',
    problem: 'Customers need secure access to electric, gas, water, and solar data across utility brands.',
    approach: 'I developed layered Java/Spring Boot services and time-series REST APIs with configurable granularity. OAuth 2.0 client-credentials and refresh-token flows, JDBC token storage, and role-based access control protect the APIs. Redis master-replica and in-memory TTL caches, selective data loading, and GZIP compression support high-traffic endpoints.',
    result: 'The white-label dashboard serves more than 300K active utility customers across multi-fuel and solar net-metering data.',
    nodes: ['Fuel / solar data', 'Time-series API', 'Redis replicas', 'Dashboard API'],
    tone: 'blue',
  },
];
