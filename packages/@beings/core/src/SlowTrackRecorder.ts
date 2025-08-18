import type { RecorderWorkerResponse, AudioConfig, FinalEncoderConfig, RecordingResult } from './types';

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
      // Validate State: Check if already recording
      if (this.#isRecording) {
        throw new Error('Recording already in progress');
      }
      
      // Clear previous recording result for new recording
      this.#lastResult = null;

      // Extract Tracks: Get both video and audio tracks from the stream
      const videoTracks = stream.getVideoTracks();
      const audioTracks = stream.getAudioTracks();
      
      if (videoTracks.length === 0) {
        throw new Error('No video tracks found in the provided MediaStream');
      }
      
      const videoTrack = videoTracks[0];
      const audioTrack = audioTracks.length > 0 ? audioTracks[0] : null;
      
      // Audio Configuration Check: Validate audio availability vs config
      const audioEnabled = this.#config.audio?.enabled === true;
      const hasAudio = audioTrack !== null && audioEnabled;
      
      if (audioEnabled && !audioTrack) {
        console.warn('SlowTrackRecorder: Audio enabled in config but no audio tracks found in stream, proceeding with video-only recording');
      }

      // Initialize Worker: Create new worker instance
      this.#worker = new Worker(
        new URL('./recorder.worker.ts', import.meta.url), 
        { type: 'module' }
      );

      // Attach Message Handler: Listen for messages from worker
      this.#worker.onmessage = this.#handleWorkerMessage.bind(this);

      // Create Stream Processors: Convert tracks to readable streams
      const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack } as MediaStreamTrackProcessorInit);
      const videoStream = videoProcessor.readable;
      
      let audioStream: ReadableStream<AudioData> | undefined;
      if (hasAudio) {
        try {
          const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack } as MediaStreamTrackProcessorInit);
          audioStream = audioProcessor.readable;
        } catch (error) {
          console.warn('SlowTrackRecorder: Failed to create audio processor, proceeding with video-only:', error);
          audioStream = undefined;
        }
      }

      // Post Message: Transfer streams to the worker
      const message = {
        type: 'start' as const,
        config: this.#config,
        stream: videoStream,
        audioStream: audioStream
      };
      
      const transferables: Transferable[] = [videoStream];
      if (audioStream) {
        transferables.push(audioStream);
      }
      
      this.#worker.postMessage(message, transferables);

      // Wait for worker initialization: Create promise to wait for 'ready' or 'error' message
      await new Promise<void>((resolve, reject) => {
        this.#startPromiseResolve = resolve;
        this.#startPromiseReject = reject;
        
        // Set a timeout to prevent infinite waiting
        setTimeout(() => {
          if (this.#startPromiseReject) {
            this.#startPromiseReject(new Error('Worker initialization timeout - no response from worker after 10 seconds'));
            this.#startPromiseResolve = null;
            this.#startPromiseReject = null;
          }
        }, 10000); // 10 second timeout
      });

      // Finalize State & Emit Event: Mark as recording and notify listeners
      this.#isRecording = true;
      this.#emit('start');

    } catch (error) {
      // Clean Up: Terminate worker if it exists
      if (this.#worker) {
        this.#worker.terminate();
        this.#worker = null;
      }

      // Reset State: Ensure clean state after error
      this.#isRecording = false;

      // Emit Error: Notify listeners of the error
      this.#emit('error', error instanceof Error ? error : new Error(String(error)));

      // Re-throw to maintain async error propagation
      throw error;
    }
  }

  /**
   * Stop recording and return the final video file
   * 
   * @returns Promise that resolves with the recorded video as a Blob
   */
  async stop(): Promise<Blob> {
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
}
