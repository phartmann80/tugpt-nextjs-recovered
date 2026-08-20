// @vitest-environment jsdom
/**
 * @file DraftReviewUi.test.tsx
 * @description Behavioural tests for the human-review UI — the browser path a
 * real reviewer uses.
 *
 * REWRITTEN 2026-08-19. The previous version of this file had nine passing
 * tests and rendered nothing. They asserted `expect(DraftActions).toBeDefined()`
 * and re-read mocks they had just configured (`mockResolvedValueOnce({status:
 * 503})` followed by `expect(res.status).toBe(503)`, which tests vitest), with
 * comments saying the real behaviour was "verified by code inspection".
 *
 * Code inspection missed that clicking Edit opened an empty textarea, so a
 * reviewer had to retype the whole AI draft to change one word — in a product
 * whose entire premise is AI drafts plus human edit. The milestone-1 harness
 * could not catch it either: it calls edit_draft directly with a body and never
 * touches the UI.
 *
 * So these tests render the components and drive them the way a reviewer does.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DraftDetail } from './DraftDetail';
import { DraftActions } from './DraftActions';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// The sub-histories issue their own fetches; they are not what these tests are
// about, so stub them to render nothing.
vi.mock('./DraftRevisionHistory', () => ({ DraftRevisionHistory: () => null }));
vi.mock('./DraftEventHistory', () => ({ DraftEventHistory: () => null }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const DRAFT_ID = '11111111-1111-1111-1111-111111111111';
const DRAFT_BODY = 'Hello! We are open until 6pm today. Would you like to book a slot?';

function draftPayload(overrides: Record<string, unknown> = {}) {
  return {
    draft: {
      id: DRAFT_ID,
      status: 'draft',
      version: 3,
      provider: 'langdock',
      model: 'gpt-5-mini',
      created_at: '2026-08-19T10:00:00Z',
      updated_at: '2026-08-19T10:00:00Z',
      current_revision_body: DRAFT_BODY,
      ...overrides,
    },
  };
}

const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const jsonErr = (status: number, code: string, message: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { code, message } }),
});

const textareaValue = (): string => (screen.getByRole('textbox') as HTMLTextAreaElement).value;

/** Render DraftDetail and wait for its initial load to settle. */
async function renderDetail(payload = draftPayload()) {
  mockFetch.mockResolvedValueOnce(jsonOk(payload));
  render(<DraftDetail draftId={DRAFT_ID} />);
  await screen.findByText('Draft Review');
}

/** The JSON body of the request sent to a given endpoint suffix. */
function requestBodyFor(suffix: string): Record<string, unknown> {
  const call = mockFetch.mock.calls.find((c) => String(c[0]).endsWith(suffix));
  if (!call) throw new Error(`no request to ${suffix}`);
  return JSON.parse((call[1] as RequestInit).body as string);
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('editing a draft', () => {
  it('pre-fills the editor with the current draft body', async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Before 2026-08-19 the textarea
    // opened empty, so a one-word correction meant retyping the whole draft.
    const user = userEvent.setup();
    await renderDetail();

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    expect(textareaValue()).toBe(DRAFT_BODY);
  });

  it('sends the edited body and the current version', async () => {
    const user = userEvent.setup();
    await renderDetail();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'Rewritten by the reviewer.');

    mockFetch.mockResolvedValueOnce(jsonOk({ draft: { version: 4 } }));
    mockFetch.mockResolvedValueOnce(jsonOk(draftPayload({ version: 4 })));
    await user.click(screen.getByRole('button', { name: 'Save Edit' }));

    await waitFor(() =>
      expect(requestBodyFor('/edit')).toEqual({
        expectedLockVersion: 3,
        body: 'Rewritten by the reviewer.',
      })
    );
  });

  it('refuses to submit an empty body without calling the API', async () => {
    const user = userEvent.setup();
    await renderDetail();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByRole('textbox'));

    const callsBefore = mockFetch.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Save Edit' }));

    expect(await screen.findByText('Draft body must not be empty')).toBeTruthy();
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it('discards changes on cancel, and reopens from the current body again', async () => {
    const user = userEvent.setup();
    await renderDetail();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'scratch');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(textareaValue()).toBe(DRAFT_BODY);
  });
});

