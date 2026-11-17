import type { ReactNode } from 'react';

/**
 * An in-page "are you sure?" panel. Used instead of the browser's confirm(),
 * which some browsers (including embedded ones) block.
 */
export function ConfirmPanel({ title, children, confirmLabel, danger = true, onConfirm, onCancel }: {
  title: string; children?: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className={`notice ${danger ? 'warn' : ''}`} role="alertdialog" aria-label={title}>
      <b>{title}</b>
      {children && <div style={{ margin: '6px 0' }}>{children}</div>}
      <div className="row" style={{ marginTop: 6 }}>
        <button className="primary" style={danger ? { background: 'var(--bad)', borderColor: 'var(--bad)' } : undefined} onClick={onConfirm}>{confirmLabel}</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
