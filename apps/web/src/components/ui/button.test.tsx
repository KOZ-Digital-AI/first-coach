import { describe, expect, mock, test } from 'bun:test';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { Button } from './button';

const VARIANTS = ['primary', 'secondary', 'danger', 'ghost'] as const;

/*
 * Class assertions are anchored to DESIGN.md (Components > Buttons and the token
 * names in app.css), not to anything the component writes about itself.
 * `classList.contains` matches whole tokens, so `bg-ink/5` never satisfies `bg-ink`.
 */
function tokens(element: Element): string[] {
  return Array.from(element.classList);
}

// Dashed border colour that must stay visible on each variant's own fill when the button is inert.
const INERT_BORDER = {
  primary: 'border-white/70', // on the Ink fill; border-ink there would vanish
  secondary: 'border-muted', // on Notebook Page; Chalk Line is only 1.36:1
  danger: 'border-danger', // on the danger tint; a transparent border would show nothing
  ghost: 'border-muted', // on the page background; a transparent border would show nothing
} as const;

describe('Button element', () => {
  test('renders a real <button> reachable by the button role', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.disabled).toBe(false);
  });

  test('type defaults to "button" so it never submits a form by accident', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).type).toBe('button');
  });

  test('type can be overridden to submit and reset', () => {
    render(
      <>
        <Button type="submit">Send</Button>
        <Button type="reset">Clear</Button>
      </>,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).type).toBe('submit');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Clear' }).type).toBe('reset');
  });

  test('React 19 ref is a normal prop and points at the button', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Save</Button>);
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Save' }));
  });

  test('spreads native props onto the button and puts the caller className last', () => {
    render(
      <Button aria-label="Save drill" data-testid="save" name="intent" value="save" className="w-full">
        Save
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Save drill' });
    expect(button.getAttribute('data-testid')).toBe('save');
    expect(button.name).toBe('intent');
    expect(button.value).toBe('save');
    expect(button.classList.contains('w-full')).toBe(true);
    expect(button.className.endsWith('w-full')).toBe(true);
  });
});

describe('Button variants', () => {
  test('defaults to primary and reports its variant to consumers', () => {
    render(<Button>Default</Button>);
    const button = screen.getByRole('button', { name: 'Default' });
    expect(button.getAttribute('data-variant')).toBe('primary');
    expect(button.classList.contains('bg-ink')).toBe(true);
  });

  test.each(VARIANTS)('%s reports its variant to consumers', (variant) => {
    render(<Button variant={variant}>{variant}</Button>);
    expect(screen.getByRole('button', { name: variant }).getAttribute('data-variant')).toBe(variant);
  });

  test('the four variants produce four distinct class strings', () => {
    const classNames = new Set<string>();
    for (const variant of VARIANTS) {
      const { unmount } = render(<Button variant={variant}>{variant}</Button>);
      classNames.add(screen.getByRole('button', { name: variant }).className);
      unmount();
    }
    expect(classNames.size).toBe(4);
  });

  test('primary is the only filled dark control: Ink fill, white text, no accent fill, hover lift under motion-safe', () => {
    render(<Button variant="primary">Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.classList.contains('bg-ink')).toBe(true);
    expect(button.classList.contains('text-white')).toBe(true);
    expect(button.classList.contains('enabled:motion-safe:hover:-translate-y-px')).toBe(true);
    expect(button.className).not.toContain('accent');
  });

  test('a hover lift never runs outside motion-safe', () => {
    render(<Button>Save</Button>);
    expect(tokens(screen.getByRole('button', { name: 'Save' }))).not.toContain('hover:-translate-y-px');
    expect(tokens(screen.getByRole('button', { name: 'Save' }))).not.toContain('enabled:hover:-translate-y-px');
  });

  test('secondary is Notebook Page fill, Chalk Line border, Ink text', () => {
    render(<Button variant="secondary">Back</Button>);
    const button = screen.getByRole('button', { name: 'Back' });
    expect(button.classList.contains('bg-paper')).toBe(true);
    expect(button.classList.contains('border-line')).toBe(true);
    expect(button.classList.contains('text-ink')).toBe(true);
  });

  // DESIGN.md button-danger: Signal Red text on the pale red tint. That pair measures 4.28:1,
  // below AA for small text, but DESIGN.md is normative here; the follow-up is filed separately.
  test('danger is Signal Red text on the pale red tint', () => {
    render(<Button variant="danger">Delete</Button>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.classList.contains('text-danger')).toBe(true);
    expect(button.classList.contains('bg-danger-tint')).toBe(true);
  });

  test('ghost is transparent, hovers with an Ink wash and never uses the accent tint', () => {
    render(<Button variant="ghost">Skip</Button>);
    const button = screen.getByRole('button', { name: 'Skip' });
    expect(button.classList.contains('bg-transparent')).toBe(true);
    expect(button.classList.contains('text-ink')).toBe(true);
    expect(button.classList.contains('enabled:hover:bg-ink/5')).toBe(true);
    expect(button.className).not.toContain('accent');
  });
});

