import type { FormEvent } from 'react';

export function submittedForm(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return new FormData(event.currentTarget);
}
export function trimmedFormValue(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}
