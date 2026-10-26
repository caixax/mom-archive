<script lang="ts">
  // A small Markdown box with a few formatting buttons and a preview, for report
  // messages. Images are off: text written by players never loads anything.
  import { promptDialog } from '../../lib/dialog.svelte';
  import { prefixLines, safeHref, wrapSelection } from '../../lib/markdown';
  import Markdown from './Markdown.svelte';

  interface Props {
    value: string;
    max?: number;
    rows?: number;
    placeholder?: string;
    images?: boolean;
    label?: string;
  }
  let {
    value = $bindable(),
    max = 4000,
    rows = 6,
    placeholder = '',
    images = false,
    label = 'Message',
  }: Props = $props();
  let preview = $state(false);
  let el = $state<HTMLTextAreaElement | null>(null);

  function wrap(a: string, b = a, ph = 'text') {
    if (el) value = wrapSelection(el, a, b, ph);
  }
  function lines(p: string) {
    if (el) value = prefixLines(el, p);
  }
  async function link() {
    const url = await promptDialog({
      title: 'Insert a link',
      label: 'Address',
      placeholder: 'https://... or a path here, like /runs/123',
      confirmLabel: 'Insert',
      validate: (v) => (safeHref(v) ? null : 'Use https://, mailto: or a path starting with /.'),
    });
    if (url) wrap('[', `](${url})`, 'link text');
  }
  function keys(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'b') {
      e.preventDefault();
      wrap('**');
    } else if (e.key === 'i') {
      e.preventDefault();
      wrap('*');
    }
  }
</script>

<div class="mini">
  <div class="bar" role="toolbar" aria-label="Formatting">
    <button type="button" onclick={() => wrap('**')} title="Bold" disabled={preview}
      ><b>B</b></button
    >
    <button type="button" onclick={() => wrap('*')} title="Italic" disabled={preview}
      ><i>I</i></button
    >
    <button type="button" onclick={link} title="Link" disabled={preview}>link</button>
    <button type="button" onclick={() => lines('> ')} title="Quote" disabled={preview}>quote</button
    >
    <button type="button" onclick={() => lines('- ')} title="List" disabled={preview}>list</button>
    <button type="button" onclick={() => wrap('`')} title="Code" disabled={preview}>code</button>
    <span class="grow"></span>
    <button type="button" class:on={!preview} onclick={() => (preview = false)}>Write</button>
    <button type="button" class:on={preview} onclick={() => (preview = true)}>Preview</button>
  </div>
  {#if preview}
    <div class="pv">
      {#if value.trim()}<Markdown source={value} {images} />{:else}<p class="muted">
          Nothing to preview.
        </p>{/if}
    </div>
  {:else}
    <textarea
      bind:this={el}
      bind:value
      {rows}
      maxlength={max}
      {placeholder}
      aria-label={label}
      onkeydown={keys}
    ></textarea>
  {/if}
  <div class="foot small muted">
    Markdown works: **bold**, *italic*, [links](https://...), &gt; quotes, lists, and [[run:123]] or
    [[user:14991]] to point at a record. {value.length} / {max}
  </div>
</div>

<style>
  .mini {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-2);
  }
  .bar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0.3rem;
    border-bottom: 1px solid var(--border);
  }
  .bar button {
    padding: 0.15rem 0.5rem;
    min-width: 2rem;
  }
  .bar button.on {
    border-color: var(--accent);
    color: var(--text);
  }
  .grow {
    flex: 1;
  }
  textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    border: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    line-height: 1.5;
    padding: 0.6rem;
    resize: vertical;
  }
  .pv {
    padding: 0 0.8rem;
    min-height: 6rem;
  }
  .foot {
    padding: 0.3rem 0.6rem;
    border-top: 1px solid var(--border);
  }
</style>
