import { clsx } from 'clsx';
import { CircleAlert } from 'lucide-react';
import { type ComponentProps, type ReactNode, useId } from 'react';

/** Spread onto the one text-like control (`<input {...control} />`); className carries the 44px tap height. */
export type FieldControlProps = {
  id: string;
  className: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
};

export type FieldProps = Omit<ComponentProps<'div'>, 'children' | 'id'> & {
  label: ReactNode;
  hint?: ReactNode;
  /** Error text. Rendered with an icon prefix and role="alert"; absent means no error markup at all. */
  error?: ReactNode;
  /** Control id; a stable useId() is used when omitted. */
  id?: string;
  /** Render prop: receives the id/aria props and className the single control must spread. */
  children: (control: FieldControlProps) => ReactNode;
};

/* DESIGN.md Inputs: 1px Chalk Line border, white fill, 12px radius, 44px minimum height, 12px 13px padding,
 * Field Green border on focus (the global focus ring is inherited, not restyled). 16px text keeps it readable. */
const controlClass = clsx(
  'min-h-tap w-full min-w-0 rounded-control border border-line bg-white px-3.25 py-3 text-base text-ink',
  'placeholder:text-muted focus-visible:border-accent',
  'disabled:cursor-not-allowed disabled:bg-bg disabled:text-muted',
);

export function Field({ label, hint, error, id, className, children, ...props }: FieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const hasHint = Boolean(hint);
  const hasError = Boolean(error);
  const describedBy = [hasHint ? hintId : null, hasError ? errorId : null].filter(Boolean).join(' ');

  return (
    <div {...props} data-tone={hasError ? 'error' : 'default'} className={clsx('flex min-w-0 flex-col gap-2', className)}>
      <label htmlFor={controlId} className="break-words text-[13px] font-bold text-ink">
        {label}
      </label>
      {children({
        id: controlId,
        className: controlClass,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': hasError ? true : undefined,
      })}
      {hasHint ? (
        <p id={hintId} className="break-words text-[13px] text-muted">
          {hint}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} role="alert" className="flex items-start gap-2 font-bold text-danger">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      ) : null}
    </div>
  );
}
