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
  | { type: 'progress'; message: string }
  | { type: 'done'; result: SwapResult }
  | { type: 'error'; message: string };

self.onmessage = (event: MessageEvent<SwapWorkerRequest>) => {
  const post = (message: SwapWorkerMessage) => self.postMessage(message);
  post({ type: 'progress', message: 'Checking possible swaps and working-time limits' });
  try {
    post({ type: 'done', result: findSwaps(event.data.profile, event.data.snapshot, event.data.settings, event.data.request) });
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
