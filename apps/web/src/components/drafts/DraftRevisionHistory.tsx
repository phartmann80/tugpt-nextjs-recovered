'use client';

// Stage 5A: Draft revision history component
// Lists all revisions for a draft, ordered by version descending.
// The current revision is highlighted.

import { useState, useEffect } from 'react';
import type { Revision, ApiError } from '@/lib/draft-api/types';

interface DraftRevisionHistoryProps {
  draftId: string;
  currentVersion: number;
}

export function DraftRevisionHistory({ draftId, currentVersion }: DraftRevisionHistoryProps) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchRevisions = async () => {
      try {
        const res = await fetch(`/api/v1/drafts/${draftId}/revisions`);
        if (!res.ok) {
          const data: ApiError = await res.json();
          setError(data.error?.message || 'Failed to load revisions');
          return;
        }
        const data = await res.json();
        setRevisions(data.revisions || []);
      } catch {
        setError('Failed to load revisions');
      } finally {
        setLoading(false);
      }
    };

    fetchRevisions();
  }, [draftId]);

  if (loading) {
    return (
      <div className="mb-6">
        <h2 className="mb-2 text-lg font-semibold text-zinc-800">Revision History</h2>
        <p className="text-sm text-zinc-500">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-6">
        <h2 className="mb-2 text-lg font-semibold text-zinc-800">Revision History</h2>
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  if (revisions.length === 0) {
    return null;
  }

  return (
    <div className="mb-6">
      <h2 className="mb-3 text-lg font-semibold text-zinc-800">Revision History</h2>
      <div className="space-y-2">
        {revisions.map((rev) => (
          <div
            key={rev.id}
            className={`rounded-lg border p-3 ${
              rev.version === currentVersion
                ? 'border-blue-300 bg-blue-50'
                : 'border-zinc-200 bg-zinc-50'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-700">
                Version {rev.version}
                {rev.version === currentVersion && (
                  <span className="ml-2 text-xs text-blue-600">(current)</span>
                )}
              </span>
              <span className="text-xs text-zinc-400">
                {rev.created_by_type === 'user' ? 'Edited by user' : 'AI generated'}
              </span>
            </div>
            <p className="mt-1 text-sm text-zinc-600">
              {rev.body.substring(0, 200)}
              {rev.body.length > 200 ? '...' : ''}
            </p>
            <p className="mt-1 text-xs text-zinc-400">
              {new Date(rev.created_at).toLocaleString()}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}