import type { Metadata } from 'next';
import { Header, Footer } from '@/components/SiteShell';
import Journey from '@/components/Journey';
export const metadata: Metadata = { title: 'A little further — Vaibhav Mahalle', description: 'A personal journey from village life and Marathi letters to backend engineering.', alternates: { canonical: '/about' } };
export default function AboutPage() { return <><Header /><main><Journey /></main><Footer /></>; }
