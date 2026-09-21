import { describe, expect, test } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { Card } from './card';
import { Tag } from './tag';

const tones = ['neutral', 'accent', 'warning', 'danger'] as const;

const classesOf = (element: HTMLElement) => element.className.split(/\s+/).filter(Boolean);

describe('Card', () => {
  test('renders its children', () => {
    render(
      <Card>
        <h2>Today</h2>
        <p>Five minutes of passing</p>
      </Card>,
    );
    expect(screen.getByRole('heading', { name: 'Today' })).toBeTruthy();
    expect(screen.getByText('Five minutes of passing')).toBeTruthy();
  });

  test('is a paper surface by default: paper fill, chalk-line border, 18px card radius, ink text', () => {
    render(<Card data-testid="card">x</Card>);
    const card = screen.getByTestId('card');
    expect(card.getAttribute('data-variant')).toBe('paper');
    const classes = classesOf(card);
    expect(classes).toContain('bg-paper');
    expect(classes).toContain('border');
    expect(classes).toContain('border-line');
    expect(classes).toContain('rounded-card');
    expect(classes).toContain('text-ink');
    expect(classes).not.toContain('bg-ink');
  });

  test('is flat at rest: an ordinary card carries no lifted shadow', () => {
    render(<Card data-testid="card">x</Card>);
    expect(classesOf(screen.getByTestId('card'))).not.toContain('shadow-soft');
  });

  test('the ink hero variant inverts to ink fill with white text and keeps the card radius', () => {
    render(
      <Card variant="ink" data-testid="hero">
        x
      </Card>,
    );
    const hero = screen.getByTestId('hero');
    expect(hero.getAttribute('data-variant')).toBe('ink');
    const classes = classesOf(hero);
    expect(classes).toContain('bg-ink');
    expect(classes).toContain('text-white');
    expect(classes).toContain('rounded-card');
    expect(classes).not.toContain('bg-paper');
    expect(classes).not.toContain('text-ink');
  });

  test('paper and ink produce distinct class strings', () => {
    render(
      <>
        <Card data-testid="paper">x</Card>
        <Card variant="ink" data-testid="ink">
          x
        </Card>
      </>,
    );
    expect(screen.getByTestId('paper').className).not.toBe(screen.getByTestId('ink').className);
  });

  test('the ink card carries the lifted shadow', () => {
    render(
      <Card variant="ink" data-testid="hero">
        x
      </Card>,
    );
    expect(classesOf(screen.getByTestId('hero'))).toContain('shadow-soft');
  });

  test('elevated lifts a paper card with the same shadow', () => {
    render(
      <Card elevated data-testid="panel">
        x
      </Card>,
    );
    expect(classesOf(screen.getByTestId('panel'))).toContain('shadow-soft');
  });

  test('focus rings inside the ink card switch to paper so they stay visible on dark', () => {
    render(
      <Card variant="ink" data-testid="hero">
        <a href="/drill">Start</a>
      </Card>,
    );
    expect(classesOf(screen.getByTestId('hero'))).toContain('**:focus-visible:outline-paper');
    expect(classesOf(screen.getByTestId('hero'))).toContain('focus-visible:outline-paper');
  });

  test('a paper card leaves the global focus ring alone', () => {
    render(
      <Card data-testid="card">
        <a href="/drill">Start</a>
      </Card>,
    );
    expect(screen.getByTestId('card').className).not.toContain('outline');
  });

  test('long unbroken words wrap instead of overflowing at 360px', () => {
    render(<Card data-testid="card">Жаттығуларыңызды</Card>);
    expect(classesOf(screen.getByTestId('card'))).toContain('wrap-break-word');
  });

  test('className passthrough lands last and extra props reach the element', () => {
    render(
      <Card role="region" aria-label="Summary" data-testid="card" className="mt-4">
        x
      </Card>,
    );
    const card = screen.getByRole('region', { name: 'Summary' });
    expect(card).toBe(screen.getByTestId('card'));
    expect(classesOf(card)).toContain('mt-4');
    expect(classesOf(card).at(-1)).toBe('mt-4');
    expect(classesOf(card)).toContain('bg-paper');
  });

  test('accepts ref as a plain prop', () => {
    let node: HTMLDivElement | null = null;
    render(
      <Card
        ref={(element) => {
          node = element;
        }}
      >
        x
      </Card>,
    );
    expect(node).toBeInstanceOf(HTMLDivElement);
  });
});

