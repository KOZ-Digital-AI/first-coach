import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import { LoaderCircle } from 'lucide-react';
import type { ComponentProps } from 'react';

/*
 * Colours, radius and weight follow DESIGN.md (Components > Buttons), not the
 * illustrative names in the bead. No outline/ring utilities on purpose: the global
 * :focus-visible ring in app.css is inherited. Height is a floor (min-h-tap), never
 * fixed, and words may break, so a long Kazakh or Russian label wraps at 360px.
 *
 * Inert (disabled or loading) is shown by dimming, a dashed border and a not-allowed
 * cursor, never by colour alone. Each variant gets its own dashed border colour because
 * one that matches the fill (or is transparent) would show nothing. Only one border
 * colour is ever emitted per state, so the browser never has to choose between two.
 */
const buttonVariants = cva(
  'inline-flex min-h-tap min-w-tap max-w-full items-center justify-center gap-2 rounded-control border px-4.5 py-2.5 text-center font-bold wrap-anywhere motion-safe:transition-transform',
  {
    variants: {
      variant: {
        // The only filled dark control; lifts 1px on hover, and only when motion is allowed.
        primary: 'bg-ink text-white enabled:motion-safe:hover:-translate-y-px',
        secondary: 'bg-paper text-ink',
        // DESIGN.md button-danger: Signal Red on the pale red tint. This pair measures 4.28:1,
        // below AA for small text; kept as specified, follow-up filed separately.
        danger: 'bg-danger-tint text-danger',
        // Ink wash on hover: accent-2 means "chosen", not "hovered".
        ghost: 'bg-transparent text-ink enabled:hover:bg-ink/5',
      },
      inert: {
        true: 'cursor-not-allowed border-dashed opacity-50',
        false: 'cursor-pointer',
      },
    },
    compoundVariants: [
      { variant: 'primary', inert: false, class: 'border-ink' },
      { variant: 'primary', inert: true, class: 'border-white/70' },
      { variant: 'secondary', inert: false, class: 'border-line' },
      { variant: 'secondary', inert: true, class: 'border-muted' },
      { variant: 'danger', inert: false, class: 'border-transparent' },
      { variant: 'danger', inert: true, class: 'border-danger' },
      { variant: 'ghost', inert: false, class: 'border-transparent' },
      { variant: 'ghost', inert: true, class: 'border-muted' },
    ],
    defaultVariants: { variant: 'primary', inert: false },
  },
);

export type ButtonProps = ComponentProps<'button'> & {
  /** Visual role. Defaults to `primary`. */
  variant?: NonNullable<VariantProps<typeof buttonVariants>['variant']>;
  /**
   * Disables the button, sets `aria-busy` and shows a spinner beside the (still visible) children.
   * Native `disabled` on a focused button can drop keyboard focus, so a caller that sets `loading`
   * from a click or submit owns restoring focus once the work finishes.
   */
  loading?: boolean;
};

export function Button({
  variant = 'primary',
  loading = false,
  disabled = false,
  type = 'button',
  className,
  children,
  'aria-busy': ariaBusy,
  ...props
}: ButtonProps) {
  const inert = disabled || loading;
  return (
    <button
      {...props}
      type={type}
      disabled={inert}
      aria-busy={loading ? true : ariaBusy}
      data-variant={variant}
      className={clsx(buttonVariants({ variant, inert }), className)}
    >
      {loading ? (
        <LoaderCircle aria-hidden="true" data-slot="spinner" className="size-5 shrink-0 motion-safe:animate-spin" />
      ) : null}
      {children}
    </button>
  );
}