describe('Button sizing and focus', () => {
  test.each(VARIANTS)('%s meets the 44px tap target and uses the control radius', (variant) => {
    render(<Button variant={variant}>{variant}</Button>);
    const button = screen.getByRole('button', { name: variant });
    expect(button.classList.contains('min-h-tap')).toBe(true);
    expect(button.classList.contains('min-w-tap')).toBe(true);
    expect(button.classList.contains('rounded-control')).toBe(true);
    expect(button.classList.contains('font-bold')).toBe(true);
    expect(button.classList.contains('px-4.5')).toBe(true);
  });

  test('has no fixed height or width, so a long label can grow the button instead of overflowing it', () => {
    render(<Button>Save</Button>);
    const fixed = tokens(screen.getByRole('button', { name: 'Save' })).filter((token) =>
      /^(h|w|max-h)-/.test(token),
    );
    expect(fixed).toEqual([]);
  });

  test('a long Kazakh or Russian label wraps: it stays the accessible name and the button may break words', () => {
    const kazakh = 'Жаттығуды аяқтап, нәтижені сақтап, келесі қадамға өту';
    const russian = 'Сохранить результат тренировки и перейти к следующему шагу';
    render(
      <>
        <Button>{kazakh}</Button>
        <Button variant="secondary">{russian}</Button>
      </>,
    );
    for (const name of [kazakh, russian]) {
      const button = screen.getByRole('button', { name });
      expect(button.classList.contains('wrap-anywhere')).toBe(true);
      expect(button.classList.contains('max-w-full')).toBe(true);
      expect(button.classList.contains('text-center')).toBe(true);
      // never forced onto one line
      expect(tokens(button)).not.toContain('whitespace-nowrap');
      expect(tokens(button)).not.toContain('truncate');
    }
  });

  test('inherits the global focus ring: no outline, ring or focus utilities of its own', () => {
    for (const variant of VARIANTS) {
      const { unmount } = render(<Button variant={variant}>{variant}</Button>);
      const own = tokens(screen.getByRole('button', { name: variant })).filter((token) =>
        /outline|ring|focus/.test(token),
      );
      expect(own).toEqual([]);
      unmount();
    }
  });
});

