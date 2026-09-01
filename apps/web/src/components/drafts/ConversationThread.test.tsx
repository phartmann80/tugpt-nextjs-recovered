// @vitest-environment jsdom
/**
 * @file ConversationThread.test.tsx
 * @description The thread as a reviewer sees it.
 *
 * The route tests prove the response is right. These prove the screen does not
 * quietly throw the important parts of it away — the marked source message, and
 * the two things the thread has to admit to rather than render past.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationThread } from './ConversationThread';
import { createTranslator } from '@/i18n';

const t = createTranslator('es');

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const SOURCE_ID = '11111111-1111-1111-1111-111111111111';

const thread = (overrides: Record<string, unknown> = {}) => ({
  thread: {
    conversation_id: '22222222-2222-2222-2222-222222222222',
    contact_display: '***-***-4567',
    status: 'open',
    messages: [
      {
        id: '00000000-0000-0000-0000-000000000000',
        body: '¿Tienen pan integral?',
        direction: 'inbound',
        created_at: '2026-09-01T10:00:00.000Z',
        is_source: false,
      },
      {
        id: SOURCE_ID,
        body: '¿Y tortas para el sábado?',
        direction: 'inbound',
        created_at: '2026-09-01T11:00:00.000Z',
        is_source: true,
      },
    ],
    has_more: false,
    source_in_window: true,
    ...overrides,
  },
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const err = (status: number, code: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { code, message: 'nope' } }),
});

beforeEach(() => mockFetch.mockReset());
afterEach(cleanup);

describe('reading the conversation', () => {
  it('T1: renders every message it was given', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread()));
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText('¿Tienen pan integral?')).toBeTruthy();
    expect(screen.getByText('¿Y tortas para el sábado?')).toBeTruthy();
  });

  it('T2: keeps the order the API sent, which is oldest first', async () => {
    // The component must not re-sort. The API already decided reading order,
    // and a second opinion about it here is a second thing to get wrong.
    mockFetch.mockResolvedValueOnce(ok(thread()));
    const { container } = render(<ConversationThread draftId="d1" />);

    await screen.findByText('¿Tienen pan integral?');
    const text = container.textContent ?? '';
    expect(text.indexOf('¿Tienen pan integral?')).toBeLessThan(
      text.indexOf('¿Y tortas para el sábado?')
    );
  });

  it('T3: marks the message the draft answers, in words and not only in colour', async () => {
    // A reviewer who cannot distinguish amber from white still has to find the
    // one message on this screen they came to find.
    mockFetch.mockResolvedValueOnce(ok(thread()));
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('drafts.thread.sourceLabel'))).toBeTruthy();
  });

  it('T4: distinguishes the customer from the business', async () => {
    mockFetch.mockResolvedValueOnce(
      ok(
        thread({
          messages: [
            { id: 'a', body: 'hola', direction: 'inbound', created_at: '2026-09-01T10:00:00.000Z', is_source: false },
            { id: 'b', body: 'buenas', direction: 'outbound', created_at: '2026-09-01T10:05:00.000Z', is_source: false },
          ],
        })
      )
    );
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('drafts.thread.fromCustomer'))).toBeTruthy();
    expect(screen.getByText(t('drafts.thread.fromBusiness'))).toBeTruthy();
  });

  it('T5: renders a message with no text as a note, not as a blank row', async () => {
    // `messages.body` is nullable. A blank row reads as a rendering bug.
    mockFetch.mockResolvedValueOnce(
      ok(thread({ messages: [{ id: 'a', body: null, direction: 'inbound', created_at: '2026-09-01T10:00:00.000Z', is_source: false }] }))
    );
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('drafts.thread.noBody'))).toBeTruthy();
  });
});

describe('what the thread admits to', () => {
  it('T6: says older messages exist rather than just stopping', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread({ has_more: true })));
    render(<ConversationThread draftId="d1" />);

    expect(
      await screen.findByText(t('drafts.thread.olderHidden', { count: '2' }))
    ).toBeTruthy();
  });

  it('T7: does not claim older messages exist when they do not', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread({ has_more: false })));
    render(<ConversationThread draftId="d1" />);

    await screen.findByText('¿Tienen pan integral?');
    expect(screen.queryByText(/mensajes más recientes/)).toBeNull();
  });

  it('T8: says when the message being answered is outside the window', async () => {
    // Otherwise the reviewer reads a history that does not contain the message
    // the draft replies to, and nothing on screen says so.
    mockFetch.mockResolvedValueOnce(
      ok(thread({ source_in_window: false, messages: [{ id: 'a', body: 'hola', direction: 'inbound', created_at: '2026-09-01T10:00:00.000Z', is_source: false }] }))
    );
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('drafts.thread.sourceOutOfWindow'))).toBeTruthy();
  });

  it('T9: stays quiet when the source is where it should be', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread()));
    render(<ConversationThread draftId="d1" />);

    await screen.findByText('¿Tienen pan integral?');
    expect(screen.queryByText(t('drafts.thread.sourceOutOfWindow'))).toBeNull();
  });

  it('T10: explains an empty conversation instead of showing nothing', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread({ messages: [] })));
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('drafts.thread.empty'))).toBeTruthy();
  });
});

describe('when it cannot load', () => {
  it('T11: translates a known API error rather than echoing the English', async () => {
    mockFetch.mockResolvedValueOnce(err(403, 'FORBIDDEN'));
    render(<ConversationThread draftId="d1" />);

    expect(await screen.findByText(t('errors.FORBIDDEN'))).toBeTruthy();
  });

  it('T12: Retry actually retries', async () => {
    // The regression the draft inbox shipped with for months: `setPage((p) => p)`
    // sets the same value, React bails out, and the effect the button exists to
    // re-run never re-runs. Asserted here rather than assumed not to recur.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(err(500, 'INTERNAL_ERROR'));
    render(<ConversationThread draftId="d1" />);

    const button = await screen.findByRole('button', { name: t('drafts.thread.retry') });
    const before = mockFetch.mock.calls.length;

    mockFetch.mockResolvedValueOnce(ok(thread()));
    await user.click(button);

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByText('¿Tienen pan integral?')).toBeTruthy();
  });
});

describe('what the thread must never offer', () => {
  it('T13: renders no send or WhatsApp control', async () => {
    // Amendment 7, asserted here by name because this is the screen in the
    // product that most looks like a chat — which is exactly where a send box
    // would seem to belong.
    mockFetch.mockResolvedValueOnce(ok(thread()));
    render(<ConversationThread draftId="d1" />);

    await screen.findByText('¿Tienen pan integral?');
    expect(screen.queryByRole('button', { name: /send|enviar|responder/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.body.textContent).not.toMatch(/whatsapp/i);
  });

  it('T14: shows the masked contact and never a raw number', async () => {
    mockFetch.mockResolvedValueOnce(ok(thread()));
    const { container } = render(<ConversationThread draftId="d1" />);

    await screen.findByText('¿Tienen pan integral?');
    expect(screen.getByText('***-***-4567')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\+\d{7,}/);
  });
});
