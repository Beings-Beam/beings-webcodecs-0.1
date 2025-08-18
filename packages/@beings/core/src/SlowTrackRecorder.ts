import type { RecorderWorkerResponse, AudioConfig, FinalEncoderConfig, RecordingResult, SyncData } from './types';

/**
 * Configuration interface for the SlowTrackRecorder
 * Defines video and audio recording parameters for the high-fidelity archival track
 */
export interface SlowTrackRecorderConfig {
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
  codec?: string;
  codecSelection?: 'auto' | 'av1' | 'hevc' | 'h264' | 'vp9';
  keyframeIntervalSeconds?: number;
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  /** Optional audio recording configuration */
  audio?: AudioConfig;
}

/**
 * Event definitions for SlowTrackRecorder lifecycle
 * Framework-agnostic event system for recording state changes
 */
export interface RecorderEvents {
  'start': () => void;
  'stop': (result: Blob) => void;
  'pause': () => void;
  'resume': () => void;
  'error': (error: Error) => void;
  'sync-update': (syncData: SyncData) => void;
}

/**
 * SlowTrackRecorder - Framework-agnostic media recording engine
 * 
 * The core of Beings' client-centric recording architecture. This class implements
 * the "Slow Track" of our dual-track capture model, focusing on high-fidelity
 * archival recording with frame-accurate time synchronization.
 * 
 * @example
 * ```typescript
 * const recorder = new SlowTrackRecorder({
 *   width: 1920,
 *   height: 1080,
 *   frameRate: 30,
 *   bitrate: 2000000
 * });
 * 
 * recorder.on('start', () => console.log('Recording started'));
 * recorder.on('stop', (blob) => console.log('Recording complete:', blob));
 * 
 * await recorder.start(mediaStream);
 * const result = await recorder.stop();
 * ```
 */
export class SlowTrackRecorder {
  #config: SlowTrackRecorderConfig;
  #listeners: Map<keyof RecorderEvents, Set<Function>> = new Map();
  #worker: Worker | null = null;
  #isRecording = false;
  #isWorkerReady = false;
  #stopPromiseResolve: ((blob: Blob) => void) | null = null;
  #stopPromiseReject: ((error: Error) => void) | null = null;
  #stopTimeout: number | null = null;
  #finalCodec: 'av1' | 'hevc' | 'h264' | 'vp9' | null = null;
  #startPromiseResolve: (() => void) | null = null;
  #startPromiseReject: ((error: Error) => void) | null = null;
  #lastResult: RecordingResult | null = null;

  /** Flag to signal processing loops to terminate early */
  #shouldStopProcessing = false;

  /** High-resolution monotonic timestamp of when recording started. The 'zero' point for the session. */
  #recordingStartTime: number | null = null;

  /** The timestamp of the very first video frame received, used as the baseline for normalization. */
  #firstVideoTimestamp: number | null = null;

  /** The timestamp of the very first audio frame received, used as the baseline for normalization. */
  #firstAudioTimestamp: number | null = null;

  /** TransformStream for processing and timestamping video frames before sending to the worker. */
  #videoTransformStream: TransformStream<VideoFrame, VideoFrame> | null = null;

  /** TransformStream for processing and timestamping audio data before sending to the worker. */
  #audioTransformStream: TransformStream<AudioData, AudioData> | null = null;

  /** Minimal diagnostic counters */
  #videoFrameCount = 0;
  #lastDiagnosticTime = 0;





  /**
   * Check if the SlowTrackRecorder is supported in the current environment
   * 
   * @returns {boolean} True if WebCodecs and required APIs are available
   */
  static isSupported(): boolean {
    const hasVideoSupport = typeof window.MediaStreamTrackProcessor !== 'undefined' &&
                           typeof window.VideoEncoder !== 'undefined';
    
    const hasAudioSupport = typeof window.AudioEncoder !== 'undefined';
    
    // Log audio capability for debugging
    if (hasVideoSupport && !hasAudioSupport) {
      console.info('SlowTrackRecorder: Video recording supported, audio recording not available');
    } else if (hasVideoSupport && hasAudioSupport) {
      console.info('SlowTrackRecorder: Both video and audio recording supported');
    }
    
    // Return true if video is supported (audio is optional enhancement)
    return hasVideoSupport;
  }

