import type { ReactNode } from 'react';
import { ArrowUpRight, LoaderCircle, Check, Info } from 'lucide-react';
export function Button({
  children,
  busy = false,
  variant = 'primary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  busy?: boolean;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return (
    <button
      {...props}
      disabled={busy || props.disabled}
      className={`button ${variant} ${props.className ?? ''}`}
    >
      {busy && <LoaderCircle size={15} className="spin" />}
      {children}
    </button>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Status({ value }: { value?: string | null }) {
  const s = value ?? 'unknown';
  return (
    <span
      className={`status ${['approved', 'live', 'verified_live', 'connected', 'paid', 'ready', 'sent', 'published'].includes(s) ? 'positive' : ['rejected', 'failed', 'revoked', 'paused', 'expired', 'reconciliation_required'].includes(s) ? 'warning' : ''}`}
    >
      <i />
      {s.replaceAll('_', ' ')}
    </span>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Info size={22} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Panel({
  title,
  subtitle,
  children,
  action,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="panel">
      {title && (
        <header className="panel-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}
export function External({ href, children }: { href?: string | null; children: ReactNode }) {
  return href && /^https?:\/\//.test(href) ? (
    <a className="external" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ArrowUpRight size={14} />
    </a>
  ) : null;
}
export function CheckLine({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="checkline">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}
export function Done({ children }: { children: ReactNode }) {
  return (
    <div className="notice success">
      <Check size={16} />
      {children}
    </div>
  );
}