describe('Button disabled', () => {
  test('native disabled: the button is disabled, not busy, and never calls onClick', async () => {
    const onClick = mock();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    expect(button.disabled).toBe(true);
    expect(button.hasAttribute('aria-busy')).toBe(false);
    await userEvent.setup().click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test('an enabled button does call onClick, once per click', async () => {
    const onClick = mock();
    render(<Button onClick={onClick}>Save</Button>);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test.each(VARIANTS)('%s: disabled is visibly distinct by more than colour (dim, dashed, not-allowed)', (variant) => {
    render(
      <Button variant={variant} disabled>
        {variant}
      </Button>,
    );
    const button = screen.getByRole('button', { name: variant });
    expect(button.classList.contains('opacity-50')).toBe(true);
    expect(button.classList.contains('cursor-not-allowed')).toBe(true);
    expect(button.classList.contains('border-dashed')).toBe(true);
    expect(button.classList.contains('cursor-pointer')).toBe(false);
  });

  test.each(VARIANTS)('%s: the dashed border colour is visible on that variant fill', (variant) => {
    render(
      <Button variant={variant} disabled>
        {variant}
      </Button>,
    );
    const own = tokens(screen.getByRole('button', { name: variant }));
    expect(own).toContain(INERT_BORDER[variant]);
    // a dashed border the same colour as the fill, or no colour at all, shows nothing
    expect(own).not.toContain('border-transparent');
    if (variant === 'primary') expect(own).not.toContain('border-ink');
    // and exactly one border colour, so the browser is never left to pick between two
    expect(own.filter((token) => /^border-(?!dashed|solid|t-|b-|l-|r-|x-|y-|s-|e-)/.test(token))).toEqual([
      INERT_BORDER[variant],
    ]);
  });

  test.each(VARIANTS)('%s: an enabled button carries none of the disabled treatment', (variant) => {
    render(<Button variant={variant}>{variant}</Button>);
    const button = screen.getByRole('button', { name: variant });
    expect(button.classList.contains('opacity-50')).toBe(false);
    expect(button.classList.contains('cursor-not-allowed')).toBe(false);
    expect(button.classList.contains('border-dashed')).toBe(false);
    expect(button.classList.contains(INERT_BORDER[variant])).toBe(false);
    expect(button.classList.contains('cursor-pointer')).toBe(true);
  });
});

describe('Button loading', () => {
  test('loading: natively disabled, aria-busy, and never calls onClick', async () => {
    const onClick = mock();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Saving' });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await userEvent.setup().click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test('loading shows a spinner BESIDE its text: state is not colour alone', () => {
    render(<Button loading>Saving</Button>);
    const button = screen.getByRole('button', { name: 'Saving' });
    const spinner = button.querySelector('[data-slot="spinner"]');
    expect(spinner).not.toBeNull();
    // decorative: hidden from assistive tech so it neither renames the button nor is announced
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    expect(spinner?.hasAttribute('aria-label')).toBe(false);
    // the icon is a direct child next to the label, and the label is still rendered
    expect(spinner?.parentElement).toBe(button);
    expect(button.textContent).toContain('Saving');
  });

  test('the spinner only spins under motion-safe', () => {
    render(<Button loading>Saving</Button>);
    const spinner = screen.getByRole('button', { name: 'Saving' }).querySelector('[data-slot="spinner"]');
    expect(spinner).not.toBeNull();
    expect(spinner?.classList.contains('motion-safe:animate-spin')).toBe(true);
    expect(spinner?.classList.contains('animate-spin')).toBe(false);
  });

  test.each(VARIANTS)('%s: loading gets the same non-colour inert treatment as disabled', (variant) => {
    render(
      <Button variant={variant} loading>
        {variant}
      </Button>,
    );
    const own = tokens(screen.getByRole('button', { name: variant }));
    expect(own).toContain('opacity-50');
    expect(own).toContain('cursor-not-allowed');
    expect(own).toContain('border-dashed');
    expect(own).toContain(INERT_BORDER[variant]);
  });

  test('not loading: no spinner and no aria-busy', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  test('loading={false} is the same as not loading', () => {
    render(<Button loading={false}>Save</Button>);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });

  test('a caller aria-busy is respected while not loading', () => {
    render(<Button aria-busy="true">Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('aria-busy')).toBe('true');
  });

  test('loading wins over a caller aria-busy={false}', () => {
    render(
      <Button loading aria-busy={false}>
        Saving
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Saving' }).getAttribute('aria-busy')).toBe('true');
  });

  test('loading stays disabled even if the caller passes disabled={false}', () => {
    render(
      <Button loading disabled={false}>
        Saving
      </Button>,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Saving' }).disabled).toBe(true);
  });

  test('a submit button does not submit its form while loading, and does when idle', async () => {
    const onSubmit = mock((event: { preventDefault: () => void }) => event.preventDefault());
    const user = userEvent.setup();
    const { rerender } = render(
      <form onSubmit={onSubmit}>
        <Button type="submit">Send</Button>
      </form>,
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading>
          Send
        </Button>
      </form>,
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
