'use client';
import { useRef } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';
import Link from 'next/link';
import SceneArt from './SceneArt';
const chapters = [
    { title: 'A village. A Rajdoot. A beginning.', label: '01 / HOME', copy: 'My story starts in a village, with bulls, a dog, and a courtyard. That small child on the Rajdoot was me.' },
    { title: 'First, अ आ इ. Then, A B C.', label: '02 / FIRST LETTERS', copy: 'I started with Marathi letters, then moved to English-medium school. A new language became part of my world.' },
    { title: 'A little further, on two wheels.', label: '03 / THE SCHOOL ROUTE', copy: 'First on foot. Then on a ladies’ bicycle. The road stayed familiar; the way I travelled changed.' },
    { title: 'The milk route.', label: '04 / EVERYDAY LIFE', copy: 'I rode through the village to distribute milk, with a milk container attached to the bike. This road is part of my story too.' },
    { title: 'Another bike. A wider horizon.', label: '05 / THE OPEN ROAD', copy: 'From that childhood Rajdoot to my Royal Enfield. Now the road leads into hills and beyond the familiar turns.' },
    { title: 'There is more to see.', label: '06 / FURTHER AFIELD', copy: 'A camel ride. A flight. New places and new views. The journey continues beyond two wheels.' },
    { title: 'And today, I build.', label: '07 / STILL CURIOUS', copy: 'I build backend systems, work with production AI, and explore ideas through small Labs. There is always another thing to understand.' }
];
function Chapter({ index }: {
    index: number;
}) { const ref = useRef<HTMLElement>(null); const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] }); const x = useTransform(scrollYProgress, [0, 1], ['-2%', '2%']); const scale = useTransform(scrollYProgress, [0, .5, 1], [1.06, 1, 1.06]); return <section ref={ref} className="chapter" id={`chapter-${index + 1}`}><div className="chapter-sticky"><div className="chapter-heading"><p className="eyebrow">{chapters[index].label}</p><span aria-hidden="true">{String(index + 1).padStart(2, '0')} / 07</span></div><div className="scene-window"><motion.div className="scene-motion" style={{ x, scale }}><SceneArt scene={index}/></motion.div>{index === 1 && <div className="letter-strip" aria-hidden="true"><span lang="mr">अ आ इ</span><span>→</span><span>A B C</span></div>}</div><div className="chapter-copy"><h2>{chapters[index].title}</h2><p>{chapters[index].copy}</p></div><div className="journey-track" aria-hidden="true"><motion.span style={{ scaleX: scrollYProgress }}/></div></div></section>; }
export default function Journey() { return <><div className="journey-intro page-wrap"><p className="eyebrow">A LITTLE FURTHER · AN ILLUSTRATED JOURNEY</p><h1>The roads<br />that brought me here.</h1><p>From Marathi letters and village lanes to backend systems and a wider world.</p><div className="journey-links"><a href="#chapter-1">Scroll to explore ↓</a><Link href="/#work">Go straight to my work ↗</Link></div></div><div className="journey-chapters">{chapters.map((c, i) => <Chapter key={c.label} index={i}/>)}</div><div className="journey-end page-wrap"><p className="eyebrow">THE NEXT CHAPTER</p><h2>Small experiments.<br />New possibilities.</h2><Link className="button" href="/#labs">Explore my Labs ↗</Link><Link href="/#work">See my work →</Link></div></>; }
