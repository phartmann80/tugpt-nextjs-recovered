'use client';

/**
 * @file ConversationThread.tsx
 * @description The customer's history, beside the draft. The Sep 18 milestone.
 *
 * WHAT A REVIEWER IS DOING HERE
 *
 * Approving a reply on behalf of a business, to a person the business knows and
 * they do not. Before this existed, the screen showed one message — the one the
 * draft answers — with no way to tell whether the customer had already asked
 * the same thing twice, whether the shop had answered an hour ago, or whether
 * the draft repeats something already said. The reviewer had the AI's guess and
 * no context to judge it against, which is the wrong side of a
 * human-in-the-loop product to be short of information on.
 *
 * TWO THINGS THIS SAYS OUT LOUD RATHER THAN HIDING
 *
 *   * Older messages exist but are not shown. A thread that silently stops is
 *     one a reviewer reads as complete.
 *   * The message being answered is not in the window. Rare, and invisible
 *     unless stated — the reviewer would read a history that does not contain
 *     the message the draft is replying to.
 *
 * NO SEND CONTROL, HERE LEAST OF ALL. This is the screen that most looks like a
 * chat, which is exactly why Amendment 7 is asserted against it by name in
 * `ConversationThread.test.tsx`. Nothing in TuGPT sends.
 */

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/i18n/provider';
import { formatDateTime } from '@/i18n';
import { apiErrorText } from '@/lib/draft-api/error-text';
import type { ConversationThread as Thread } from '@/lib/draft-api/types';

export function ConversationThread({ draftId }: { draftId: string }) {
  const t = useT();
  const [thread, setThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry. A counter and not a boolean: the effect must re-run every
  // time the button is pressed, and setting a value to itself is a no-op React
  // optimises away — the exact bug the draft inbox shipped with for months.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/v1/drafts/${draftId}/thread`);
        const data = await res.json();
        if (cancelled) return;

        if (!res.ok) {
          setError(apiErrorText(t, data));
          setThread(null);
        } else {
          setThread(data.thread as Thread);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError(t('drafts.thread.loadFailed'));
          setThread(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, attempt]);

  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-lg font-semibold text-zinc-800">{t('drafts.thread.heading')}</h2>

      {loading && <p className="text-sm text-zinc-500">{t('drafts.thread.loading')}</p>}

      {!loading && error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{error}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-2 rounded border border-red-300 px-3 py-1 text-sm font-medium text-red-700 transition hover:bg-red-100"
          >
            {t('drafts.thread.retry')}
          </button>
        </div>
      )}

      {!loading && !error && thread && (
        <div className="rounded-lg border border-zinc-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500">
            {thread.contact_display && <span>{thread.contact_display}</span>}
            <span>
              {t('drafts.detail.conversationStatus', {
                status: t(`drafts.conversation.${thread.status}`),
              })}
            </span>
          </div>

          {thread.has_more && (
            <p className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs text-zinc-500">
              {t('drafts.thread.olderHidden', { count: String(thread.messages.length) })}
            </p>
          )}

          {!thread.source_in_window && (
            <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
              {t('drafts.thread.sourceOutOfWindow')}
            </p>
          )}

          {thread.messages.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-500">{t('drafts.thread.empty')}</p>
          ) : (
            <ol className="divide-y divide-zinc-100">
              {thread.messages.map((m) => (
                <li
                  key={m.id}
                  // The message being answered is marked with a border and a
                  // label, not colour alone — a reviewer who cannot distinguish
                  // amber from white still needs to find it, and it is the one
                  // thing on this screen they are here to find.
                  className={`px-4 py-3 ${m.is_source ? 'border-l-4 border-l-amber-400 bg-amber-50' : ''}`}
                >
                  <div className="mb-1 flex flex-wrap items-baseline gap-x-3 text-xs text-zinc-500">
                    <span className="font-medium text-zinc-700">
                      {m.direction === 'inbound'
                        ? t('drafts.thread.fromCustomer')
                        : t('drafts.thread.fromBusiness')}
                    </span>
                    <span>{formatDateTime(m.created_at, t.locale)}</span>
                    {m.is_source && (
                      <span className="rounded bg-amber-200 px-2 py-0.5 font-medium text-amber-900">
                        {t('drafts.thread.sourceLabel')}
                      </span>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-zinc-800">
                    {m.body || <span className="italic text-zinc-400">{t('drafts.thread.noBody')}</span>}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
