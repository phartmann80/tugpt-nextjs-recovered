'use client';

// Stage 5A: Draft event history component
// Lists all review events for a draft, ordered by created_at descending.
// Append-only audit trail.

import { useState, useEffect } from 'react';
import type { ReviewEvent, ApiError } from '@/lib/draft-api/types';

interface DraftEventHistoryProps {
  draftId: string;
}

export function DraftEventHistory({ draftId }: DraftEventHistoryProps) {
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchEvents = async () => {
      try {
        const res = await fetch(`/api/v1/drafts/${draftId}/events`);
        if (!res.ok) {
          const data: ApiError = await res.json();
          setError(data.error?.message || 'Failed to load events');
          return;
        }
        const data = await res.json();
        setEvents(data.events || []);
      } catch {
        setError('Failed to load events');
      } finally {
        setLoading(false);
      }
    };

    fetchEvents();
  }, [draftId]);

  if (loading) {
    return (
      <div className="mb-6">
        <h2 className="mb-2 text-lg font-semibold text-zinc-800">Review Events</h2>
        <p className="text-sm text-zinc-500">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-6">
        <h2 className="mb-2 text-lg font-semibold text-zinc-800">Review Events</h2>
        <p className="text-sm text-red-600">{error}</p>
      </div>
    );
  }

  if (events.length === 0) {
    return null;
  }

  return (
    <div className="mb-6">
      <h2 className="mb-3 text-lg font-semibold text-zinc-800">Review Events</h2>
      <div className="space-y-2">
        {events.map((event) => (
          <div
            key={event.id}
            className="rounded-lg border border-zinc-200 bg-zinc-50 p-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-700">
                {event.action.charAt(0).toUpperCase() + event.action.slice(1)}
              </span>
              <span className="text-xs text-zinc-400">
                v{event.previous_version} &rarr; v{event.new_version}
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-400">
              {new Date(event.created_at).toLocaleString()}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}