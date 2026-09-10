import fs from 'node:fs';

const p = 'examples/desktop/src-react/components/RecorderSessionTimelinePanel.tsx';
let t = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const start = t.indexOf('{timelineItems.map((item, index) => {');
if (start < 0) {
  console.error('timelineItems.map not found');
  process.exit(1);
}
const olEnd = t.indexOf('</ol>', start);
if (olEnd < 0) {
  console.error('</ol> not found');
  process.exit(1);
}
const segment = t.slice(start, olEnd);
const closeIdx = segment.lastIndexOf('})}');
if (closeIdx < 0) {
  console.error('map close not found');
  console.error(segment.slice(-300));
  process.exit(1);
}

const newMap = `{timelineItems.map((item, index) => {
              const event = item.event;
              const detail = event ? resolveEventDetail(event) : null;
              const tone = item.tone || (event ? resolveEventTone(event) : 'operation');
              const active = event ? selectedEventId === event.eventId : false;
              return (
                <li key={item.key} className={\`event-timeline-item-wrap kind-\${item.kind}\`}>
                  <button
                    type="button"
                    className={\`event-timeline-item tone-\${tone}\${active ? ' is-active' : ''}\`}
                    onClick={() => {
                      if (event) {
                        handleSelectEvent(event);
                      } else {
                        onPlaybackFocusChange?.({
                          eventId: item.key,
                          sessionId: selectedSessionId ?? undefined,
                          occurredAtMs: item.occurredAtMs,
                        } as any);
                      }
                    }}
                    aria-current={active ? 'true' : undefined}
                  >
                    <span className="event-timeline-rail" aria-hidden="true">
                      <span className={\`event-timeline-dot tone-\${tone}\`} />
                      {index < timelineItems.length - 1 ? <span className="event-timeline-line" /> : null}
                    </span>
                    <span className="event-timeline-card">
                      <span className="event-timeline-meta">
                        <time className="event-timeline-time" dateTime={new Date(item.occurredAtMs).toISOString()}>
                          {formatDateTime(item.occurredAtMs)}
                        </time>
                        <span className={\`event-timeline-badge tone-\${tone}\`}>
                          {item.badge}
                        </span>
                      </span>
                      <span className="event-timeline-title">{item.title}</span>
                      {detail ? <span className="event-timeline-detail">{detail}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}`;

t = t.slice(0, start) + newMap + t.slice(start + closeIdx + 3);
fs.writeFileSync(p, t, 'utf8');
console.log('timeline items render fixed');
