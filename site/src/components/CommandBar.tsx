import { useState } from 'react';

/** A copyable shell command. The prompt is decoration; only the command copies. */
export default function CommandBar({ command }: { command: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setState('copied');
      setTimeout(() => setState('idle'), 1600);
    } catch {
      // Clipboard blocked — insecure context, or the user denied it. The text
      // is selectable, so say so rather than failing silently.
      setState('failed');
      setTimeout(() => setState('idle'), 2400);
    }
  }

  return (
    <div className="cmd">
      <code className="cmd-text">
        <span className="cmd-npx">npx </span>
        {command.replace(/^npx /, '')}
      </code>
      <button
        type="button"
        onClick={copy}
        className="cmd-copy"
        data-copied={state === 'copied'}
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it' : 'Copy'}
      </button>
    </div>
  );
}
