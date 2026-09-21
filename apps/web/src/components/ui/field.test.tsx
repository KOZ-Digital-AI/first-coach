import { describe, expect, test } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { Field } from './field';

function idsOf(control: HTMLElement): string[] {
  return (control.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
}

describe('Field label', () => {
  test('is associated with the control through htmlFor/id', () => {
    render(<Field label="Name">{(control) => <input {...control} />}</Field>);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    expect(screen.getByLabelText('Name')).toBe(input);
    const label = screen.getByText('Name');
    expect(label.tagName).toBe('LABEL');
    expect(label.getAttribute('for')).toBe(input.id);
    expect(input.id).not.toBe('');
  });

  test('also labels a textarea, since the control is chosen by the caller', () => {
    render(<Field label="Notes">{(control) => <textarea {...control} />}</Field>);
    expect(screen.getByRole('textbox', { name: 'Notes' }).tagName).toBe('TEXTAREA');
  });

  test('is 13px bold per DESIGN.md Inputs and wraps long Kazakh/Russian text', () => {
    render(<Field label="Жаттығудың толық атауын енгізіңіз">{(control) => <input {...control} />}</Field>);
    const label = screen.getByText('Жаттығудың толық атауын енгізіңіз');
    expect(label.classList.contains('text-[13px]')).toBe(true);
    expect(label.classList.contains('font-bold')).toBe(true);
    expect(label.classList.contains('text-ink')).toBe(true);
    expect(label.classList.contains('break-words')).toBe(true);
  });
});

describe('Field hint', () => {
  test('is rendered and linked to the control with aria-describedby', () => {
    render(
      <Field label="Age" hint="Between 6 and 60">
        {(control) => <input {...control} />}
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Age' });
    const hint = screen.getByText('Between 6 and 60');
    expect(idsOf(input)).toEqual([hint.id]);
    expect(document.getElementById(hint.id)).toBe(hint);
    expect(screen.getByRole('textbox', { description: 'Between 6 and 60' })).toBe(input);
  });

  test('is muted helper text and does not mark the control invalid', () => {
    render(
      <Field label="Age" hint="Between 6 and 60">
        {(control) => <input {...control} />}
      </Field>,
    );
    const hint = screen.getByText('Between 6 and 60');
    expect(hint.classList.contains('text-muted')).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Age' }).hasAttribute('aria-invalid')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Field error', () => {
  test('is announced with role="alert" and is text, not colour alone', () => {
    render(
      <Field label="Email" error="Enter a valid email">
        {(control) => <input {...control} />}
      </Field>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Enter a valid email');
    expect(alert.classList.contains('text-danger')).toBe(true);
  });

  test('has a decorative icon before the text, explicitly hidden from assistive tech', () => {
    render(
      <Field label="Email" error="Enter a valid email">
        {(control) => <input {...control} />}
      </Field>,
    );
    const alert = screen.getByRole('alert');
    const icon = alert.querySelector('svg');
    const text = screen.getByText('Enter a valid email');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    // DOCUMENT_POSITION_FOLLOWING (4): the text node's element follows the icon.
    expect((icon as SVGElement).compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('sets aria-invalid on the control and links it with aria-describedby', () => {
    render(
      <Field label="Email" error="Enter a valid email">
        {(control) => <input {...control} />}
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Email' });
    const alert = screen.getByRole('alert');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(idsOf(input)).toEqual([alert.id]);
    expect(document.getElementById(alert.id)).toBe(alert);
    expect(screen.getByRole('textbox', { description: 'Enter a valid email' })).toBe(input);
  });

  test('lists the hint id first and the error id second when both exist', () => {
    render(
      <Field label="Email" hint="We never share it" error="Enter a valid email">
        {(control) => <input {...control} />}
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Email' });
    const ids = idsOf(input);
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[0] as string)).toBe(screen.getByText('We never share it'));
    expect(document.getElementById(ids[1] as string)).toBe(screen.getByRole('alert'));
    expect(ids[0]).not.toBe(ids[1]);
  });

  test('renders no error markup and no aria wiring when there is neither hint nor error', () => {
    render(<Field label="Nick">{(control) => <input {...control} />}</Field>);
    const input = screen.getByRole('textbox', { name: 'Nick' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });

  test('drops the error markup and aria-invalid again once the error is gone', () => {
    const view = render(
      <Field label="Email" hint="We never share it" error="Enter a valid email">
        {(control) => <input {...control} />}
      </Field>,
    );
    view.rerender(
      <Field label="Email" hint="We never share it">
        {(control) => <input {...control} />}
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Email' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Enter a valid email')).toBeNull();
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(idsOf(input)).toHaveLength(1);
  });
});

describe('Field control', () => {
  test('receives DESIGN.md input styling and a 44px tap height', () => {
    render(<Field label="Name">{(control) => <input {...control} />}</Field>);
    const input = screen.getByRole('textbox', { name: 'Name' });
    for (const cls of ['min-h-tap', 'w-full', 'rounded-control', 'border', 'border-line', 'bg-white', 'text-ink']) {
      expect(input.classList.contains(cls)).toBe(true);
    }
    expect(input.classList.contains('focus-visible:border-accent')).toBe(true);
  });

  test('uses the id it is given', () => {
    render(
      <Field label="Two" id="custom" hint="Hint" error="Bad">
        {(control) => <input {...control} />}
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Two' });
    expect(input.id).toBe('custom');
    for (const id of idsOf(input)) {
      expect(id).not.toBe('custom');
      expect(document.getElementById(id)).not.toBeNull();
    }
  });

  test('gets a distinct generated id per Field, with distinct hint and error ids', () => {
    render(
      <>
        <Field label="One" hint="First hint" error="First error">
          {(control) => <input {...control} />}
        </Field>
        <Field label="Two" hint="Second hint" error="Second error">
          {(control) => <input {...control} />}
        </Field>
      </>,
    );
    const one = screen.getByLabelText('One');
    const two = screen.getByLabelText('Two');
    expect(one.id).not.toBe(two.id);
    expect(one.id).not.toBe('');
    expect(screen.getByRole('textbox', { description: 'First hint First error' })).toBe(one);
    expect(screen.getByRole('textbox', { description: 'Second hint Second error' })).toBe(two);
    expect(new Set([...idsOf(one), ...idsOf(two)]).size).toBe(4);
  });
});

describe('Field root', () => {
  test('spreads extra props and keeps the caller className last', () => {
    render(
      <Field label="Name" className="mt-4" data-testid="field">
        {(control) => <input {...control} />}
      </Field>,
    );
    const root = screen.getByTestId('field');
    const classes = root.className.split(' ');
    expect(classes[classes.length - 1]).toBe('mt-4');
    expect(classes).toContain('flex');
    expect(classes).toContain('min-w-0');
  });

  test('exposes data-tone for consumers', () => {
    render(
      <>
        <Field label="Ok" data-testid="ok">
          {(control) => <input {...control} />}
        </Field>
        <Field label="Bad" error="Wrong" data-testid="bad">
          {(control) => <input {...control} />}
        </Field>
      </>,
    );
    expect(screen.getByTestId('ok').getAttribute('data-tone')).toBe('default');
    expect(screen.getByTestId('bad').getAttribute('data-tone')).toBe('error');
  });
});
