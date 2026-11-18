/// <reference lib="webworker" />
import { findSwaps, type RotaSnapshot, type SwapRequest, type SwapResult, type SwapSettings } from '../engine/swaps';
import type { Profile } from '../engine/types';

export interface SwapWorkerRequest {
  profile: Profile;
  snapshot: RotaSnapshot;
  settings: SwapSettings;
  request: SwapRequest;
}

export type SwapWorkerMessage =
  | { type: 'progress'; message: string; optionsFound?: number; partialResult?: SwapResult }
  | { type: 'done'; result: SwapResult }
  | { type: 'error'; message: string };

self.onmessage = (event: MessageEvent<SwapWorkerRequest>) => {
  const post = (message: SwapWorkerMessage) => self.postMessage(message);
  let lastPartialSentAt = 0;
  try {
    const result = findSwaps(event.data.profile, event.data.snapshot, event.data.settings, event.data.request, update => {
      const now = Date.now();
      const partialResult = update.partialResult && now - lastPartialSentAt >= 300 ? update.partialResult : undefined;
      if (partialResult) lastPartialSentAt = now;
      post({ type: 'progress', message: `${update.stage}… ${update.optionsFound} options found so far`, optionsFound: update.optionsFound, ...(partialResult ? { partialResult } : {}) });
    });
    post({ type: 'done', result });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
