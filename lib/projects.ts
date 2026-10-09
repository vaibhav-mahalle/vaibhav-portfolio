export type Project = {
    slug: string;
    title: string;
    summary: string;
    impact: string;
    tags: string[];
    problem: string;
    approach: string;
    result: string;
    nodes: string[];
    tone: string;
};
export const projects: Project[] = [
    { slug: 'energy-assistant', title: 'Energy, explained.', summary: 'A production AI assistant that connects customer questions to live energy data.', impact: 'Production multi-agent AI', tags: ['Python', 'FastAPI', 'LangGraph'], problem: 'Customers need clear answers about energy use and bills, grounded in their account data.', approach: 'I built the FastAPI backend with a LangGraph supervisor and specialised agents. Tools call internal APIs. Responses stream over WebSockets and SSE. Concurrency limits protect upstream services, and retrieval supplies tariff context.', result: 'A six-evaluator suite checks prompt and model changes before release. Configuration supports utility pilots without separate code forks.', nodes: ['Question', 'Supervisor', 'Account tools', 'Answer'], tone: 'sage' },
    { slug: 'home-energy-reports', title: 'Millions of small details.', summary: 'An event-driven platform for personalised paper energy reports.', impact: '3–5M reports per year', tags: ['Java', 'Spring Boot', 'SQS', 'Redis'], problem: 'Utility partners need millions of personalised reports assembled from interchangeable sections during peak billing cycles.', approach: 'I built backend APIs, persistence, and the PDF generation service. SQS separates normal and priority work. Headless Chrome renders reports, Redis coordinates workers, and S3 stores the finished files. I led three engineers.', result: 'The platform produces 3–5M paper reports per year. QR scan events connect paper reports to digital sessions.', nodes: ['Sections', 'SQS queue', 'PDF workers', 'S3 reports'], tone: 'peach' },
    { slug: 'email-notifications', title: 'The right message, at scale.', summary: 'Composable energy insights, delivered across four regions.', impact: '20M+ emails per year', tags: ['Java', 'Kafka', 'SQS'], problem: 'Energy insights must reach customers by email across regions with different content and format requirements.', approach: 'I built an event-driven service with more than 15 injectable content providers. SQS controls delivery, with retries and SMTP fallback. Kafka publishes export events. Monitoring tracks delivery rates, failures, and latency.', result: 'The service delivers more than 20M emails per year. Campaigns reuse content providers without duplicate pipeline code.', nodes: ['Providers', 'Compose', 'Delivery queue', 'Inbox'], tone: 'lilac' },
    { slug: 'utility-dashboard', title: 'A clearer view of energy.', summary: 'Backend services for a dashboard across utility brands and fuel types.', impact: '300K+ active customers', tags: ['Spring Boot', 'OAuth 2.0', 'Redis'], problem: 'Customers need secure access to electric, gas, water, and solar data on shared utility infrastructure.', approach: 'I built Spring Boot services and time-series aggregation APIs with configurable granularity. OAuth 2.0 and role-based access protect data. Redis and in-memory caches reduce repeated work.', result: 'Selective data loading, caching, and compression improve response times on high-traffic endpoints.', nodes: ['Usage data', 'Aggregation', 'Cache', 'Dashboard'], tone: 'blue' }
];
