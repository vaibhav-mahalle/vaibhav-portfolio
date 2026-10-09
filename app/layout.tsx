import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { metadataBase: new URL('https://vaibhavmahalle.com'), title: 'Vaibhav Mahalle — Backend Engineer', description: 'Backend engineer building Java distributed systems and production AI. Explore selected work, interactive Labs, and an illustrated personal journey.', alternates: { canonical: '/' } };
export default function RootLayout({ children }: {
    children: React.ReactNode;
}) { return <html lang="en"><body><a href="#main-content" className="skip-link">Skip to content</a><div id="main-content">{children}</div></body></html>; }
