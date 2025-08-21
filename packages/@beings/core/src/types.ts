/**
 * Shared type definitions for communication between main thread and worker
 */

import type { SlowTrackRecorderConfig } from './SlowTrackRecorder';

/**
 * Final encoder configuration data representing what was actually used
 * This is the "ground truth" of the recording, after all fallbacks and negotiations
 */
export interface FinalEncoderConfig {
  video: VideoEncoderConfig & {
    /** Whether hardware acceleration was actually used (from browser support check) */
    hardwareAccelerationUsed?: boolean;
  };
  audio?: AudioEncoderConfig;
  /** Final container format used for muxing */
  container: 'mp4' | 'webm';
  /** Actual recording duration in milliseconds */
  duration: number;
}

/**
 * Comprehensive result object for a completed recording
 * Provides both the recorded blob and configuration comparison data
 */
export interface RecordingResult {
  /** The recorded video blob */
  blob: Blob;
  /** The configuration that was originally requested */
  requestedConfig: SlowTrackRecorderConfig;
  /** The final configuration actually used (undefined if worker crashed) */
  finalConfig?: FinalEncoderConfig;
}

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
  /** 🎯 ARCHITECTURAL REFACTOR: Direct MediaStreamTrack transfer for worker-only processing */
  videoTrack?: MediaStreamTrack;
  audioTrack?: MediaStreamTrack;
  /** Actual video track settings from MediaStreamTrack.getSettings() */
  actualVideoSettings?: MediaTrackSettings;
  /** Actual audio track settings from MediaStreamTrack.getSettings() */
  actualAudioSettings?: MediaTrackSettings;
  /** @deprecated Legacy stream-based approach - replaced by direct track transfer */
  stream?: ReadableStream<VideoFrame>;
  /** @deprecated Legacy stream-based approach - replaced by direct track transfer */
  audioStream?: ReadableStream<AudioData>;
}

/**
 * Sync diagnostics data for A/V drift detection
 */
export interface SyncData {
  videoFramesProcessed: number;
  audioFramesProcessed: number;
  drift: number;  // Calculated as audioFrames - videoFrames (positive = audio ahead)
  timestamp: number;  // Performance.now() when message was sent
}

/**
 * Backpressure status for event-driven flow control
 */
export interface BackpressureStatus {
  status: 'high' | 'low';
  videoQueueSize?: number;
  audioQueueSize?: number;
}

/**
 * Message interface for communication from worker to main thread
 */
export interface RecorderWorkerResponse {
  type: 'ready' | 'error' | 'file' | 'sync-update' | 'pressure';
  error?: string;
  blob?: Blob;
  /** Final encoder configuration data (ground truth of what was actually used) */
  finalConfig?: FinalEncoderConfig;
  /** @deprecated Use finalConfig.video.codec instead */
  finalCodec?: 'av1' | 'hevc' | 'h264' | 'vp9';
  /** Sync diagnostics data for A/V drift detection */
  syncData?: SyncData;
  /** Backpressure status for flow control */
  status?: 'high' | 'low';
  videoQueueSize?: number;
  audioQueueSize?: number;
  /** Hysteresis tracking for backpressure management */
  consecutiveCount?: number;
  backoffMultiplier?: number;
  cooldownStartTime?: number;
}
