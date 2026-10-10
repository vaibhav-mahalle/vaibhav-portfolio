import Link from 'next/link';

const chapters = [
  { label: '01', title: 'A village beginning', text: 'I grew up around village pets, including bulls and a dog. A Rajdoot motorcycle belongs to my earliest picture of that world.' },
  { label: '02', title: 'Marathi letters, then English', text: 'I began with Marathi letters. Later, I moved to an English-medium school and learned to work across two languages.' },
  { label: '03', title: 'The school road', text: 'First I went on foot. Later I rode a ladies’ bicycle along the same everyday roads.' },
  { label: '04', title: 'The milk route', text: 'I rode a motorcycle through the village to distribute milk. The milk container made an ordinary trip its own kind of journey.' },
  { label: '05', title: 'A wider road', text: 'Today, I ride a Royal Enfield. The road now reaches hills, camel rides, flights, and places beyond the village.' },
  { label: '06', title: 'What I build now', text: 'I build backend systems and production AI. I also make small Labs to explain the ideas behind the work.' },
];

export default function Journey() {
  return (
    <>
      <div className="journey-intro page-wrap">
        <p className="eyebrow">ABOUT · A FEW TURNS ALONG THE WAY</p>
        <h1>One road led<br />to another.</h1>
        <p>A personal story in words, from village lanes to backend engineering.</p>
        <div className="journey-links"><a href="#chapter-1">Start at the beginning ↓</a><Link href="/#work">Go to the projects ↗</Link><Link href="/proverbs">Marathi proverbs →</Link></div>
      </div>
      <div className="story-list page-wrap">
        {chapters.map(chapter => (
          <section className="story-entry" id={`chapter-${chapter.label}`} key={chapter.label}>
            <span className="story-number">{chapter.label}</span>
            <div><p className="eyebrow">A LITTLE FURTHER</p><h2>{chapter.title}</h2></div>
            <p className="story-copy">{chapter.text}</p>
          </section>
        ))}
      </div>
      <section className="journey-end page-wrap">
        <p className="eyebrow">THE NEXT CHAPTER</p>
        <h2>Small experiments.<br />New possibilities.</h2>
        <Link className="button" href="/#labs">Explore my Labs ↗</Link>
        <Link href="/#work">See my work →</Link>
      </section>
    </>
  );
}
