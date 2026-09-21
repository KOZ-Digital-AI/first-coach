import { describe, expect, test } from 'bun:test';
import { render, screen, within } from '@testing-library/react';
import { Notice } from './notice';
import { Skeleton } from './skeleton';

const classesOf = (element: Element) => element.getAttribute('class')?.split(/\s+/).filter(Boolean) ?? [];

describe('Notice', () => {
  test('info is a status region carrying its message, and is not an alert', () => {
    render(<Notice>Saved on this phone</Notice>);
    const notice = screen.getByRole('status');
    expect(within(notice).getByText('Saved on this phone')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('warn is an alert carrying its message, and is not a status', () => {
    render(<Notice tone="warn">Video scoring is off</Notice>);
    const notice = screen.getByRole('alert');
    expect(within(notice).getByText('Video scoring is off')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('tone defaults to info and an explicit info behaves the same', () => {
    render(
      <>
        <Notice data-testid="default">One</Notice>
        <Notice tone="info" data-testid="explicit">
          Two
        </Notice>
      </>,
    );
    expect(screen.getByTestId('default').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('explicit').getAttribute('role')).toBe('status');
    expect(screen.getByTestId('default').getAttribute('data-tone')).toBe('info');
    expect(screen.getByTestId('explicit').getAttribute('data-tone')).toBe('info');
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  test('info carries the Info icon beside the text, hidden from assistive tech', () => {
    render(<Notice>Saved on this phone</Notice>);
    const icon = within(screen.getByRole('status')).getByText('Saved on this phone').parentElement?.querySelector('svg');
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.getAttribute('class')).toContain('lucide-info');
    expect(icon?.getAttribute('class')).not.toContain('lucide-triangle-alert');
  });

  test('warn carries the TriangleAlert icon beside the text, hidden from assistive tech', () => {
    render(<Notice tone="warn">Video scoring is off</Notice>);
    const icon = within(screen.getByRole('alert')).getByText('Video scoring is off').parentElement?.querySelector('svg');
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.getAttribute('class')).toContain('lucide-triangle-alert');
    expect(icon?.getAttribute('class')).not.toContain('lucide-info');
  });

  test('the icon does not shrink or grow with the text, so long labels wrap beside it', () => {
    render(<Notice>Saved</Notice>);
    const icon = screen.getByRole('status').querySelector('svg');
    const classes = classesOf(icon as Element);
    expect(classes).toContain('shrink-0');
    expect(classes).toContain('size-5');
  });

  test('info uses the Morning Mint tint with Ink text at the 16px body floor and the 12px control radius', () => {
    render(<Notice>Saved</Notice>);
    const classes = classesOf(screen.getByRole('status'));
    expect(classes).toContain('bg-accent-2');
    expect(classes).toContain('text-ink');
    expect(classes).toContain('text-base');
    expect(classes).toContain('rounded-control');
    expect(classes).not.toContain('bg-warning/10');
    expect(classes).not.toContain('border-warning');
  });

  test('warn uses the Amber Notice tint and border with Ink text at 16px and the 12px control radius', () => {
    render(<Notice tone="warn">Careful</Notice>);
    const classes = classesOf(screen.getByRole('alert'));
    expect(classes).toContain('bg-warning/10');
    expect(classes).toContain('border-warning');
    expect(classes).toContain('text-ink');
    expect(classes).toContain('text-base');
    expect(classes).toContain('rounded-control');
    expect(classes).not.toContain('bg-accent-2');
  });

  test('the icon colour follows the tone: amber for warn, ink for info (never green on the mint tint)', () => {
    render(
      <>
        <Notice data-testid="info">Saved</Notice>
        <Notice tone="warn" data-testid="warn">
          Careful
        </Notice>
      </>,
    );
    const infoIcon = screen.getByTestId('info').querySelector('svg') as Element;
    const warnIcon = screen.getByTestId('warn').querySelector('svg') as Element;
    expect(classesOf(warnIcon)).toContain('text-warning');
    expect(classesOf(infoIcon)).not.toContain('text-warning');
    expect(classesOf(infoIcon)).not.toContain('text-accent');
  });

  test('a long unbroken Kazakh or Russian label wraps inside the notice instead of overflowing', () => {
    const long = 'Бейнежазбаны автоматтандырылған бағалау уақытша өшірілгенін ескертеміз';
    render(<Notice tone="warn">{long}</Notice>);
    const message = within(screen.getByRole('alert')).getByText(long);
    const classes = classesOf(message);
    expect(classes).toContain('min-w-0');
    expect(classes).toContain('wrap-anywhere');
    expect(classesOf(screen.getByRole('alert'))).toContain('items-start');
  });

  test('renders rich children such as a heading and a paragraph', () => {
    render(
      <Notice tone="warn">
        <strong>Beta</strong>
        <p>Scores may change</p>
      </Notice>,
    );
    const notice = screen.getByRole('alert');
    expect(within(notice).getByText('Beta')).toBeTruthy();
    expect(within(notice).getByText('Scores may change')).toBeTruthy();
  });

  test('a caller className is applied last and extra props reach the element', () => {
    render(
      <Notice tone="warn" className="mt-4 max-w-sm" data-testid="notice" aria-live="polite" id="n1">
        Careful
      </Notice>,
    );
    const notice = screen.getByTestId('notice');
    expect(notice.getAttribute('class')?.endsWith('mt-4 max-w-sm')).toBe(true);
    expect(classesOf(notice)).toContain('bg-warning/10');
    expect(notice.getAttribute('aria-live')).toBe('polite');
    expect(notice.id).toBe('n1');
    expect(notice.getAttribute('role')).toBe('alert');
  });

  test('a caller may pass an explicit role, which replaces the tone default', () => {
    render(
      <Notice tone="warn" role="log">
        Scores updated
      </Notice>,
    );
    expect(screen.getByRole('log')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Skeleton', () => {
  test('is hidden from assistive tech and exposes no role or text', () => {
    const { container } = render(<Skeleton />);
    const block = container.firstElementChild as HTMLElement;
    expect(block.getAttribute('aria-hidden')).toBe('true');
    expect(block.hasAttribute('role')).toBe(false);
    expect(block.textContent).toBe('');
    // Hidden from the accessibility tree: found only when hidden elements are explicitly included.
    expect(within(container).queryAllByRole('generic')).toHaveLength(0);
    expect(within(container).queryAllByRole('generic', { hidden: true })).toHaveLength(1);
  });

  test('accepts size classes from the caller and sets no intrinsic size of its own', () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    const classes = classesOf(container.firstElementChild as Element);
    expect(classes).toContain('h-4');
    expect(classes).toContain('w-24');
    for (const own of classes.filter((name) => name !== 'h-4' && name !== 'w-24')) {
      expect(own).not.toMatch(/^(h|w|size|min-h|min-w)-/);
    }
  });

  test('pulses, and stops pulsing under reduced motion', () => {
    const { container } = render(<Skeleton />);
    const classes = classesOf(container.firstElementChild as Element);
    expect(classes).toContain('animate-pulse');
    expect(classes).toContain('motion-reduce:animate-none');
  });

  test('is a neutral Chalk Line block with the 12px control radius that cannot outgrow a 360px column', () => {
    const { container } = render(<Skeleton />);
    const classes = classesOf(container.firstElementChild as Element);
    expect(classes).toContain('bg-line');
    expect(classes).toContain('rounded-control');
    expect(classes).toContain('max-w-full');
  });

  test('a caller className is applied last and extra props reach the element', () => {
    render(<Skeleton className="h-6 w-1/2" data-testid="skeleton" />);
    const block = screen.getByTestId('skeleton');
    expect(block.getAttribute('class')?.endsWith('h-6 w-1/2')).toBe(true);
    expect(block.getAttribute('aria-hidden')).toBe('true');
  });
});
