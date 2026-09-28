# Vaibhav Mahalle — Portfolio

Personal portfolio site, built with Next.js (App Router), Tailwind CSS, and Framer Motion.

## Sections

- **Hero** — kinetic headline reveal, resume download, social links
- **Stats** — animated count-up KPI tiles (experience, scale metrics)
- **About** — changelog/timeline-style work history
- **Skills** — bento grid of tech stack by category
- **Portfolio** — expandable case-study cards (problem / approach / result)
- **Contact** — email / LinkedIn / GitHub

## Design system

- Fonts: Inter (body/headings), JetBrains Mono (labels, tags, meta)
- Background: near-black (`#050505`), accent: terminal green (`#34d399`)
- Motion: scroll-triggered reveals and count-ups via Framer Motion, respecting
  `prefers-reduced-motion`

## Getting started

Requires Node 18.17+ (use `nvm install 20 && nvm use 20` if your default is older).

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Build for production

```bash
npm run build
npm start
```
