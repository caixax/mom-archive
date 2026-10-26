<script lang="ts">
  // Draws the dialog and the toasts from lib/dialog. Uses a modal <dialog>, which
  // keeps focus inside it and closes on Escape, styled like the rest of the site.
  import { dialogs, dismiss, settle } from '../lib/dialog.svelte';

  let el = $state<HTMLDialogElement | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let value = $state('');
  let problem = $state<string | null>(null);

  const req = $derived(dialogs.current);

  $effect(() => {
    const r = req;
    if (!el) return;
    if (r) {
      value = r.opts.value ?? '';
      problem = null;
      if (!el.open) el.showModal();
      queueMicrotask(() => (r.kind === 'prompt' ? input?.select() : undefined));
    } else if (el.open) el.close();
  });

  function cancel() {
    if (!req) return;
    settle(req.kind === 'confirm' ? false : null);
  }

  function submit(e: Event) {
    e.preventDefault();
    if (!req) return;
    if (req.kind === 'confirm') return settle(true);
    const v = value.trim();
    const why = req.opts.validate?.(v) ?? (v ? null : 'This cannot be empty.');
    if (why) {
      problem = why;
      input?.focus();
      return;
    }
    settle(v);
  }
</script>

<dialog
  bind:this={el}
  aria-labelledby="dlg-title"
  oncancel={(e) => (e.preventDefault(), cancel())}
  onclick={(e) => {
    // A click on the backdrop lands on the dialog element itself.
    if (e.target === el) cancel();
  }}
>
  {#if req}
    <form onsubmit={submit}>
      <h2 id="dlg-title">{req.opts.title}</h2>
      {#if req.opts.message}<p class="msg">{req.opts.message}</p>{/if}
      {#if req.kind === 'prompt'}
        <label>
          {#if req.opts.label}<span class="small muted">{req.opts.label}</span>{/if}
          <input
            bind:this={input}
            bind:value
            placeholder={req.opts.placeholder ?? ''}
            maxlength={req.opts.maxlength ?? 300}
            aria-invalid={problem ? 'true' : undefined}
          />
        </label>
        {#if problem}<p class="problem small">{problem}</p>{/if}
      {/if}
      <div class="buttons">
        <button type="button" onclick={cancel}>{req.opts.cancelLabel ?? 'Cancel'}</button>
        <button type="submit" class={req.opts.danger ? 'danger' : 'primary'}
          >{req.opts.confirmLabel ?? (req.kind === 'prompt' ? 'OK' : 'Confirm')}</button
        >
      </div>
    </form>
  {/if}
</dialog>

<div class="toasts" aria-live="polite" aria-atomic="false">
  {#each dialogs.toasts as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === 'error' ? 'alert' : 'status'}>
      <span>{t.text}</span>
      <button type="button" class="x" aria-label="Dismiss" onclick={() => dismiss(t.id)}>×</button>
    </div>
  {/each}
</div>

<style>
  dialog {
    background: var(--bg-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0;
    width: min(28rem, calc(100vw - 2rem));
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }
  dialog::backdrop {
    background: rgba(5, 7, 10, 0.6);
  }
  form {
    padding: 1rem 1.1rem 0.9rem;
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.1rem;
    border: none;
  }
  .msg {
    margin: 0 0 0.8rem;
    color: var(--muted);
    line-height: 1.5;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  input {
    width: 100%;
    box-sizing: border-box;
  }
  .problem {
    color: var(--err);
    margin: 0.3rem 0 0;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  button.danger {
    background: var(--err);
    border-color: var(--err);
    color: #0b1220;
    font-weight: 600;
  }
  .toasts {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    z-index: 1000;
    max-width: min(26rem, calc(100vw - 2rem));
  }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: 6px;
    padding: 0.6rem 0.5rem 0.6rem 0.8rem;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
    animation: in 0.15s ease-out;
  }
  .toast.ok {
    border-left-color: var(--ok);
  }
  .toast.error {
    border-left-color: var(--err);
  }
  .toast span {
    flex: 1;
    line-height: 1.4;
  }
  .x {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    padding: 0 0.3rem;
  }
  @keyframes in {
    from {
      transform: translateY(0.4rem);
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
