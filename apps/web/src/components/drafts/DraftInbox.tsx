'use client';

// Stage 5A: Draft inbox client component
// Displays draft list with status filter, pagination, and all UI states.
// Amendment 7: Includes empty inbox, feature unavailable, and no Send button states.

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { DraftListItem, ApiError } from '@/lib/draft-api/types';

type StatusFilter = 'all' | 'draft' | 'approved' | 'rejected';

export function DraftInbox() {
  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [featureUnavailable, setFeatureUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const params = new URLSearchParams({
          status: statusFilter,
          page: String(page),
          limit: String(limit),
        });
        const res = await fetch(`/api/v1/drafts?${params}`, {
          headers: { 'Content-Type': 'application/json' },
        });

        if (cancelled) return;

        if (res.status === 503) {
          setFeatureUnavailable(true);
          setDrafts([]);
          setLoading(false);
          return;
        }

        if (res.status === 401) {
          setError('Authentication required');
          setDrafts([]);
          setLoading(false);
          return;
        }

        if (!res.ok) {
          const data: ApiError = await res.json();
          if (cancelled) return;
          setError(data.error?.message || 'Failed to load drafts');
          setDrafts([]);
          setLoading(false);
          return;
        }

        const data = await res.json();
        if (cancelled) return;
        setDrafts(data.drafts || []);
        setTotal(data.total || 0);
        setError(null);
        setFeatureUnavailable(false);
      } catch {
        if (!cancelled) {
          setError('Failed to load drafts');
          setDrafts([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => { cancelled = true; };
  }, [statusFilter, page, limit]);

  const refetch = () => {
    // Trigger a re-render by toggling a state — simplest is to change page to same value
    // Actually, we can just call the effect again by changing a dependency
    // For retry, we'll use a simple approach: set page to current page
    setPage((p) => p);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-zinc-500">Loading drafts...</p>
      </div>
    );
  }

  if (featureUnavailable) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-lg font-medium text-zinc-700">
          AI Draft Generation is not currently available for your organization.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-red-600">{error}</p>
        <button
          onClick={refetch}
          className="mt-4 rounded bg-zinc-800 px-4 py-2 text-white hover:bg-zinc-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold text-zinc-900">Draft Inbox</h1>

      {/* Status filter */}
      <div className="mb-4 flex gap-2">
        {(['all', 'draft', 'approved', 'rejected'] as StatusFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => {
              setStatusFilter(s);
              setPage(1);
            }}
            className={`rounded px-3 py-1 text-sm font-medium ${
              statusFilter === s
                ? 'bg-zinc-800 text-white'
                : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Empty state */}
      {drafts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-zinc-500">
            No drafts to review. AI-generated drafts will appear here for your review.
          </p>
        </div>
      ) : (
        <>
          {/* Draft list */}
          <div className="space-y-3">
            {drafts.map((draft) => (
              <Link
                key={draft.id}
                href={`/dashboard/drafts/${draft.id}`}
                className="block rounded-lg border border-zinc-200 p-4 transition hover:border-zinc-300 hover:shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <p className="text-sm text-zinc-600">
                      {draft.source_message_preview || 'No preview available'}
                    </p>
                    <p className="mt-1 text-xs text-zinc-400">
                      {draft.current_revision_body_preview || ''}
                    </p>
                  </div>
                  <StatusBadge status={draft.status} />
                </div>
                <div className="mt-2 flex items-center gap-3 text-xs text-zinc-400">
                  <span>v{draft.version}</span>
                  {draft.provider && <span>{draft.provider}</span>}
                  <span>{new Date(draft.created_at).toLocaleString()}</span>
                </div>
              </Link>
            ))}
          </div>

          {/* Pagination */}
          {total > limit && (
            <div className="mt-6 flex items-center justify-center gap-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="rounded px-3 py-1 text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-sm text-zinc-500">
                Page {page} of {Math.ceil(total / limit)}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page * limit >= total}
                className="rounded px-3 py-1 text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    draft: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-green-100 text-green-800',
    rejected: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`rounded-full px-2 py-1 text-xs font-medium ${styles[status] || 'bg-zinc-100 text-zinc-700'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}