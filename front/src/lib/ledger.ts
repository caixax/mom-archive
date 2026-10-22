// Ledger post shapes and labels shared by the public pages and the panel.

export type LedgerKind = 'case' | 'news' | 'concern' | 'changelog';

export interface LedgerSummary {
  id: number;
  slug: string;
  kind: LedgerKind;
  title: string;
  summary: string | null;
  pinned: boolean;
  subjectUserId: number | null;
  subjectAlias: string | null;
  publishedAt: string | null;
  editedAt: string | null;
}

export interface LedgerPost extends LedgerSummary {
  body: string;
  revisions: { id: number; validFrom: string; validTo: string; note: string | null }[];
}

export const KIND_LABEL: Record<LedgerKind, string> = {
  case: 'Case',
  news: 'News',
  concern: 'Concern',
  changelog: 'Site update',
};

export const KIND_PLURAL: Record<LedgerKind, string> = {
  case: 'Cases',
  news: 'News',
  concern: 'Concerns',
  changelog: 'Site updates',
};
