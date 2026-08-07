'use client';

// Stage 5A: Draft detail client component
// Displays full draft body, metadata, source message context, action buttons,
// revision history, and event history.
// Amendment 1: Action buttons only visible for draft status. Terminal drafts show no actions.
// Amendment 7: No Send button anywhere. Stale-version conflict with reload action.

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { DraftDetail as DraftDetailType, ApiError } from '@/lib/draft-api/types';
import { DraftActions } from './DraftActions';
import { DraftRevisionHistory } from './DraftRevisionHistory';
import { DraftEventHistory } from './DraftEventHistory';

export function DraftDetail({ draftId }: { draftId: string }) {
  const [draft, setDraft] = useState<DraftDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [featureUnavailable, setFeatureUnavailable] = useState(false);
  const [staleVersion, setStaleVersion] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const handleActionComplete = () => {
    setReloadKey((k) => k + 1);
  };

  const handleStaleVersion = () => {
    setStaleVersion(true);
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/v1/drafts/${draftId}`, {
          headers: { 'Content-Type': 'application/json' },
        });

        if (cancelled) return;

        if (res.status === 503) {
          setFeatureUnavailable(true);
          setLoading(false);
          return;
        }

        if (res.status === 404) {
          setNotFound(true);
          setLoading(false);
          return;
        }

        if (res.status === 401) {
          setError('Authentication required');
          setLoading(false);
          return;
        }

        if (!res.ok) {
          const data: ApiError = await res.json();
          if (cancelled) return;
          setError(data.error?.message || 'Failed to load draft');
          setLoading(false);
          return;
        }

        const data = await res.json();
        if (cancelled) return;
        setDraft(data.draft);
        setError(null);
        setNotFound(false);
        setFeatureUnavailable(false);
        setStaleVersion(false);
      } catch {
        if (!cancelled) setError('Failed to load draft');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => { cancelled = true; };
  }, [draftId, reloadKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-zinc-500">Loading draft...</p>
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

  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-zinc-600">Draft not found.</p>
        <Link
          href="/dashboard/drafts"
          className="mt-4 text-sm font-medium text-blue-600 hover:underline"
        >
          Back to inbox
        </Link>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-red-600">{error}</p>
        <button
          onClick={() => setReloadKey((k) => k + 1)}
          className="mt-4 rounded bg-zinc-800 px-4 py-2 text-white hover:bg-zinc-700"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!draft) return null;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link
        href="/dashboard/drafts"
        className="mb-4 inline-block text-sm text-blue-600 hover:underline"
      >
        &larr; Back to inbox
      </Link>

      {/* Stale version conflict */}
      {staleVersion && (
        <div className="mb-4 rounded-lg border border-orange-300 bg-orange-50 p-4">
          <p className="text-orange-800">
            This draft has been modified by another reviewer. Please reload.
          </p>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="mt-2 rounded bg-orange-600 px-4 py-2 text-sm text-white hover:bg-orange-700"
          >
            Reload
          </button>
        </div>
      )}

      {/* Draft header */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900">Draft Review</h1>
        <StatusBadge status={draft.status} />
      </div>

      {/* Draft metadata */}
      <div className="mb-6 grid grid-cols-2 gap-4 text-sm text-zinc-600">
        <div>Version: {draft.version}</div>
        {draft.provider && <div>Provider: {draft.provider}</div>}
        {draft.model && <div>Model: {draft.model}</div>}
        <div>Created: {new Date(draft.created_at).toLocaleString()}</div>
        <div>Updated: {new Date(draft.updated_at).toLocaleString()}</div>
        {draft.reviewed_at && (
          <div>Reviewed: {new Date(draft.reviewed_at).toLocaleString()}</div>
        )}
        {draft.rejected_at && (
          <div>Rejected: {new Date(draft.rejected_at).toLocaleString()}</div>
        )}
      </div>

      {/* Draft body */}
      <div className="mb-6">
        <h2 className="mb-2 text-lg font-semibold text-zinc-800">Draft Content</h2>
        <pre className="whitespace-pre-wrap rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-800">
          {draft.current_revision_body || 'No content available'}
        </pre>
      </div>

      {/* Source message context */}
      {draft.source_message && (
        <div className="mb-6">
          <h2 className="mb-2 text-lg font-semibold text-zinc-800">Source Message</h2>
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
            <p className="text-sm text-zinc-700">
              {draft.source_message.body || 'No message body'}
            </p>
            <div className="mt-2 flex gap-4 text-xs text-zinc-400">
              <span>Direction: {draft.source_message.direction}</span>
              <span>Received: {new Date(draft.source_message.created_at).toLocaleString()}</span>
              {draft.source_message.contact_display && (
                <span>From: {draft.source_message.contact_display}</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Conversation context */}
      {draft.conversation && (
        <div className="mb-6">
          <h2 className="mb-2 text-lg font-semibold text-zinc-800">Conversation</h2>
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600">
            <span>Status: {draft.conversation.status}</span>
          </div>
        </div>
      )}

      {/* Action buttons — only for draft status, not terminal */}
      {draft.status === 'draft' && (
        <DraftActions
          draftId={draft.id}
          version={draft.version}
          onActionComplete={handleActionComplete}
          onStaleVersion={handleStaleVersion}
        />
      )}

      {/* Revision history */}
      <DraftRevisionHistory draftId={draft.id} currentVersion={draft.version} />

      {/* Event history */}
      <DraftEventHistory draftId={draft.id} />
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
    <span className={`rounded-full px-3 py-1 text-sm font-medium ${styles[status] || 'bg-zinc-100 text-zinc-700'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}