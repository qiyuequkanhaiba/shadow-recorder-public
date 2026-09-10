import fs from 'node:fs';

const p = 'examples/desktop/src-react/styles/evidence.css';
let t = fs.readFileSync(p, 'utf8');
if (!t.includes('precision-badge')) {
  t += `
.defect-step-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 2px;
}
.precision-badge {
  display: inline-flex;
  align-self: flex-start;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 10px;
  letter-spacing: 0.02em;
  border: 1px solid rgba(255,255,255,0.12);
}
.precision-l3 { background: rgba(34,197,94,0.18); color: #86efac; }
.precision-l2 { background: rgba(59,130,246,0.18); color: #93c5fd; }
.precision-l1 { background: rgba(245,158,11,0.16); color: #fcd34d; }
.precision-l0 { background: rgba(148,163,184,0.16); color: #cbd5e1; }
`;
  fs.writeFileSync(p, t, 'utf8');
  console.log('css badges added');
} else {
  console.log('css ok');
}
