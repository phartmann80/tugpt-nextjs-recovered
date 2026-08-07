'use client';

// Stage 5A: Draft action buttons (Approve, Edit, Reject)
// Amendment 1: Only visible when status is draft. Terminal drafts show no actions.
// Amendment 7: No Send or Send to WhatsApp control anywhere.
// Handles optimistic lock version and stale-version conflict.

import { useState } from 'react';
import type { ApiError } from '@/lib/draft-api/types';

interface DraftActionsProps {
  draftId: string;
  version: number;
  onActionComplete: () => void;
  onStaleVersion: () => void;
}

export function DraftActions({
  draftId,
  version,
  onActionComplete,
  onStaleVersion,
}: DraftActionsProps) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const handleApprove = async () => {
    setSubmitting(true);
    setError(null);
    setPermissionDenied(false);

    try {
      const res = await fetch(`/api/v1/drafts/${draftId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: version }),
      });

      if (res.status === 403) {
        setPermissionDenied(true);
        return;
      }

      if (res.status === 409) {
        onStaleVersion();
        return;
      }

      if (!res.ok) {
        const data: ApiError = await res.json();
        setError(data.error?.message || 'Failed to approve draft');
        return;
      }

      onActionComplete();
    } catch {
      setError('Failed to approve draft');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    setSubmitting(true);
    setError(null);
    setPermissionDenied(false);

    try {
      const res = await fetch(`/api/v1/drafts/${draftId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: version }),
      });

      if (res.status === 403) {
        setPermissionDenied(true);
        return;
      }

      if (res.status === 409) {
        onStaleVersion();
        return;
      }

      if (!res.ok) {
        const data: ApiError = await res.json();
        setError(data.error?.message || 'Failed to reject draft');
        return;
      }

      onActionComplete();
    } catch {
      setError('Failed to reject draft');
    } finally {
      setSubmitting(false);
    }
  };

  const handleEditSubmit = async () => {
    if (!editBody.trim()) {
      setError('Draft body must not be empty');
      return;
    }

    setSubmitting(true);
    setError(null);
    setPermissionDenied(false);

    try {
      const res = await fetch(`/api/v1/drafts/${draftId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedLockVersion: version, body: editBody }),
      });

      if (res.status === 403) {
        setPermissionDenied(true);
        return;
      }

      if (res.status === 409) {
        onStaleVersion();
        return;
      }

      if (!res.ok) {
        const data: ApiError = await res.json();
        setError(data.error?.message || 'Failed to edit draft');
        return;
      }

      setEditing(false);
      setEditBody('');
      onActionComplete();
    } catch {
      setError('Failed to edit draft');
    } finally {
      setSubmitting(false);
    }
  };

  if (permissionDenied) {
    return (
      <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="text-red-700">
          You do not have permission to perform this action.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-6">
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {editing ? (
        <div className="space-y-3">
          <textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 p-3 text-sm"
            rows={6}
            placeholder="Enter the revised draft body..."
          />
          <div className="flex gap-2">
            <button
              onClick={handleEditSubmit}
              disabled={submitting}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Save Edit'}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setEditBody('');
                setError(null);
              }}
              disabled={submitting}
              className="rounded border border-zinc-300 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={handleApprove}
            disabled={submitting}
            className="rounded bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
          >
            {submitting ? 'Processing...' : 'Approve'}
          </button>
          <button
            onClick={() => setEditing(true)}
            disabled={submitting}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Edit
          </button>
          <button
            onClick={handleReject}
            disabled={submitting}
            className="rounded bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50"
          >
            {submitting ? 'Processing...' : 'Reject'}
          </button>
        </div>
      )}
    </div>
  );
}