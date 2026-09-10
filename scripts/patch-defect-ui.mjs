import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('examples/desktop');

// RecorderPage
{
  const p = path.join(root, 'src-react/pages/RecorderPage.tsx');
  let t = fs.readFileSync(p, 'utf8');
  if (!t.includes('DefectEvidencePanel')) {
    t = t.replace(
      "import { RecorderSessionTimelinePanel } from '../components/RecorderSessionTimelinePanel';",
      "import { RecorderSessionTimelinePanel } from '../components/RecorderSessionTimelinePanel';\nimport { DefectEvidencePanel } from '../features/evidence/DefectEvidencePanel';",
    );
    t = t.replace(
      `                    <RecorderSessionTimelinePanel
                      sessions={dashboard.sessions}
                      selectedSession={dashboard.selectedSession}
                      selectedSessionId={dashboard.selectedSessionId}
                      events={dashboard.events}
                      videoSegments={dashboard.recentSegments}
                      loading={dashboard.loading}
                      onRefresh={() => dashboard.refresh()}
                      onSelectSession={dashboard.selectSession}
                      onError={setError}
                      toUiErrorMessage={toUiErrorMessage}
                      onPlaybackFocusChange={setPlaybackFocus}
                      privacyRulesActive={!!config.privacyEnabled}
                    />
                  </div>`,
      `                    <RecorderSessionTimelinePanel
                      sessions={dashboard.sessions}
                      selectedSession={dashboard.selectedSession}
                      selectedSessionId={dashboard.selectedSessionId}
                      events={dashboard.events}
                      videoSegments={dashboard.recentSegments}
                      loading={dashboard.loading}
                      onRefresh={() => dashboard.refresh()}
                      onSelectSession={dashboard.selectSession}
                      onError={setError}
                      toUiErrorMessage={toUiErrorMessage}
                      onPlaybackFocusChange={setPlaybackFocus}
                      privacyRulesActive={!!config.privacyEnabled}
                    />
                    <DefectEvidencePanel
                      session={dashboard.selectedSession ?? dashboard.activeSession}
                      isRecording={runtime.isRecording}
                      onPlaybackFocusChange={setPlaybackFocus}
                      onError={setError}
                      toUiErrorMessage={toUiErrorMessage}
                    />
                  </div>`,
    );
    fs.writeFileSync(p, t, 'utf8');
    console.log('RecorderPage patched', t.includes('DefectEvidencePanel'));
  } else {
    console.log('RecorderPage already patched');
  }
}

// CSS
{
  const p = path.join(root, 'src-react/styles/evidence.css');
  let t = '';
  try {
    t = fs.readFileSync(p, 'utf8');
  } catch {
    t = '';
  }
  if (!t.includes('defect-evidence-panel')) {
    t += `

.defect-evidence-panel {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
  border-radius: 12px;
  background: var(--surface-1, rgba(255,255,255,0.03));
}
.defect-evidence-header h3 {
  margin: 0 0 4px;
  font-size: 14px;
}
.defect-evidence-header p {
  margin: 0 0 10px;
  opacity: 0.75;
  font-size: 12px;
}
.defect-evidence-form {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
  margin-bottom: 10px;
}
.defect-evidence-form label {
  display: grid;
  gap: 4px;
  font-size: 12px;
}
.defect-evidence-form input {
  border-radius: 8px;
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.12));
  background: transparent;
  color: inherit;
  padding: 6px 8px;
}
.defect-evidence-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.defect-evidence-actions button {
  border-radius: 8px;
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.14));
  background: transparent;
  color: inherit;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
}
.defect-evidence-actions .btn-primary {
  background: var(--accent, #3b82f6);
  border-color: transparent;
  color: #fff;
}
.defect-evidence-status {
  margin: 0 0 8px;
  font-size: 12px;
  opacity: 0.85;
}
.defect-evidence-steps-title {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  margin-bottom: 6px;
  opacity: 0.85;
}
.defect-evidence-steps ul {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 220px;
  overflow: auto;
}
.defect-evidence-steps li button {
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 6px 4px;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  cursor: pointer;
}
.defect-evidence-steps li button strong {
  display: block;
  font-size: 12px;
}
.defect-evidence-steps li button span {
  display: block;
  font-size: 11px;
  opacity: 0.7;
}
.defect-evidence-empty {
  margin: 0;
  font-size: 12px;
  opacity: 0.7;
}
.defect-evidence-repro {
  margin-top: 10px;
  max-height: 160px;
  overflow: auto;
  padding: 8px;
  border-radius: 8px;
  background: rgba(0,0,0,0.2);
  font-size: 11px;
  white-space: pre-wrap;
}
`;
    fs.writeFileSync(p, t, 'utf8');
    console.log('evidence.css patched');
  } else {
    console.log('css already');
  }

  const styles = path.join(root, 'src-react/styles.css');
  let s = fs.readFileSync(styles, 'utf8');
  if (!s.includes("styles/evidence.css") && !s.includes('./styles/evidence.css')) {
    s = `${s.trimEnd()}\n@import './styles/evidence.css';\n`;
    fs.writeFileSync(styles, s, 'utf8');
    console.log('styles.css import added');
  } else {
    console.log('styles import ok');
  }
}

// Verify service imports actually work
{
  const service = fs.readFileSync(
    path.join(root, 'src-electron/modules/reqcase-shadow-recorder/service.ts'),
    'utf8',
  );
  console.log('service has nativeMarkTestDefect', service.includes('nativeMarkTestDefect'));
  console.log('service has markTestDefect method', service.includes('async markTestDefect'));
  const ipc = fs.readFileSync(
    path.join(root, 'src-electron/modules/reqcase-shadow-recorder/ipc.ts'),
    'utf8',
  );
  console.log('ipc has markTestDefect channel handle', ipc.includes('markTestDefect'));
  const preload = fs.readFileSync(path.join(root, 'src-electron/preload.ts'), 'utf8');
  console.log('preload has markTestDefect', preload.includes('markTestDefect'));
}
