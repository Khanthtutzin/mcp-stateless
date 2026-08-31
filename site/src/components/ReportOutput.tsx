import { Fragment } from 'react';

/**
 * Renders a mcp-stateless report with the same colour encoding the CLI uses:
 * × breaking, ! advisory, READY. Nothing else is coloured.
 *
 * The report's grammar is fixed and narrow, so parsing it here keeps the
 * source data as plain copy-pasteable terminal text rather than pre-marked-up
 * segments that would drift from what the tool actually prints.
 */

type Tone = 'break' | 'advisory' | 'ready' | 'dim' | 'plain';

const TONE: Record<Tone, string> = {
  break: 't-break',
  advisory: 't-advisory',
  ready: 't-ready',
  dim: 't-dim',
  plain: 't-plain',
};

interface Segment {
  text: string;
  tone: Tone;
  bold?: boolean;
}

/** A finding line: `  × MCP001  title (SDK)` */
const FINDING = /^(\s{2})([×!])(\s)(MCP\d{3})(\s+)(.*)$/;
/** The four detail keywords the CLI indents under each finding. */
const DETAIL = /^\s{6}(found|expected|fix|spec)\b/;
/** Section headers that carry a severity. */
const HEADER = /^(Breaking|Deprecations and advisories)\b/;

function parseLine(line: string): Segment[] {
  const finding = FINDING.exec(line);
  if (finding) {
    const [, indent, glyph, gap, id, pad, rest] = finding as unknown as string[];
    const tone: Tone = glyph === '×' ? 'break' : 'advisory';
    const sdk = rest!.endsWith('(SDK)');
    return [
      { text: indent!, tone: 'plain' },
      { text: glyph!, tone },
      { text: gap!, tone: 'plain' },
      { text: id!, tone: 'plain', bold: true },
      { text: pad!, tone: 'plain' },
      { text: sdk ? rest!.slice(0, -5) : rest!, tone: 'plain' },
      ...(sdk ? [{ text: '(SDK)', tone: 'dim' as Tone }] : []),
    ];
  }

  if (DETAIL.test(line) || /^\s{16}\S/.test(line)) {
    return [{ text: line, tone: 'dim' }];
  }
  if (line.startsWith('NOT READY')) {
    return [
      { text: 'NOT READY', tone: 'break' },
      { text: line.slice(9), tone: 'dim' },
    ];
  }
  if (line.startsWith('READY')) {
    return [
      { text: 'READY', tone: 'ready' },
      { text: line.slice(5), tone: 'dim' },
    ];
  }
  if (HEADER.test(line)) {
    return [{ text: line, tone: line.startsWith('Breaking') ? 'break' : 'advisory' }];
  }
  if (/^(target:|Finished in|\s{2}\S)/.test(line)) {
    return [{ text: line, tone: 'dim' }];
  }
  if (line.startsWith('mcp-stateless')) {
    return [
      { text: 'mcp-stateless', tone: 'plain', bold: true },
      { text: line.slice(13), tone: 'dim' },
    ];
  }
  return [{ text: line, tone: 'plain' }];
}

export default function ReportOutput({
  command,
  body,
}: {
  command: string;
  body: string;
}) {
  return (
    <pre className="term-out">
      <code>
        <span className="t-dim">$ {command}</span>
        {'\n\n'}
        {body.split('\n').map((line, i) => (
          <Fragment key={i}>
            {parseLine(line).map((seg, j) => (
              <span key={j} className={`${TONE[seg.tone]}${seg.bold ? ' t-bold' : ''}`}>
                {seg.text}
              </span>
            ))}
            {'\n'}
          </Fragment>
        ))}
      </code>
    </pre>
  );
}
