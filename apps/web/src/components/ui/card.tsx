import { cva, type VariantProps } from 'class-variance-authority';
import { clsx } from 'clsx';
import type { ComponentProps } from 'react';

// Departure recorded for review: DESIGN.md "Cards / Containers" (Shadow Strategy) and "Elevation & Depth" name a Resting
// Card shadow (0 8px 24px / .025) for ordinary cards, but app.css defines no token for it and DESIGN.md forbids new shadow
// recipes and says surfaces are flat by default (Flat-By-Default Rule). So a paper card stays flat with its hairline;
// only the Lifted Panel token (shadow-soft) exists, used for `elevated` and the ink hero card.
const cardVariants = cva('rounded-card border wrap-break-word', {
  variants: {
    variant: {
      paper: 'border-line bg-paper p-5.5 text-ink',
      // DESIGN.md Focus Ring: "use Notebook Page on Ink surfaces", so focus rings inside the ink card switch to paper.
      ink: 'border-ink bg-ink p-7 text-white shadow-soft focus-visible:outline-paper **:focus-visible:outline-paper',
    },
  },
  defaultVariants: { variant: 'paper' },
});

export type CardProps = ComponentProps<'div'> &
  VariantProps<typeof cardVariants> & {
    /** Adds the Lifted Panel shadow to a paper card; DESIGN.md reserves it for the one or two largest surfaces. */
    elevated?: boolean;
  };

export function Card({ variant, elevated = false, className, ...props }: CardProps) {
  return (
    <div
      {...props}
      data-variant={variant ?? 'paper'}
      className={clsx(cardVariants({ variant }), elevated && 'shadow-soft', className)}
    />
  );
}
