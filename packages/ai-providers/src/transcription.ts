/**
 * @file transcription.ts
 * @description Speech-to-text capability contract for TuGPT.
 *
 * WHY THIS IS A SEPARATE INTERFACE, NOT A WIDER `AIProviderAdapter`
 *
 * ADR-006 and `adapter.ts:6-15` both say that expanding `AIProviderAdapter`
 * beyond `generateCompletion` — to streaming, tool calls, embeddings, or
 * speech-to-text — requires a capability-based architecture review, and that
 * the contract must not grow by ad-hoc addition.
 *
 * Transcription is a different capability, not a wider completion. Bending it
 * into `generateCompletion` would mean a method whose `messages` parameter is
 * ignored, whose `temperature` is meaningless, and whose `usage` reports token
 * counts for a call that is billed by the second. Every consumer would then
 * have to know which kind of provider it was holding anyway — so the type
 * would be lying without saving anyone a branch.
 *
 * A provider may implement both interfaces. Nothing here widens the existing
 * contract, so ADR-006's review boundary stays where it is.
 */

/**
 * Where the audio lives.
 *
 * A URL rather than bytes: the async transcription APIs fetch the media
 * themselves, and streaming a WhatsApp voice note through the worker's memory
 * to re-upload it would add a copy, a size limit, and a failure mode for no
 * gain. The URL must be reachable by the provider, which is a deployment
 * property worth stating out loud rather than discovering from a 4xx.
 */
export interface AudioSource {
  readonly url: string;
  /** Optional MIME type, when the URL does not make it obvious. */
  readonly contentType?: string;
}

export interface TranscriptionOptions {
  readonly organizationId?: string;
  readonly requestId?: string;
  /**
   * Cancellation. Aborting stops both the submission and the polling loop and
   * surfaces as a `ProviderError` with category 'TIMEOUT'.
   *
   * Note that aborting does NOT cancel the provider's job. If submission has
   * already succeeded, the work is billed whether or not anyone reads the
   * result — see {@link TranscriptionProvider.transcribe}.
   */
  readonly signal?: AbortSignal;
  /** BCP-47 hint, e.g. 'es'. Providers treat this as a hint, not a constraint. */
  readonly languageHint?: string;
  /** How often to poll for a finished job. Provider default applies when unset. */
  readonly pollIntervalMs?: number;
  /** Ceiling on total wait before 'TIMEOUT'. Provider default applies when unset. */
  readonly maxWaitMs?: number;
}

/**
 * What the call will be billed for.
 *
 * `billingSeconds` and `audioSeconds` are two different numbers and the
 * difference matters. Gladia defines its billed quantity as
 * `audio_duration × number_of_distinct_channels`, so a stereo recording bills
 * twice its wall-clock length. A cost model that stored "seconds of audio" and
 * multiplied by the rate would understate every stereo file by 100%, and the
 * way you would find out is the invoice.
 *
 * So the rule, which generalises past Gladia: **record the quantity the
 * provider says it will bill, not the quantity we measured.** `billingSeconds`
 * is what reaches `record_provider_usage`; `audioSeconds` is kept beside it
 * because the difference between the two is exactly the thing worth being able
 * to see.
 */
export interface TranscriptionUsage {
  /** The provider's own billed quantity, in seconds. Authoritative for cost. */
  readonly billingSeconds: number;
  /** Wall-clock length of the audio, in seconds. Metadata, never priced. */
  readonly audioSeconds: number;
  /** Distinct channels the provider found. */
  readonly channels: number;
}

export interface TranscriptionResult {
  /** The provider's own id for the job. Required to match an invoice line. */
  readonly id: string;
  readonly provider: string;
  /** The model, when the provider names one. Transcription often does not. */
  readonly model: string | null;
  /**
   * The transcript.
   *
   * MAY BE EMPTY, and an empty transcript is not an error here. A silent or
   * inaudible voice note transcribes to nothing, and the provider bills for it
   * regardless. Throwing would lose the billing row for work that was really
   * performed, so the adapter reports faithfully and the decision about what
   * to do with an empty transcript belongs where drafts are enqueued — beside
   * the `body_text IS NOT NULL` gate that already makes exactly this call for
   * typed messages.
   */
  readonly text: string;
  /** Detected language, when the provider reports one. */
  readonly languageCode?: string;
  readonly usage: TranscriptionUsage;
  /** Wall-clock time this adapter spent, including polling. Not billed time. */
  readonly latencyMs: number;
}

/** A job the provider has accepted but not yet finished. */
export interface TranscriptionSubmission {
  /**
   * The provider's job id.
   *
   * PERSIST THIS BEFORE WAITING. Once submission succeeds the work is billed,
   * so a caller that loses the id and resubmits pays twice for one voice note.
   * The id is the idempotency handle: after a timeout, resume polling it —
   * never resubmit the audio.
   */
  readonly id: string;
  readonly provider: string;
}

export interface TranscriptionProvider {
  readonly providerName: string;

  /**
   * Hand the audio to the provider and return as soon as it is accepted.
   *
   * Separate from waiting because the two halves have different failure
   * consequences: a failed submission costs nothing, and a failed wait has
   * already been paid for.
   */
  submit(audio: AudioSource, options?: TranscriptionOptions): Promise<TranscriptionSubmission>;

  /** Poll an accepted job to completion. Safe to call repeatedly for one id. */
  awaitResult(id: string, options?: TranscriptionOptions): Promise<TranscriptionResult>;

  /**
   * `submit` then `awaitResult`.
   *
   * `onSubmitted` fires the moment the provider returns an id, before any
   * waiting. It exists so a caller can persist the id inside the same call —
   * without it, every timeout during polling loses the handle to work that has
   * already been billed, and the only available recovery is to pay again.
   * Anything it throws propagates, and deliberately so: if the id could not be
   * recorded, waiting for a result nobody can later resume is the worse
   * outcome.
   */
  transcribe(
    audio: AudioSource,
    options?: TranscriptionOptions & { readonly onSubmitted?: (id: string) => void | Promise<void> }
  ): Promise<TranscriptionResult>;
}
