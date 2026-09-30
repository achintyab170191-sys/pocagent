import { type ReactNode } from 'react';

export function SyntheticBanner() {
  return <div className="banner"><div role="note"><span className="dot" aria-hidden="true" /><span><strong>Synthetic data · proof of concept.</strong> Every record, document and message here is synthetic. No production system is read or updated and no message is sent.</span></div></div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint ? <span className="field-hint">{hint}</span> : null}</label>;
}

export function Notice({ tone, children }: { tone: 'error' | 'success' | 'info'; children: ReactNode }) {
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Badge({ value }: { value: string }) {
  const tone = ['APPROVE', 'READY_TO_PROCEED', 'ACCEPTED', 'COMPLETED', 'LIVE'].includes(value) ? 'good' : ['REJECT', 'CANCELLED'].includes(value) ? 'bad' : ['REQUEST_CAPTURED', 'ROUTED'].includes(value) ? 'info' : ['NOT_BUILT', 'NOT_AUTOMATED', ''].includes(value) ? 'muted' : 'warn';
  return <span className={`badge badge-${tone}`}>{value ? value.replaceAll('_', ' ') : 'NONE'}</span>;
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return <dl className="kv">{rows.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value === '' || value === undefined || value === null ? <span className="muted">—</span> : value}</dd></div>)}</dl>;
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** Renders the curated chat markdown (headings, bold, lists, rules) as React nodes. Never uses innerHTML, so message text cannot inject markup. */
export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return <div className="markdown">{blocks.map((block, index) => {
    if (block.startsWith('## ')) return <h3 key={index}>{inline(block.slice(3))}</h3>;
    if (block.startsWith('### ')) {
      const [heading, ...rest] = block.split('\n');
      const lines = rest.filter(Boolean);
      const isList = lines.length > 0 && lines.every((line) => line.startsWith('- '));
      return <section key={index}><h4>{heading!.slice(4)}</h4>{isList ? <ul>{lines.map((line, position) => <li key={position}>{inline(line.slice(2))}</li>)}</ul> : lines.length ? <p>{inline(lines.join(' '))}</p> : null}</section>;
    }
    if (block.startsWith('---')) return <div key={index}><hr />{block.slice(3).trim() ? <p className="muted">{inline(block.slice(3).trim())}</p> : null}</div>;
    if (block.split('\n').every((line) => line.startsWith('- ') || line.startsWith('• '))) return <ul key={index}>{block.split('\n').map((line, position) => <li key={position}>{inline(line.slice(2))}</li>)}</ul>;
    const lines = block.split('\n');
    const firstBullet = lines.findIndex((line) => line.startsWith('- ') || line.startsWith('• '));
    if (firstBullet > 0 && lines.slice(firstBullet).every((line) => line.startsWith('- ') || line.startsWith('• '))) return <div key={index}><p>{inline(lines.slice(0, firstBullet).join(' '))}</p><ul>{lines.slice(firstBullet).map((line, position) => <li key={position}>{inline(line.slice(2))}</li>)}</ul></div>;
    return <p key={index}>{lines.map((line, position) => <span key={position}>{inline(line)}{position < lines.length - 1 ? <br /> : null}</span>)}</p>;
  })}</div>;
}
