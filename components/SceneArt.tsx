const bounds = [0, 228, 418, 640, 863, 1090, 1302, 1536];
export default function SceneArt({ scene, className = '' }: {
    scene: number;
    className?: string;
}) { return <svg className={className} viewBox={`0 ${bounds[scene]} 1024 ${bounds[scene + 1] - bounds[scene]}`} aria-hidden="true" focusable="false"><image href="/art/journey.png" width="1024" height="1536"/></svg>; }