describe('Tag', () => {
  for (const tone of tones) {
    test(`renders its label for the ${tone} tone`, () => {
      render(<Tag tone={tone}>{`label-${tone}`}</Tag>);
      const tag = screen.getByText(`label-${tone}`);
      expect(tag.textContent).toContain(`label-${tone}`);
      expect(tag.getAttribute('data-tone')).toBe(tone);
    });
  }

  test('every tone is a pill with a 12px bold label', () => {
    for (const tone of tones) {
      render(
        <Tag tone={tone} data-testid={tone}>
          x
        </Tag>,
      );
      const classes = classesOf(screen.getByTestId(tone));
      expect(classes).toContain('rounded-pill');
      expect(classes).toContain('text-xs');
      expect(classes).toContain('font-bold');
    }
  });

  test('the four tones produce four distinct class strings', () => {
    for (const tone of tones) {
      render(
        <Tag tone={tone} data-testid={tone}>
          x
        </Tag>,
      );
    }
    const strings = tones.map((tone) => screen.getByTestId(tone).className);
    expect(new Set(strings).size).toBe(4);
  });

  test('defaults to the neutral tone', () => {
    render(
      <>
        <Tag data-testid="default">8+</Tag>
        <Tag tone="neutral" data-testid="neutral">
          8+
        </Tag>
      </>,
    );
    expect(screen.getByTestId('default').getAttribute('data-tone')).toBe('neutral');
    expect(screen.getByTestId('default').className).toBe(screen.getByTestId('neutral').className);
  });

  test('neutral is a hairline chip on the page background with ink text', () => {
    render(<Tag data-testid="tag">x</Tag>);
    const classes = classesOf(screen.getByTestId('tag'));
    expect(classes).toContain('border-line');
    expect(classes).toContain('bg-bg');
    expect(classes).toContain('text-ink');
  });

  test('accent is ink text on Morning Mint, never green text on mint (4.28:1)', () => {
    render(
      <Tag tone="accent" data-testid="tag">
        x
      </Tag>,
    );
    const classes = classesOf(screen.getByTestId('tag'));
    expect(classes).toContain('bg-accent-2');
    expect(classes).toContain('text-ink');
    expect(classes).not.toContain('text-accent');
  });

  test('warning is amber text with an amber border on paper', () => {
    render(
      <Tag tone="warning" data-testid="tag">
        x
      </Tag>,
    );
    const classes = classesOf(screen.getByTestId('tag'));
    expect(classes).toContain('text-warning');
    expect(classes).toContain('border-warning');
    expect(classes).toContain('bg-paper');
  });

  test('danger is Signal Red text on the danger tint', () => {
    render(
      <Tag tone="danger" data-testid="tag">
        x
      </Tag>,
    );
    const classes = classesOf(screen.getByTestId('tag'));
    expect(classes).toContain('text-danger');
    expect(classes).toContain('bg-danger-tint');
  });

  test('a long Kazakh label wraps inside the pill instead of overflowing', () => {
    render(<Tag data-testid="tag">Мамандар тексерген жаттығу</Tag>);
    const classes = classesOf(screen.getByTestId('tag'));
    expect(classes).toContain('max-w-full');
    expect(classes).toContain('wrap-anywhere');
  });

  test('is a plain non-interactive span', () => {
    render(<Tag>8+</Tag>);
    expect(screen.getByText('8+').tagName).toBe('SPAN');
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('className passthrough lands last and extra props reach the element', () => {
    render(
      <Tag tone="danger" aria-label="Status" data-testid="tag" className="ml-2">
        beta
      </Tag>,
    );
    const tag = screen.getByTestId('tag');
    expect(tag.getAttribute('aria-label')).toBe('Status');
    expect(classesOf(tag).at(-1)).toBe('ml-2');
    expect(classesOf(tag)).toContain('text-danger');
  });

  test('accepts ref as a plain prop', () => {
    let node: HTMLSpanElement | null = null;
    render(
      <Tag
        ref={(element) => {
          node = element;
        }}
      >
        x
      </Tag>,
    );
    expect(node).toBeInstanceOf(HTMLSpanElement);
  });
});
