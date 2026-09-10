import fs from 'node:fs';

const p = 'examples/desktop/src-react/components/RecorderSessionTimelinePanel.tsx';
let t = fs.readFileSync(p, 'utf8');

// Normalize to \n for edits, restore later if needed - keep \n
const hadCrlf = t.includes('\r\n');
t = t.replace(/\r\n/g, '\n');

if (!t.includes("variant?: 'full' | 'compact'") && !t.includes('variant?:')) {
  t = t.replace(
    '  onPlaybackFocusChange?: (focus: TestSessionPlaybackFocus | null) => void;\n  privacyRulesActive: boolean;\n};',
    `  onPlaybackFocusChange?: (focus: TestSessionPlaybackFocus | null) => void;
  privacyRulesActive: boolean;
  /** compact: simplified continuous-timeline companion for playback page */
  variant?: 'full' | 'compact';
};`,
  );
}

if (!t.includes('const isCompact')) {
  t = t.replace(
    '    onPlaybackFocusChange,\n  } = props;\n  const [filter, setFilter]',
    `    onPlaybackFocusChange,
    variant = 'full',
  } = props;
  const isCompact = variant === 'compact';
  const [filter, setFilter]`,
  );
}

// If privacyRulesActive is in props but not destructured, still ok
if (!t.includes('const isCompact')) {
  t = t.replace(
    '} = props;\n  const [filter, setFilter]',
    "} = props;\n  const isCompact = (props as { variant?: 'full' | 'compact' }).variant === 'compact';\n  const [filter, setFilter]",
  );
}

if (hadCrlf) {
  t = t.replace(/\n/g, '\r\n');
}

fs.writeFileSync(p, t, 'utf8');
console.log('variant', /variant\?:/.test(t));
console.log('isCompact', t.includes('const isCompact'));
