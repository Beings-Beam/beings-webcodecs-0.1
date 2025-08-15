/**
 * Shared type definitions for communication between main thread and worker
 */

import type { SlowTrackRecorderConfig } from './SlowTrackRecorder';

/**
 * Audio configuration interface for the SlowTrackRecorder
 * Defines audio recording parameters for high-fidelity archival recording
 */
export interface AudioConfig {
  /** Whether audio recording is enabled */
  enabled: boolean;
  /** Audio codec to use for encoding */
  codec: 'auto' | 'opus' | 'aac' | 'mp3' | 'flac';
  /** Audio sample rate in Hz */
  sampleRate: 48000 | 44100 | 32000 | 16000;
  /** Number of audio channels (1 = mono, 2 = stereo) */
  numberOfChannels: 1 | 2;
  /** Audio bitrate in bits per second */
  bitrate: number;
}

/**
 * Message interface for communication from main thread to worker
 */
export interface RecorderWorkerRequest {
  type: 'start' | 'stop';
  config?: SlowTrackRecorderConfig & { resolutionTarget?: string };
  stream?: ReadableStream<VideoFrame>;
  audioStream?: ReadableStream<AudioData>;
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
