/**
 * Shared type definitions for communication between main thread and worker
 */

import type { SlowTrackRecorderConfig } from './SlowTrackRecorder';

/**
 * Message interface for communication from main thread to worker
 */
export interface RecorderWorkerRequest {
  type: 'start' | 'stop';
  config?: SlowTrackRecorderConfig & { resolutionTarget?: string };
  stream?: ReadableStream<VideoFrame>;
}

/**
 * Message interface for communication from worker to main thread
 */
export interface RecorderWorkerResponse {
  type: 'ready' | 'error' | 'file';
  error?: string;
  blob?: Blob;
  finalCodec?: 'av1' | 'hevc' | 'h264' | 'vp9';
}
