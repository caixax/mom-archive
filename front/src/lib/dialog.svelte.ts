// In page confirm and prompt dialogs, and toasts, instead of the browser's own
// confirm(), prompt() and alert(). One <Dialogs /> in App.svelte draws them.

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button, for things that cannot be undone */
  danger?: boolean;
}

export interface PromptOptions extends ConfirmOptions {
  label?: string;
  value?: string;
  placeholder?: string;
  maxlength?: number;
  /** Returns an error to show under the field, or null when the value is fine */
  validate?: (value: string) => string | null;
}

interface Request {
  id: number;
  kind: 'confirm' | 'prompt';
  opts: PromptOptions;
  resolve: (value: string | boolean | null) => void;
}

export interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
}

let next = 1;

export const dialogs = $state<{ current: Request | null; queue: Request[]; toasts: Toast[] }>({
  current: null,
  queue: [],
  toasts: [],
});

function enqueue(r: Request): void {
  if (dialogs.current) dialogs.queue.push(r);
  else dialogs.current = r;
}

/** Answers the dialog on screen and shows the next one, if any. */
export function settle(value: string | boolean | null): void {
  const r = dialogs.current;
  if (!r) return;
  dialogs.current = dialogs.queue.shift() ?? null;
  r.resolve(value);
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) =>
    enqueue({ id: next++, kind: 'confirm', opts, resolve: (v) => resolve(v === true) }),
  );
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) =>
    enqueue({
      id: next++,
      kind: 'prompt',
      opts,
      resolve: (v) => resolve(typeof v === 'string' ? v : null),
    }),
  );
}

function push(kind: Toast['kind'], text: string, ms: number): void {
  const id = next++;
  dialogs.toasts.push({ id, kind, text });
  // Keep the stack short: old messages make way for new ones.
  if (dialogs.toasts.length > 4) dialogs.toasts.shift();
  setTimeout(() => dismiss(id), ms);
}

export function dismiss(id: number): void {
  const i = dialogs.toasts.findIndex((t) => t.id === id);
  if (i >= 0) dialogs.toasts.splice(i, 1);
}

export const toast = {
  ok: (text: string) => push('ok', text, 4000),
  info: (text: string) => push('info', text, 5000),
  error: (text: string) => push('error', text, 9000),
};
