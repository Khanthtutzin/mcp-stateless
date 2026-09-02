import { useState } from 'react';
import ReportOutput from './ReportOutput';
import { TABS } from '../data/reports';

/**
 * The page's thesis, and its one memorable element: the same server reported
 * twice. Everything the tool exists to say — you are broken, almost none of it
 * is your fault, one upgrade clears it — is legible from the two tabs without
 * reading a word of marketing copy.
 */
export default function ReportTabs() {
  const [active, setActive] = useState(0);
  const tab = TABS[active]!;

  function onKey(e: React.KeyboardEvent, i: number) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    setActive(next);
    document.getElementById(`tab-${TABS[next]!.id}`)?.focus();
  }

  return (
    <div className="term">
      <div role="tablist" aria-label="Example report" className="term-bar">
        <span className="term-label">notes server · stdio</span>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={i === active}
            aria-controls={`panel-${t.id}`}
            onClick={() => setActive(i)}
            onKeyDown={(e) => onKey(e, i)}
            tabIndex={i === active ? 0 : -1}
            className="tab"
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id={`panel-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`}>
        <ReportOutput command={tab.command} body={tab.body} />
      </div>
    </div>
  );
}
