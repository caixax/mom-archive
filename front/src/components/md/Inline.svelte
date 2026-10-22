<script lang="ts">
  // Inline Markdown tokens. Links are checked against an allowlist of schemes and
  // images against this site's own archive; anything else stays text.
  import {
    isExternal,
    plain,
    safeHref,
    safeImage,
    type RefToken,
    type Token,
    type Tokens,
  } from '../../lib/markdown';
  import { md } from './context';
  import Ref from './Ref.svelte';
  import Self from './Inline.svelte';

  interface Props {
    tokens: Token[];
  }
  let { tokens }: Props = $props();
  const ctx = md();
</script>

{#each tokens as t, i (i)}
  {#if t.type === 'text' || t.type === 'escape'}
    {#if (t as Tokens.Text).tokens?.length}<Self
        tokens={(t as Tokens.Text).tokens ?? []}
      />{:else}{plain(t as Tokens.Text)}{/if}
  {:else if t.type === 'strong'}
    <strong><Self tokens={(t as Tokens.Strong).tokens} /></strong>
  {:else if t.type === 'em'}
    <em><Self tokens={(t as Tokens.Em).tokens} /></em>
  {:else if t.type === 'del'}
    <del><Self tokens={(t as Tokens.Del).tokens} /></del>
  {:else if t.type === 'codespan'}
    <code>{plain(t as Tokens.Codespan)}</code>
  {:else if t.type === 'br'}
    <br />
  {:else if t.type === 'link'}
    {@const l = t as Tokens.Link}
    {@const href = safeHref(l.href)}
    {#if href && isExternal(href)}
      <a {href} title={l.title ?? undefined} rel="external noopener noreferrer nofollow"
        ><Self tokens={l.tokens} /></a
      >
    {:else if href}
      <a {href} title={l.title ?? undefined}><Self tokens={l.tokens} /></a>
    {:else}
      <Self tokens={l.tokens} />
    {/if}
  {:else if t.type === 'image'}
    {@const im = t as Tokens.Image}
    {@const src = ctx.images ? safeImage(im.href) : null}
    {#if src}<img {src} alt={im.text} title={im.title ?? undefined} loading="lazy" />{:else}<span
        class="muted">[image: {im.text}]</span
      >{/if}
  {:else if t.type === 'html'}
    <span class="raw">{(t as Tokens.HTML).text}</span>
  {:else if t.type === 'ref'}
    <Ref ref={t as unknown as RefToken} />
  {/if}
{/each}
