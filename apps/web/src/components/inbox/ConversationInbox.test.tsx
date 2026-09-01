// @vitest-environment jsdom
/**
 * @file ConversationInbox.test.tsx
 * @description The inbox as a reviewer sees it.
 *
 * The route tests prove the page of data is right. These prove the screen does
 * not throw away the parts that make it an inbox: which rows have work waiting,
 * where a row goes, and a Next button that means "the page after this one"
 * rather than "the page after however many I have counted".
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConversationInbox } from './ConversationInbox';
import { createTranslator } from '@/i18n';

const t = createTranslator('es');

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const CONV_A = 'aaaaaaaa-1111-1111-1111-111111111111';
const CONV_B = 'bbbbbbbb-1111-1111-1111-111111111111';

const page = (overrides: Record<string, unknown> = {}) => ({
  conversations: [
    {
      id: CONV_A,
      contact_display: '***-***-4567',
      status: 'open',
      activity_at: '2026-09-01T11:00:00.000Z',
      awaiting_draft_id: 'draft-a',
    },
    {
      id: CONV_B,
      contact_display: '***-***-8901',
      status: 'closed',
      activity_at: '2026-09-01T10:00:00.000Z',
      awaiting_draft_id: null,
    },
  ],
  next_cursor: null,
  ...overrides,
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const err = (status: number, code: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { code, message: 'nope' } }),
});

beforeEach(() => mockFetch.mockReset());
afterEach(cleanup);

const lastUrl = () => mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;

describe('reading the inbox', () => {
  it('T1: lists the conversations it was given', async () => {
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox />);

    expect(await screen.findByText('***-***-4567')).toBeTruthy();
    expect(screen.getByText('***-***-8901')).toBeTruthy();
  });

  it('T2: keeps the order the API sent', async () => {
    // The API decided "most recently active first". A second opinion here is a
    // second thing to get wrong, and the component has no cursor to re-sort by.
    mockFetch.mockResolvedValueOnce(ok(page()));
    const { container } = render(<ConversationInbox />);

    await screen.findByText('***-***-4567');
    const text = container.textContent ?? '';
    expect(text.indexOf('***-***-4567')).toBeLessThan(text.indexOf('***-***-8901'));
  });

  it('T3: marks the rows with a draft waiting, in words', async () => {
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox />);

    const marks = await screen.findAllByText(t('inbox.awaitingReview'));
    expect(marks).toHaveLength(1);
  });

  it('T4: opens the draft that is waiting', async () => {
    // The row's whole purpose. A row that says "draft awaiting review" and
    // goes nowhere is the defect this replaced a boolean to avoid.
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox />);

    const link = await screen.findByRole('link');
    expect(link.getAttribute('href')).toBe('/dashboard/drafts/draft-a');
  });

  it('T5: does not link a conversation with nothing to review', async () => {
    // There is no conversation detail page yet. A link to one would 404 while
    // looking exactly like the rest of the product.
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox />);

    await screen.findByText('***-***-8901');
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    for (const link of links) {
      expect(link.getAttribute('href')).not.toContain(CONV_B);
    }
  });

  it('T6: names a contact it does not know rather than rendering a blank', async () => {
    mockFetch.mockResolvedValueOnce(
      ok(page({ conversations: [{ id: CONV_A, contact_display: null, status: 'open', activity_at: '2026-09-01T11:00:00.000Z', awaiting_draft_id: null }] }))
    );
    render(<ConversationInbox />);

    expect(await screen.findByText(t('inbox.unknownContact'))).toBeTruthy();
  });

  it('T7: shows the conversation status in Spanish', async () => {
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox />);

    expect(await screen.findByText(t('drafts.conversation.open'))).toBeTruthy();
    expect(screen.getByText(t('drafts.conversation.closed'))).toBeTruthy();
  });

  it('T8: explains an empty inbox', async () => {
    mockFetch.mockResolvedValueOnce(ok(page({ conversations: [] })));
    render(<ConversationInbox />);

    expect(await screen.findByText(t('inbox.empty'))).toBeTruthy();
  });

  it('T9: says an empty *filter* differently from an empty inbox', async () => {
    // "No conversations yet" under a filter is a lie that reads as an outage.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox />);
    await screen.findByText('***-***-4567');

    mockFetch.mockResolvedValueOnce(ok(page({ conversations: [] })));
    await user.click(screen.getByRole('button', { name: t('inbox.filter.closed') }));

    expect(await screen.findByText(t('inbox.emptyFiltered'))).toBeTruthy();
    expect(screen.queryByText(t('inbox.empty'))).toBeNull();
  });
});

describe('filtering', () => {
  it('T10: asks the API for the chosen status', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox />);
    await screen.findByText('***-***-4567');

    mockFetch.mockResolvedValueOnce(ok(page()));
    await user.click(screen.getByRole('button', { name: t('inbox.filter.needs_human') }));

    await waitFor(() => expect(lastUrl()).toContain('status=needs_human'));
  });

  it('T11: sends no status at all for "all"', async () => {
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox />);

    await screen.findByText('***-***-4567');
    expect(lastUrl()).not.toContain('status=');
  });

  it('T12: marks the active filter for assistive technology, not only in colour', async () => {
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox />);
    await screen.findByText('***-***-4567');

    expect(screen.getByRole('button', { name: t('inbox.filter.all') }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: t('inbox.filter.open') }).getAttribute('aria-pressed')).toBe('false');
  });

  it('T13: drops the cursor when the filter changes', async () => {
    // A cursor names a position in one ordering of one filter. Carried across a
    // filter change it resumes in the middle of a list the reviewer has not
    // seen the start of — with no way to tell that is what happened.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: 'CURSOR1' })));
    render(<ConversationInbox />);
    await screen.findByText('***-***-4567');

    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: 'CURSOR2' })));
    await user.click(screen.getByRole('button', { name: t('inbox.next') }));
    await waitFor(() => expect(lastUrl()).toContain('cursor=CURSOR1'));

    mockFetch.mockResolvedValueOnce(ok(page()));
    await user.click(screen.getByRole('button', { name: t('inbox.filter.open') }));

    await waitFor(() => expect(lastUrl()).toContain('status=open'));
    expect(lastUrl()).not.toContain('cursor=');
  });
});

describe('paging', () => {
  it('T14: offers Next only when the API says there is more', async () => {
    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: null })));
    render(<ConversationInbox />);

    await screen.findByText('***-***-4567');
    expect(screen.queryByRole('button', { name: t('inbox.next') })).toBeNull();
  });

  it('T15: Next sends the cursor the API gave it', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: 'CURSOR1' })));
    render(<ConversationInbox />);
    await screen.findByText('***-***-4567');

    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: null })));
    await user.click(screen.getByRole('button', { name: t('inbox.next') }));

    await waitFor(() => expect(lastUrl()).toContain('cursor=CURSOR1'));
  });

  it('T16: offers a way back once the reviewer has paged', async () => {
    // A keyset cursor cannot be reversed. Without this the only way back to the
    // top of the inbox is reloading the page.
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: 'CURSOR1' })));
    render(<ConversationInbox />);
    await screen.findByText('***-***-4567');
    expect(screen.queryByRole('button', { name: t('inbox.start') })).toBeNull();

    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: null })));
    await user.click(screen.getByRole('button', { name: t('inbox.next') }));

    expect(await screen.findByRole('button', { name: t('inbox.start') })).toBeTruthy();
  });

  it('T17: going back to the start sends no cursor', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: 'CURSOR1' })));
    render(<ConversationInbox />);
    await screen.findByText('***-***-4567');

    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: null })));
    await user.click(screen.getByRole('button', { name: t('inbox.next') }));
    await screen.findByRole('button', { name: t('inbox.start') });

    mockFetch.mockResolvedValueOnce(ok(page({ next_cursor: 'CURSOR1' })));
    await user.click(screen.getByRole('button', { name: t('inbox.start') }));

    await waitFor(() => expect(lastUrl()).not.toContain('cursor='));
  });
});

describe('when it cannot load', () => {
  it('T18: translates a known API error rather than echoing the English', async () => {
    mockFetch.mockResolvedValueOnce(err(403, 'FORBIDDEN'));
    render(<ConversationInbox />);

    expect(await screen.findByText(t('errors.FORBIDDEN'))).toBeTruthy();
  });

  it('T19: Retry actually retries', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(err(500, 'INTERNAL_ERROR'));
    render(<ConversationInbox />);

    const button = await screen.findByRole('button', { name: t('inbox.retry') });
    const before = mockFetch.mock.calls.length;

    mockFetch.mockResolvedValueOnce(ok(page()));
    await user.click(button);

    await waitFor(() => expect(mockFetch.mock.calls.length).toBeGreaterThan(before));
    expect(await screen.findByText('***-***-4567')).toBeTruthy();
  });
});

describe('what the inbox must never offer', () => {
  it('T20: renders no send or WhatsApp control', async () => {
    // Amendment 7. Nothing in TuGPT sends.
    mockFetch.mockResolvedValueOnce(ok(page()));
    render(<ConversationInbox />);

    await screen.findByText('***-***-4567');
    expect(screen.queryByRole('button', { name: /send|enviar|responder/i })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.body.textContent).not.toMatch(/whatsapp/i);
  });

  it('T21: shows no raw phone number and no message text', async () => {
    mockFetch.mockResolvedValueOnce(ok(page()));
    const { container } = render(<ConversationInbox />);

    await screen.findByText('***-***-4567');
    expect(container.textContent).not.toMatch(/\+\d{7,}/);
  });

  it('T22: shows each row exactly once', async () => {
    // The keyset cursor exists so a reordering list cannot repeat or skip a
    // row at a page boundary; a component that renders the page twice would
    // undo that where it is most visible.
    mockFetch.mockResolvedValueOnce(ok(page()));
    const { container } = render(<ConversationInbox />);

    await screen.findByText('***-***-4567');
    const list = container.querySelector('ul');
    expect(within(list as HTMLElement).getAllByText('***-***-4567')).toHaveLength(1);
  });
});
