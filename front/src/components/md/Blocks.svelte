<script lang="ts">
  // Block level Markdown tokens. Unknown tokens are dropped, raw HTML is shown as text.
  import type { Token, Tokens } from '../../lib/markdown';
  import Inline from './Inline.svelte';
  import Self from './Blocks.svelte';

  interface Props {
    tokens: Token[];
  }
  let { tokens }: Props = $props();

  const level = (d: number) => `h${Math.min(4, Math.max(2, d))}`;
  /** A list item's children are either blocks or a loose run of inline text. */
  const hasBlocks = (t: Tokens.ListItem) =>
    t.tokens.some((c) => !['text', 'space'].includes(c.type) || c.type === 'space');
</script>

{#each tokens as t, i (i)}
  {#if t.type === 'heading'}
    <svelte:element this={level((t as Tokens.Heading).depth)}
      ><Inline tokens={(t as Tokens.Heading).tokens} /></svelte:element
    >
  {:else if t.type === 'paragraph'}
    <p><Inline tokens={(t as Tokens.Paragraph).tokens} /></p>
  {:else if t.type === 'text'}
    {#if (t as Tokens.Text).tokens}<p>
        <Inline tokens={(t as Tokens.Text).tokens ?? []} />
      </p>{:else}<p>{(t as Tokens.Text).text}</p>{/if}
  {:else if t.type === 'blockquote'}
    <blockquote><Self tokens={(t as Tokens.Blockquote).tokens} /></blockquote>
  {:else if t.type === 'list'}
    {@const l = t as Tokens.List}
    <svelte:element
      this={l.ordered ? 'ol' : 'ul'}
      start={l.ordered && l.start !== '' ? Number(l.start) : undefined}
    >
      {#each l.items as item, j (j)}
        <li>
          {#if item.task}<input type="checkbox" checked={item.checked} disabled />{/if}
          {#if l.loose || hasBlocks(item)}
            <Self tokens={item.tokens} />
          {:else}
            {#each item.tokens as c, k (k)}
              {#if c.type === 'text'}<Inline tokens={(c as Tokens.Text).tokens ?? [c]} />{/if}
            {/each}
          {/if}
        </li>
      {/each}
    </svelte:element>
  {:else if t.type === 'code'}
    <pre><code>{(t as Tokens.Code).text}</code></pre>
  {:else if t.type === 'hr'}
    <hr />
  {:else if t.type === 'table'}
    {@const tb = t as Tokens.Table}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            {#each tb.header as h, j (j)}
              <th style:text-align={h.align ?? undefined}><Inline tokens={h.tokens} /></th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each tb.rows as row, j (j)}
            <tr>
              {#each row as c, k (k)}
                <td style:text-align={c.align ?? undefined}><Inline tokens={c.tokens} /></td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if t.type === 'html'}
    <p class="raw">{(t as Tokens.HTML).text}</p>
  {/if}
{/each}