  /**
   * Validate and sanitize audio configuration
   * 
   * @param audioConfig - Audio configuration to validate
   * @returns Validated audio configuration or undefined if invalid
   */
  static #validateAudioConfig(audioConfig: AudioConfig): AudioConfig | undefined {
    try {
      // Check if AudioEncoder is available when audio is enabled
      if (audioConfig.enabled && typeof window.AudioEncoder === 'undefined') {
        console.warn('SlowTrackRecorder: Audio enabled but AudioEncoder not available, disabling audio');
        return { ...audioConfig, enabled: false };
      }

      // Validate bitrate range (8kbps to 512kbps)
      if (audioConfig.bitrate < 8000 || audioConfig.bitrate > 512000) {
        console.warn(`SlowTrackRecorder: Audio bitrate ${audioConfig.bitrate} out of range, using 128000`);
        return { ...audioConfig, bitrate: 128000 };
      }

      return audioConfig;
    } catch (error) {
      console.warn('SlowTrackRecorder: Error validating audio config:', error);
      return undefined;
    }
  }

  /**
   * Create a new SlowTrackRecorder instance
   * 
   * @param config - Recording configuration parameters
   */
  constructor(config: SlowTrackRecorderConfig) {
    // Validate and sanitize audio configuration if provided
    if (config.audio) {
      const validatedAudio = SlowTrackRecorder.#validateAudioConfig(config.audio);
      this.#config = { ...config, audio: validatedAudio };
    } else {
      this.#config = config;
    }
  }

  /**
   * Register an event listener for recorder events
   * 
   * @param event - Event type to listen for
   * @param callback - Function to call when event is emitted
   */
  on<T extends keyof RecorderEvents>(event: T, callback: RecorderEvents[T]): void {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    this.#listeners.get(event)!.add(callback);
  }

  /**
   * Remove an event listener
   * 
   * @param event - Event type to stop listening for
   * @param callback - Function to remove from listeners
   */
  off<T extends keyof RecorderEvents>(event: T, callback: RecorderEvents[T]): void {
    const listeners = this.#listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  /**
   * Emit an event to all registered listeners
   * 
   * @param event - Event type to emit
   * @param args - Arguments to pass to the event listeners
   */
  #emit<T extends keyof RecorderEvents>(event: T, ...args: Parameters<RecorderEvents[T]>): void {
    const listeners = this.#listeners.get(event);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          (callback as Function)(...args);
        } catch (error) {
          // Prevent listener errors from breaking the recorder
          console.error(`Error in ${event} event listener:`, error);
        }
      });
    }
  }

  /**
   * Handle fatal errors in processing loops with centralized cleanup
   * 
   * @param error - The error that occurred in a processing loop
   */
  #handleFatalError(error: any): void {
    // Prevent duplicate cleanup calls
    if (!this.#isRecording) {
      return;
    }

    console.error('SlowTrackRecorder: Fatal error in processing loop:', error);
    
    // Signal all loops to terminate
    this.#shouldStopProcessing = true;
    this.#isRecording = false;
    
    // Comprehensive cleanup
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
    
    // Reset all state
    this.#isWorkerReady = false;
    this.#recordingStartTime = null;
    this.#videoTransformStream = null;
    this.#audioTransformStream = null;
    this.#videoFrameCount = 0;
    this.#lastDiagnosticTime = 0;
    
    // Create proper error object and emit
    const fatalError = error instanceof Error ? error : new Error(String(error || 'Unknown processing error'));
    this.#emit('error', fatalError);
  }

  /**
   * Handle messages received from the worker
   * 
   * @param event - Message event from the worker
   */
  #handleWorkerMessage(event: MessageEvent<RecorderWorkerResponse>): void {
    try {
      switch (event.data.type) {
        case 'ready':
          this.#isWorkerReady = true;
          this.#finalCodec = event.data.finalCodec || null;
          console.log('SlowTrackRecorder: Worker ready with codec:', this.#finalCodec);
          
          // Resolve the start promise if pending
          if (this.#startPromiseResolve) {
            this.#startPromiseResolve();
            this.#startPromiseResolve = null;
            this.#startPromiseReject = null;
          }
          break;
        
        case 'file':
          this.#handleFileMessage(event.data);
          break;
        
        case 'error':
          this.#handleWorkerError(event.data.error || 'Unknown worker error');
          break;
        
        case 'sync-update':
          if (event.data.syncData) {
            this.#emit('sync-update', event.data.syncData);
          }
          break;
        
        default:
          console.warn('SlowTrackRecorder: Unknown message type from worker:', event.data);
      }
    } catch (error) {
      console.error('SlowTrackRecorder: Error handling worker message:', error);
    }
  }

  /**
   * Handle file message from worker with final video blob
   * 
   * @param data - Message data containing the video buffer
   */
  #handleFileMessage(data: RecorderWorkerResponse): void {
    if (!data.blob) {
      const error = new Error('No blob received in file message from worker');
      this.#handleWorkerError(error.message);
      return;
    }

    try {
      // Clear the timeout since we received the response
      if (this.#stopTimeout !== null) {
        clearTimeout(this.#stopTimeout);
        this.#stopTimeout = null;
      }

      // Use the blob directly from the worker (no conversion needed)
      const videoBlob = data.blob;
      
      // Store comprehensive recording result for post-recording analysis
      this.#lastResult = {
        blob: videoBlob,
        requestedConfig: { ...this.#config }, // Deep copy of the original config
        finalConfig: data.finalConfig // May be undefined if worker crashed
      };
      
      console.log('SlowTrackRecorder: Recording result stored:', {
        blobSize: videoBlob.size,
        hasFinalConfig: !!data.finalConfig,
        requestedCodec: this.#config.codecSelection,
        finalCodec: data.finalConfig?.video.codec
      });

      // Resolve the stop promise with the video blob
      if (this.#stopPromiseResolve) {
        this.#stopPromiseResolve(videoBlob);
        this.#emit('stop', videoBlob);
      }

      // Cleanup worker and reset state
      this.#cleanupStopOperation();

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.#handleWorkerError(`Failed to process video file: ${errorMessage}`);
    }
  }

  /**
   * Handle error messages from worker
   * 
   * @param errorMessage - Error message from worker
   */
  #handleWorkerError(errorMessage: string): void {
    const error = new Error(`Worker error: ${errorMessage}`);
    
    // If we have a pending start operation, reject it
    if (this.#startPromiseReject) {
      this.#startPromiseReject(error);
      this.#startPromiseResolve = null;
      this.#startPromiseReject = null;
    }
    
    // If we have a pending stop operation, reject it
    if (this.#stopPromiseReject) {
      this.#stopPromiseReject(error);
    }

    // Emit error event
    this.#emit('error', error);

    // Cleanup resources
    this.#cleanupStopOperation();
  }

  /**
   * Start recording from the provided MediaStream
   * 
   * @param stream - MediaStream to record (typically from getUserMedia or getDisplayMedia)
   * @returns Promise that resolves when recording has started
   */
  async start(stream: MediaStream): Promise<void> {
    try {
      // 1. Validate State & Set Timebase
      if (this.#isRecording) {
        throw new Error('Recording already in progress');
      }
      this.#lastResult = null;
      this.#shouldStopProcessing = false; // Reset processing flag for new recording
      this.#videoFrameCount = 0;
      this.#lastDiagnosticTime = 0;
      this.#recordingStartTime = performance.now();

      // 2. Extract Tracks
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];
      if (!videoTrack) {
        throw new Error('No video tracks found in the provided MediaStream');
      }

      const audioEnabled = this.#config.audio?.enabled === true && !!audioTrack;
      if (this.#config.audio?.enabled && !audioTrack) {
        console.warn('SlowTrackRecorder: Audio enabled in config but no audio track found in stream. Proceeding with video-only recording.');
      }

      // 3. Initialize Worker
      this.#worker = new Worker(
        new URL('./recorder.worker.ts', import.meta.url),
        { type: 'module' }
      );
      this.#worker.onmessage = this.#handleWorkerMessage.bind(this);

      // 4. Create and Manage Processing Pipeline
      // Use larger buffer to let worker handle intelligent backpressure management
      this.#videoTransformStream = new TransformStream<VideoFrame, VideoFrame>(undefined, undefined, {
        highWaterMark: 200, // Much larger buffer to prevent MediaStreamTrackProcessor throttling
        size: () => 1
      });
      const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack } as MediaStreamTrackProcessorInit);
      const videoReader = videoProcessor.readable.getReader();
      const videoWriter = this.#videoTransformStream.writable.getWriter();

      const processingPromises: Promise<void>[] = [
        this.#processVideoStream(videoReader, videoWriter)
      ];

      let audioStreamForWorker: ReadableStream<AudioData> | undefined;

      if (audioEnabled) {
        this.#audioTransformStream = new TransformStream<AudioData, AudioData>(undefined, undefined, {
          highWaterMark: 300, // Much larger buffer for audio to prevent throttling
          size: () => 1
        });
        const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack } as MediaStreamTrackProcessorInit);
        const audioReader = audioProcessor.readable.getReader();
        const audioWriter = this.#audioTransformStream.writable.getWriter();
        processingPromises.push(this.#processAudioStream(audioReader, audioWriter));
        audioStreamForWorker = this.#audioTransformStream.readable;
      }

      // Launch the processing loops in the background. If any of them fail,
      // call the centralized fatal error handler.
      Promise.all(processingPromises).catch(error => {
        this.#handleFatalError(error);
      });

      // 5. Post Message to Worker
      const message = {
        type: 'start' as const,
        config: this.#config,
        stream: this.#videoTransformStream.readable,
        audioStream: audioStreamForWorker
      };

      const transferables: Transferable[] = [this.#videoTransformStream.readable];
      if (audioStreamForWorker) {
        transferables.push(audioStreamForWorker);
      }
      this.#worker.postMessage(message, transferables);

      // 6. Await Worker Readiness
      await new Promise<void>((resolve, reject) => {
        this.#startPromiseResolve = resolve;
        this.#startPromiseReject = reject;
        setTimeout(() => {
          if (this.#startPromiseReject) {
            this.#startPromiseReject(new Error('Worker initialization timeout after 10 seconds'));
            this.#startPromiseResolve = null;
            this.#startPromiseReject = null;
          }
        }, 10000);
      });

      // 7. Finalize State
      this.#isRecording = true;
      this.#emit('start');

    } catch (error) {
      // 8. Comprehensive Cleanup on Error
      if (this.#worker) {
        this.#worker.terminate();
        this.#worker = null;
      }
      this.#isRecording = false;
      this.#shouldStopProcessing = false;
      this.#recordingStartTime = null;
      this.#videoTransformStream = null;
      this.#audioTransformStream = null;

      this.#emit('error', error instanceof Error ? error : new Error(String(error)));
      throw error; // Re-throw to caller
    }
  }

  /**
   * Stop recording and return the final video file
   * 
   * @returns Promise that resolves with the recorded video as a Blob
   */
  async stop(): Promise<Blob> {
    // Signal processing loops to terminate gracefully first
    this.#shouldStopProcessing = true;
    
    // Idempotency Check: Prevent multiple stop calls
    if (!this.#isRecording) {
      throw new Error('Recording is not currently active');
    }

    // State Change: Mark as no longer recording
    this.#isRecording = false;

    // Promise Creation: Create promise for async file return
    return new Promise<Blob>((resolve, reject) => {
      this.#stopPromiseResolve = resolve;
      this.#stopPromiseReject = reject;

      // Timeout: Ensure we don't wait forever for worker response
      this.#stopTimeout = window.setTimeout(() => {
        const timeoutError = new Error('Recording stop operation timed out');
        this.#cleanupStopOperation();
        reject(timeoutError);
        this.#emit('error', timeoutError);
      }, 10000); // 10 second timeout

      // Send Stop Command: Tell worker to finalize recording
      if (this.#worker) {
        this.#worker.postMessage({ type: 'stop' });
      } else {
        this.#cleanupStopOperation();
        reject(new Error('Worker not available for stop operation'));
      }
    });
  }

  /**
   * Clean up stop operation state and resources
   */
  #cleanupStopOperation(): void {
    // Clear timeout if it exists
    if (this.#stopTimeout !== null) {
      clearTimeout(this.#stopTimeout);
      this.#stopTimeout = null;
    }

    // Reset promise handlers
    this.#stopPromiseResolve = null;
    this.#stopPromiseReject = null;

    // Terminate and cleanup worker
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }

    // Reset state
    this.#isWorkerReady = false;
    this.#shouldStopProcessing = false;
  }

  /**
   * Pause the current recording session
   * 
   * @returns Promise that resolves when recording is paused
   */
  async pause(): Promise<void> {
    // TODO: Implement recording pause functionality
  }

  /**
   * Resume a paused recording session
   * 
   * @returns Promise that resolves when recording has resumed
   */
  async resume(): Promise<void> {
    // TODO: Implement recording resume functionality
  }

  /**
   * Get comprehensive result data for the most recently completed recording
   * 
   * @returns Recording result containing blob, requested config, and final config
   *          Returns null if no recording has been completed yet
   */
  getLastRecordingResult(): RecordingResult | null {
    return this.#lastResult;
  }

  /**
   * Get the final codec that was selected by the automatic fallback system
   * 
   * @deprecated Use getLastRecordingResult().finalConfig.video.codec instead
   * @returns The codec that is actually being used ('av1', 'hevc', 'h264', 'vp9', or null if not determined)
   */
  getFinalCodec(): 'av1' | 'hevc' | 'h264' | 'vp9' | null {
    return this.#finalCodec;
  }

  /**
   * Processes a ReadableStream of video frames, normalizes their timestamps,
   * and writes them to a WritableStream.
   * @param reader - The reader for the raw video track stream.
   * @param writer - The writer to send timestamped frames to the worker.
   */
  async #processVideoStream(
    reader: ReadableStreamDefaultReader<VideoFrame>,
    writer: WritableStreamDefaultWriter<VideoFrame>
  ): Promise<void> {
    try {
      while (true) {
        // Check if we should stop processing due to stop signal or error in another loop
        if (this.#shouldStopProcessing) {
          console.log('SlowTrackRecorder: Stop signal received, terminating video processing loop');
          break;
        }

        let readResult;
        try {
          readResult = await reader.read();
        } catch (readError) {
          // Stream was likely closed/cancelled during read - check if this is expected
          if (this.#shouldStopProcessing) {
            console.log('SlowTrackRecorder: Video stream read interrupted during stop - terminating gracefully');
            break;
          } else {
            // Unexpected read error - re-throw
            throw readError;
          }
        }

        const { done, value: frame } = readResult;

        if (done) {
          break; // The stream has ended.
        }

        // We wrap the processing of each frame to ensure the original is always closed.
        try {
          this.#videoFrameCount++;
          const now = performance.now();
          
          // Log every 5 seconds to diagnose frame rate
          if (now - this.#lastDiagnosticTime > 5000) {
            console.log(`🎬 Video frames received from MediaStreamTrackProcessor: ${this.#videoFrameCount} (${(this.#videoFrameCount / ((now - (this.#recordingStartTime || now)) / 1000)).toFixed(1)} fps)`);
            this.#lastDiagnosticTime = now;
          }
          
          // On the very first frame, capture its timestamp as the baseline for this track.
          if (this.#firstVideoTimestamp === null) {
            this.#firstVideoTimestamp = frame.timestamp;
          }

          // Calculate the normalized timestamp relative to the first frame.
          const normalizedTimestamp = frame.timestamp - this.#firstVideoTimestamp;

          // Create a new VideoFrame with the normalized timestamp, preserving other properties.
          const normalizedFrame = new VideoFrame(frame, {
            timestamp: normalizedTimestamp,
            duration: frame.duration ?? undefined, // Explicitly preserve duration as per TDD.
          });

          // Forward the newly timestamped frame to the worker.
          // Use non-blocking write to prevent main thread stalls
          writer.write(normalizedFrame).catch(writeError => {
            console.warn('SlowTrackRecorder: Video frame write failed (expected during high load):', writeError instanceof Error ? writeError.message : String(writeError));
            // Don't throw - let the worker handle backpressure
          });

        } finally {
          // CRITICAL: Close the original frame to release its underlying memory,
          // even if the processing logic above throws an error.
          frame.close();
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : (error ? String(error) : 'Unknown error');
      console.error('SlowTrackRecorder: A fatal error occurred in the video processing loop.', errorMessage);
      // Re-throw the original error to be caught by the processing promise handler.
      throw error instanceof Error ? error : new Error(errorMessage);
    } finally {
      // Signal to the worker that no more video frames are coming.
      try {
        await writer.close();
      } catch (closeError) {
        // Stream might already be in an error state, which is expected during cleanup
        console.warn('SlowTrackRecorder: Video writer close failed (expected during error cleanup):', closeError instanceof Error ? closeError.message : String(closeError));
      }
      reader.releaseLock();
    }
  }

  /**
   * Processes a ReadableStream of audio data, normalizes their timestamps,
   * and writes them to a WritableStream.
   * @param reader - The reader for the raw audio track stream.
   * @param writer - The writer to send timestamped frames to the worker.
   */
  async #processAudioStream(
    reader: ReadableStreamDefaultReader<AudioData>,
    writer: WritableStreamDefaultWriter<AudioData>
  ): Promise<void> {
    try {
      while (true) {
        // Check if we should stop processing due to stop signal or error in another loop
        if (this.#shouldStopProcessing) {
          console.log('SlowTrackRecorder: Stop signal received, terminating audio processing loop');
          break;
        }

        let readResult;
        try {
          readResult = await reader.read();
        } catch (readError) {
          // Stream was likely closed/cancelled during read - check if this is expected
          if (this.#shouldStopProcessing) {
            console.log('SlowTrackRecorder: Audio stream read interrupted during stop - terminating gracefully');
            break;
          } else {
            // Unexpected read error - re-throw
            throw readError;
          }
        }

        const { done, value: frame } = readResult;

        if (done) {
          break; // The stream has ended.
        }

        // We wrap the processing of each frame to ensure the original is always closed.
        try {
          // On the very first frame, capture its timestamp as the baseline for this track.
          if (this.#firstAudioTimestamp === null) {
            this.#firstAudioTimestamp = frame.timestamp;
          }

          // Calculate the normalized timestamp relative to the first frame.
          const normalizedTimestamp = frame.timestamp - this.#firstAudioTimestamp;

          // AudioData requires a manual copy of its underlying buffer.
          // Correctly calculate the total buffer size needed for all audio channels.
          let totalByteLength = 0;
          for (let i = 0; i < frame.numberOfChannels; i++) {
            totalByteLength += frame.allocationSize({ planeIndex: i });
          }
          const buffer = new ArrayBuffer(totalByteLength);
          const bufferView = new Uint8Array(buffer);

          // Copy the data from each channel (plane) into the new buffer sequentially.
          let offset = 0;
          for (let i = 0; i < frame.numberOfChannels; i++) {
            const planeSize = frame.allocationSize({ planeIndex: i });
            const planeBuffer = new ArrayBuffer(planeSize);
            frame.copyTo(planeBuffer, { planeIndex: i });
            
            // Copy the plane's data into the main buffer at the correct offset.
            bufferView.set(new Uint8Array(planeBuffer), offset);
            offset += planeSize;
          }

          // Create a new AudioData object with the normalized timestamp and the complete, multi-channel buffer.
          const normalizedFrame = new AudioData({
            format: frame.format || 'f32-planar', // Default to f32-planar if format is null
            sampleRate: frame.sampleRate,
            numberOfFrames: frame.numberOfFrames,
            numberOfChannels: frame.numberOfChannels,
            timestamp: normalizedTimestamp,
            data: buffer,
          });

          // Forward the newly timestamped frame to the worker.
          // Use non-blocking write to prevent main thread stalls
          writer.write(normalizedFrame).catch(writeError => {
            console.warn('SlowTrackRecorder: Audio frame write failed (expected during high load):', writeError instanceof Error ? writeError.message : String(writeError));
            // Don't throw - let the worker handle backpressure
          });

        } finally {
          // CRITICAL: Close the original frame to release its underlying memory,
          // even if the processing logic above throws an error.
          frame.close();
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : (error ? String(error) : 'Unknown error');
      console.error('SlowTrackRecorder: A fatal error occurred in the audio processing loop.', errorMessage);
      // Re-throw the error so the top-level Promise.all can catch it for cleanup.
      throw error instanceof Error ? error : new Error(errorMessage);
    } finally {
      // Signal to the worker that no more audio frames are coming.
      try {
        await writer.close();
      } catch (closeError) {
        // Stream might already be in an error state, which is expected during cleanup
        console.warn('SlowTrackRecorder: Audio writer close failed (expected during error cleanup):', closeError instanceof Error ? closeError.message : String(closeError));
      }
      reader.releaseLock();
    }
  }
}


