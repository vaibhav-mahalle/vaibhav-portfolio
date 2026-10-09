import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { metadataBase: new URL('https://vaibhavmahalle.com'), title: 'Vaibhav Mahalle — Senior Backend & Systems Engineer', description: 'Senior backend and systems engineer building Java distributed platforms and production multi-agent AI. Explore verified system stories, Labs, and a personal journey.', alternates: { canonical: '/' } };
export default function RootLayout({ children }: {
    children: React.ReactNode;
}) { return <html lang="en"><body><a href="#main-content" className="skip-link">Skip to content</a><div id="main-content">{children}</div></body></html>; }
