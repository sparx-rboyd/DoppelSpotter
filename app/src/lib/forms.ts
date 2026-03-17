import type { KeyboardEvent } from 'react';

const NON_TEXT_INPUT_TYPES = new Set(['button', 'checkbox', 'file', 'radio', 'reset', 'submit']);

export function preventImplicitFormSubmit(event: KeyboardEvent<HTMLFormElement>): void {
  if (event.key !== 'Enter' || event.defaultPrevented || event.nativeEvent.isComposing) {
    return;
  }

  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) {
    return;
  }

  if (target instanceof HTMLInputElement && NON_TEXT_INPUT_TYPES.has(target.type.toLowerCase())) {
    return;
  }

  event.preventDefault();
}
