'use client';

/**
 * @file ConversationInbox.tsx
 * @description The unified inbox. The Sep 25 milestone.
 *
 * WHAT A REVIEWER IS DOING HERE
 *
 * Deciding which conversation to open next. Until now the only list in the
 * product was a list of *drafts*, which answers "what did the AI write" and
 * not "who is waiting" — a customer with three messages and no draft was
 * nowhere on any screen. This lists the conversations, most recently active
 * first, and marks the ones with something to review.
 *
 * WHY "NEXT" AND NOT PAGE NUMBERS
 *
 * The list reorders itself: a customer replying moves their conversation to
 * the top, which shifts everything below it down. Under numbered/offset paging
 * the row pushed across a page boundary is simply never shown, and the reviewer
 * sees a shorter list rather than a gap. A keyset cursor names the last row of
 * the page instead of counting the rows before it, so the boundary keeps its
 * meaning. Going *back* is a stack of the cursors already used, not arithmetic.
 *
 * NO SEND CONTROL. Amendment 7. Nothing in TuGPT sends.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useT } from '@/i18n/provider';
import { formatDateTime } from '@/i18n';
import { apiErrorText } from '@/lib/draft-api/error-text';
import { INBOX_FILTERS, type InboxFilter, type InboxPage } from '@/lib/conversations/types';

export function ConversationInbox() {
  const t = useT();
  const [page, setPage] = useState<InboxPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<InboxFilter>('all');
  // The cursors used to reach the current page, oldest first. `undefined` at
  // the top is the first page. Kept as a stack rather than recomputed, because
  // a keyset cursor cannot be derived backwards — the only way to know where
  // page two started is to remember it.
  const [trail, setTrail] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);

  const cursor = trail.length > 0 ? trail[trail.length - 1] : null;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const params = new URLSearchParams();
        if (filter !== 'all') params.set('status', filter);
        if (cursor) params.set('cursor', cursor);
        const query = params.toString();

        const res = await fetch(`/api/v1/conversations${query ? `?${query}` : ''}`);
        const data = await res.json();
        if (cancelled) return;

        if (!res.ok) {
          setError(apiErrorText(t, data));
          setPage(null);
        } else {
          setPage(data as InboxPage);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError(t('inbox.loadFailed'));
          setPage(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, cursor, attempt]);

  const changeFilter = useCallback((next: InboxFilter) => {
    setLoading(true);
    setError(null);
    // A cursor names a position in one ordering of one filter. Carrying it
    // across a filter change would resume in the middle of a list the reviewer
    // has not seen the start of.
    setTrail([]);
    setFilter(next);
  }, []);

  const goNext = useCallback(() => {
    if (!page?.next_cursor) return;
    setLoading(true);
    setTrail((t) => [...t, page.next_cursor as string]);
  }, [page]);

  const goStart = useCallback(() => {
    setLoading(true);
    setTrail([]);
  }, []);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    // A counter, not a toggle: setting a value to itself is a no-op React
    // optimises away, which is the bug the draft inbox shipped with for months.
    setAttempt((n) => n + 1);
  }, []);

  return (
    <section>
      <h1 className="mb-4 text-2xl font-semibold text-zinc-900">{t('inbox.title')}</h1>

      <div className="mb-4 flex flex-wrap gap-2">
        {INBOX_FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => changeFilter(value)}
            aria-pressed={filter === value}
            className={`rounded-full border px-3 py-1 text-sm transition ${
              filter === value
                ? 'border-zinc-800 bg-zinc-800 text-white'
                : 'border-zinc-300 text-zinc-700 hover:bg-zinc-100'
            }`}
          >
            {t(`inbox.filter.${value}`)}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-zinc-500">{t('inbox.loading')}</p>}

      {!loading && error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-2 rounded border border-red-300 px-3 py-1 text-sm font-medium text-red-700 transition hover:bg-red-100"
          >
            {t('inbox.retry')}
          </button>
        </div>
      )}

      {!loading && !error && page && (
        <>
          {page.conversations.length === 0 ? (
            <p className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-sm text-zinc-500">
              {filter === 'all' ? t('inbox.empty') : t('inbox.emptyFiltered')}
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white">
              {page.conversations.map((c) => {
                const row = (
                  <span className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <span className="flex flex-wrap items-center gap-3">
                      <span className="font-medium text-zinc-800">
                        {c.contact_display ?? t('inbox.unknownContact')}
                      </span>
                      <span className="text-xs text-zinc-500">
                        {t(`drafts.conversation.${c.status}`)}
                      </span>
                      {/* Marked in words, not colour alone — the one thing on
                          this screen a reviewer is scanning for. */}
                      {c.awaiting_draft_id && (
                        <span className="rounded bg-amber-200 px-2 py-0.5 text-xs font-medium text-amber-900">
                          {t('inbox.awaitingReview')}
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-zinc-500">
                      {t('inbox.lastActivity', { at: formatDateTime(c.activity_at, t.locale) })}
                    </span>
                  </span>
                );

                return (
                  <li key={c.id}>
                    {/*
                      A row opens the draft waiting on it. A conversation with
                      nothing to review is shown and is not a link, because
                      there is no screen for it yet — the conversation detail
                      view is the next milestone. A link to a page that does
                      not exist would be worse than a row that plainly does not
                      move: it looks like the product, and 404s.
                    */}
                    {c.awaiting_draft_id ? (
                      <Link
                        href={`/dashboard/drafts/${c.awaiting_draft_id}`}
                        className="block transition hover:bg-zinc-50"
                      >
                        {row}
                      </Link>
                    ) : (
                      <span className="block">{row}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-4 flex gap-2">
            {trail.length > 0 && (
              <button
                type="button"
                onClick={goStart}
                className="rounded border border-zinc-300 px-3 py-1 text-sm text-zinc-700 transition hover:bg-zinc-100"
              >
                {t('inbox.start')}
              </button>
            )}
            {page.next_cursor && (
              <button
                type="button"
                onClick={goNext}
                className="rounded border border-zinc-300 px-3 py-1 text-sm text-zinc-700 transition hover:bg-zinc-100"
              >
                {t('inbox.next')}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
