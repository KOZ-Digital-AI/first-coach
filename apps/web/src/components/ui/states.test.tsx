import { describe, expect, mock, test } from 'bun:test';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { EmptyState } from './empty-state';
import { ErrorState } from './error-state';

/*
 * Class assertions are anchored to DESIGN.md (Components > Empty and Notice Blocks, Shapes,
 * Colors > Semantic) and the token names in app.css, not to anything the component writes about
 * itself. `classList.contains` matches whole tokens. Copy is Kazakh on purpose: nothing in a
 * primitive may fall back to an English string.
 */
const tokens = (element: Element): string[] => Array.from(element.classList);

const EMPTY = { title: 'Жаттығулар әзірге жоқ', hint: 'Бастау үшін дағдыны таңдаңыз' };
const ERROR = { title: 'Жүктеу мүмкін болмады', message: 'Байланысты тексеріп, қайта көріңіз', retryLabel: 'Қайталап көру' };

describe('EmptyState', () => {
  test('renders the title and the hint', () => {
    render(<EmptyState {...EMPTY} />);
    expect(screen.getByText(EMPTY.title)).toBeTruthy();
    expect(screen.getByText(EMPTY.hint)).toBeTruthy();
  });

  test('the title is a plain paragraph, not a heading: the caller owns heading levels', () => {
    render(<EmptyState {...EMPTY} />);
    expect(screen.queryByRole('heading')).toBeNull();
    const title = screen.getByText(EMPTY.title);
    expect(title.tagName).toBe('P');
    expect(tokens(title)).toContain('font-bold');
  });

  test('the hint is a separate muted paragraph at the 16px body floor', () => {
    render(<EmptyState {...EMPTY} />);
    const hint = screen.getByText(EMPTY.hint);
    expect(hint.tagName).toBe('P');
    expect(hint).not.toBe(screen.getByText(EMPTY.title));
    expect(tokens(hint)).toContain('text-muted');
    expect(tokens(hint)).toContain('text-base');
  });

  test('renders the action slot and puts it after the hint', () => {
    render(<EmptyState {...EMPTY} action={<button type="button">Дағды таңдау</button>} />);
    const action = screen.getByRole('button', { name: 'Дағды таңдау' });
    const hint = screen.getByText(EMPTY.hint);
    expect(Boolean(hint.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  test('the action slot accepts any node, not only a button', () => {
    render(<EmptyState {...EMPTY} action={<a href="/skills">Барлық дағдылар</a>} />);
    expect(screen.getByRole('link', { name: 'Барлық дағдылар' })).toBeTruthy();
  });

  test('without an action there is no control and no empty wrapper', () => {
    render(<EmptyState {...EMPTY} data-testid="empty" />);
    const root = screen.getByTestId('empty');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    // every element in the block carries text: an empty action wrapper would fail here
    const descendants = Array.from(root.querySelectorAll('*'));
    expect(descendants.length).toBeGreaterThan(0);
    expect(descendants.every((element) => (element.textContent ?? '').trim() !== '')).toBe(true);
  });

  test('uses the DESIGN.md empty block: dashed Chalk Line border, 18px card radius', () => {
    render(<EmptyState {...EMPTY} data-testid="empty" />);
    const root = screen.getByTestId('empty');
    expect(tokens(root)).toContain('border-dashed');
    expect(tokens(root)).toContain('border-line');
    expect(tokens(root)).toContain('rounded-card');
  });

  test('long unbroken Kazakh text is allowed to break instead of overflowing 360px', () => {
    render(<EmptyState title="Қазақстандықтардың" hint="Қалалық-жаттығулар-тізімі" data-testid="empty" />);
    expect(tokens(screen.getByTestId('empty'))).toContain('wrap-anywhere');
  });

  test('passes extra props through and puts the caller className last', () => {
    render(<EmptyState {...EMPTY} data-testid="empty" id="drills-empty" className="mt-6" />);
    const root = screen.getByTestId('empty');
    expect(root.id).toBe('drills-empty');
    expect(tokens(root)).toContain('rounded-card');
    expect(tokens(root).at(-1)).toBe('mt-6');
  });

  test('forwards a React 19 ref prop to the root element', () => {
    const ref = createRef<HTMLDivElement>();
    render(<EmptyState {...EMPTY} ref={ref} data-testid="empty" />);
    expect(ref.current).toBe(screen.getByTestId<HTMLDivElement>('empty'));
  });
});

describe('ErrorState', () => {
  test('is an alert that contains the title and the message', () => {
    render(<ErrorState {...ERROR} onRetry={() => {}} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(ERROR.title)).toBeTruthy();
    expect(within(alert).getByText(ERROR.message)).toBeTruthy();
  });

  test('the title is a plain paragraph, not a heading', () => {
    render(<ErrorState {...ERROR} onRetry={() => {}} />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText(ERROR.title).tagName).toBe('P');
  });

  test('the Retry button lives inside the alert and is named by retryLabel verbatim', () => {
    render(<ErrorState {...ERROR} onRetry={() => {}} />);
    const alert = screen.getByRole('alert');
    const retry = within(alert).getByRole<HTMLButtonElement>('button', { name: ERROR.retryLabel });
    expect(retry.tagName).toBe('BUTTON');
    expect(retry.type).toBe('button');
  });

  test('holds no English copy of its own: with Kazakh props no Retry/Try again text appears', () => {
    render(<ErrorState {...ERROR} onRetry={() => {}} />);
    expect(screen.queryByText(/retry|try again|error|reload/i)).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  test('clicking Retry calls onRetry exactly once', async () => {
    const onRetry = mock();
    render(<ErrorState {...ERROR} onRetry={onRetry} />);
    await userEvent.setup().click(screen.getByRole('button', { name: ERROR.retryLabel }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('when not retrying the button is enabled and not busy', () => {
    render(<ErrorState {...ERROR} onRetry={() => {}} />);
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: ERROR.retryLabel });
    expect(retry.disabled).toBe(false);
    expect(retry.getAttribute('aria-busy')).toBeNull();
  });

  test('while retrying the button is disabled and busy but keeps its visible label', () => {
    render(<ErrorState {...ERROR} retrying onRetry={() => {}} />);
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: ERROR.retryLabel });
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(within(retry).getByText(ERROR.retryLabel)).toBeTruthy();
  });

  test('while retrying, clicking does not call onRetry', async () => {
    const onRetry = mock();
    render(<ErrorState {...ERROR} retrying onRetry={onRetry} />);
    await userEvent.setup().click(screen.getByRole('button', { name: ERROR.retryLabel }));
    expect(onRetry).not.toHaveBeenCalled();
  });

  test('leaving the retrying state re-enables the button so a second attempt is possible', async () => {
    const onRetry = mock();
    const view = render(<ErrorState {...ERROR} retrying onRetry={onRetry} />);
    view.rerender(<ErrorState {...ERROR} retrying={false} onRetry={onRetry} />);
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: ERROR.retryLabel });
    expect(retry.disabled).toBe(false);
    await userEvent.setup().click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('state is not by colour alone: a decorative icon sits inside the alert beside the words', () => {
    render(<ErrorState {...ERROR} onRetry={() => {}} />);
    const alert = screen.getByRole('alert');
    const icons = Array.from(alert.querySelectorAll('svg'));
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(within(alert).getByText(ERROR.title)).toBeTruthy();
  });

  test('uses Signal Red border and the 18px card radius from DESIGN.md', () => {
    render(<ErrorState {...ERROR} onRetry={() => {}} />);
    const alert = screen.getByRole('alert');
    expect(tokens(alert)).toContain('border-danger');
    expect(tokens(alert)).toContain('bg-paper');
    expect(tokens(alert)).toContain('rounded-card');
  });

  test('long unbroken Kazakh text is allowed to break instead of overflowing 360px', () => {
    render(<ErrorState {...ERROR} title="Қазақстандықтардың" message="Қалалық-жаттығулар-тізімі" onRetry={() => {}} />);
    expect(tokens(screen.getByRole('alert'))).toContain('wrap-anywhere');
  });

  test('passes extra props through and puts the caller className last', () => {
    render(<ErrorState {...ERROR} onRetry={() => {}} id="load-error" className="mt-6" />);
    const alert = screen.getByRole('alert');
    expect(alert.id).toBe('load-error');
    expect(tokens(alert)).toContain('rounded-card');
    expect(tokens(alert).at(-1)).toBe('mt-6');
  });

  test('forwards a React 19 ref prop to the alert element', () => {
    const ref = createRef<HTMLDivElement>();
    render(<ErrorState {...ERROR} ref={ref} onRetry={() => {}} />);
    expect(ref.current).toBe(screen.getByRole<HTMLDivElement>('alert'));
  });
});
