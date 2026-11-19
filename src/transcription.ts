/**
 * Transcription interface and a deterministic fake for tests.
 *
 * A real implementation would call Whisper, AssemblyAI, etc.
 * The interface is intentionally narrow: give it a media ID (the
 * WhatsApp media object ID), get back a transcript string.
 */

export interface Transcriber {
  transcribe(mediaId: string): Promise<string>;
}

/**
 * FakeTranscriber resolves a media ID against a pre-loaded map.
 * Unknown IDs resolve to an empty string so callers can handle
 * "nothing heard" without crashing.
 */
export class FakeTranscriber implements Transcriber {
  private readonly map: Map<string, string>;

  constructor(entries: Record<string, string> = {}) {
    this.map = new Map(Object.entries(entries));
  }

  async transcribe(mediaId: string): Promise<string> {
    return this.map.get(mediaId) ?? '';
  }

  /** Add or replace an entry at runtime (useful inside tests). */
  set(mediaId: string, transcript: string): void {
    this.map.set(mediaId, transcript);
  }
}