describe('approving and rejecting', () => {
  it('approve posts the current version to the approve endpoint', async () => {
    const user = userEvent.setup();
    await renderDetail();

    mockFetch.mockResolvedValueOnce(jsonOk({ draft: { status: 'approved' } }));
    mockFetch.mockResolvedValueOnce(jsonOk(draftPayload({ status: 'approved', version: 4 })));
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(requestBodyFor('/approve')).toEqual({ expectedLockVersion: 3 }));
  });

  it('reject posts the current version to the reject endpoint', async () => {
    const user = userEvent.setup();
    await renderDetail();

    mockFetch.mockResolvedValueOnce(jsonOk({ draft: { status: 'rejected' } }));
    mockFetch.mockResolvedValueOnce(jsonOk(draftPayload({ status: 'rejected', version: 4 })));
    await user.click(screen.getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(requestBodyFor('/reject')).toEqual({ expectedLockVersion: 3 }));
  });

  it('shows the stale-version banner on 409, with a reload action', async () => {
    const user = userEvent.setup();
    await renderDetail();

    mockFetch.mockResolvedValueOnce(jsonErr(409, 'STALE_VERSION', 'stale'));
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText(/modified by another reviewer/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('shows a permission message on 403 rather than a generic error', async () => {
    const user = userEvent.setup();
    await renderDetail();

    mockFetch.mockResolvedValueOnce(jsonErr(403, 'FORBIDDEN', 'forbidden'));
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText(/do not have permission/i)).toBeTruthy();
  });

  it('surfaces the API message on any other failure', async () => {
    const user = userEvent.setup();
    await renderDetail();

    mockFetch.mockResolvedValueOnce(
      jsonErr(422, 'INVALID_STATE_TRANSITION', 'This draft cannot be modified in its current state')
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(
      await screen.findByText('This draft cannot be modified in its current state')
    ).toBeTruthy();
  });
});

describe('the version a second action uses', () => {
  it('does not leave an action button live on the pre-edit version', async () => {
    // After an edit the draft is on version 4, but the parent refetch is
    // asynchronous. If the buttons stayed live during that window, an
    // immediate Approve would send version 3 and come back 409 "modified by
    // another reviewer" — blaming a second reviewer for the first one's own
    // edit, which is the most confusing message the UI could produce.
    const user = userEvent.setup();
    await renderDetail();

    await user.click(screen.getByRole('button', { name: 'Edit' }));

    let resolveRefetch: (value: unknown) => void = () => {};
    mockFetch.mockResolvedValueOnce(jsonOk({ draft: { version: 4 } }));
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefetch = resolve;
      })
    );

    await user.click(screen.getByRole('button', { name: 'Save Edit' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull());

    resolveRefetch(jsonOk(draftPayload({ version: 4 })));
    await screen.findByRole('button', { name: 'Approve' });
  });
});

describe('what the UI must never offer', () => {
  it('renders no Send or WhatsApp control on a reviewable draft', async () => {
    // Outbound customer messaging does not exist yet and requires explicit
    // owner approval. A real DOM assertion, not a comment.
    await renderDetail();

    expect(screen.queryByRole('button', { name: /send/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /whatsapp/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/whatsapp/i);
  });

  it('renders no action buttons at all for an approved draft', async () => {
    await renderDetail(draftPayload({ status: 'approved' }));

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByText('Approved')).toBeTruthy();
  });

  it('renders no action buttons at all for a rejected draft', async () => {
    await renderDetail(draftPayload({ status: 'rejected' }));

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.getByText('Rejected')).toBeTruthy();
  });
});

describe('states the reviewer can land in', () => {
  it('explains that the feature is unavailable on 503', async () => {
    mockFetch.mockResolvedValueOnce(jsonErr(503, 'FEATURE_UNAVAILABLE', 'unavailable'));
    render(<DraftDetail draftId={DRAFT_ID} />);

    expect(
      await screen.findByText(/not currently available for your organization/i)
    ).toBeTruthy();
  });

  it('offers a way back to the inbox when the draft is not found', async () => {
    mockFetch.mockResolvedValueOnce(jsonErr(404, 'DRAFT_NOT_FOUND', 'nope'));
    render(<DraftDetail draftId={DRAFT_ID} />);

    expect(await screen.findByText('Draft not found.')).toBeTruthy();
    expect(screen.getByText('Back to inbox')).toBeTruthy();
  });

  it('shows the draft body and its model attribution', async () => {
    await renderDetail();

    expect(screen.getByText(DRAFT_BODY)).toBeTruthy();
    expect(screen.getByText('Provider: langdock')).toBeTruthy();
    expect(screen.getByText('Model: gpt-5-mini')).toBeTruthy();
  });
});

describe('DraftActions in isolation', () => {
  it('starts the editor from the body it is given', async () => {
    const user = userEvent.setup();
    render(
      <DraftActions
        draftId={DRAFT_ID}
        version={2}
        currentBody="the body under review"
        onActionComplete={() => {}}
        onStaleVersion={() => {}}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(textareaValue()).toBe('the body under review');
  });

  it('tolerates a draft with no readable body', async () => {
    const user = userEvent.setup();
    render(
      <DraftActions
        draftId={DRAFT_ID}
        version={2}
        currentBody={null}
        onActionComplete={() => {}}
        onStaleVersion={() => {}}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(textareaValue()).toBe('');
  });
});
