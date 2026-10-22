// Shared by the Markdown components: resolved references and what the source may use.
import { getContext, setContext } from 'svelte';
import type { ResolvedRefs } from '../../lib/markdown';

export interface MdContext {
  refs: ResolvedRefs | null;
  images: boolean;
}

const KEY = Symbol('md');

export function setMd(ctx: MdContext): void {
  setContext(KEY, ctx);
}

export function md(): MdContext {
  return getContext<MdContext>(KEY) ?? { refs: null, images: false };
}
