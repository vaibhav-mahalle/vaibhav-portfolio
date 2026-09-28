export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-white/10 py-8">
      <p className="text-center text-xs text-muted">
        © {year} Vaibhav Mahalle. All rights reserved.
      </p>
      <p className="mt-2 text-center font-mono text-[11px] text-muted/60">
        built with next.js · last deployed {year}
      </p>
    </footer>
  );
}
