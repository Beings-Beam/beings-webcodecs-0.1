import type { 
  RecorderWorkerResponse, 
  VideoWorkerRequest, 
  VideoWorkerResponse,
  AudioWorkerRequest, 
  AudioWorkerResponse,
  AudioConfig, 
  FinalEncoderConfig, 
  RecordingResult, 
  SyncData 
} from './types';

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
 * ## Dual-Worker Architecture (v1.1+)
 * 
 * This implementation uses a sophisticated dual-worker architecture to eliminate
 * performance bottlenecks and achieve true parallel processing:
 * 
 * - **Main Thread (Conductor)**: Manages worker lifecycle, buffers encoded chunks,
 *   and performs final A/V synchronization and muxing
 * - **Video Worker**: Dedicated thread for video frame processing, encoding, and
 *   optional downscaling operations (handles ~30fps without audio interference)
 * - **Audio Worker**: Dedicated thread for high-frequency audio processing 
 *   (handles 48kHz sample rates = 1000+ frames/second)
 * 
 * This architecture prevents resource contention where high-frequency audio
 * processing would previously starve the video encoder, causing frame drops
 * and A/V desynchronization.
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
  
  // Dual worker architecture
  #videoWorker: Worker | null = null;
  #audioWorker: Worker | null = null;
  #isVideoWorkerReady = false;
  #isAudioWorkerReady = false;
  
  // Chunk buffering for main thread muxing
  #videoChunks: EncodedVideoChunk[] = [];
  #audioChunks: EncodedAudioChunk[] = [];
  #chunkMetadata = new Map<EncodedVideoChunk | EncodedAudioChunk, any>();
  
  #isRecording = false;
  #stopPromiseResolve: ((blob: Blob) => void) | null = null;
  #stopPromiseReject: ((error: Error) => void) | null = null;
  #stopTimeout: number | null = null;
  #finalVideoCodec: 'av1' | 'hevc' | 'h264' | 'vp9' | null = null;
  #finalAudioCodec: 'opus' | 'aac' | 'mp3' | 'flac' | null = null;
  #startPromiseResolve: (() => void) | null = null;
  #startPromiseReject: ((error: Error) => void) | null = null;
  #lastResult: RecordingResult | null = null;
  
  /** @deprecated Use #finalVideoCodec instead */
  #finalCodec: 'av1' | 'hevc' | 'h264' | 'vp9' | null = null;

  /** High-resolution monotonic timestamp of when recording started */
  #recordingStartTime: number | null = null;

  /** Diagnostic counters for performance monitoring */
  #videoFrameCount = 0;
  #lastDiagnosticTime = 0;
  
  /** Video worker backpressure coordination */
  #isPumpPaused = false;
  #pressureHighTimestamp: number | null = null;
  #performanceCheckInterval: number | null = null;
  
  /** User feedback system for performance warnings */
  #firstLevelWarningShown = false;
  #secondLevelWarningShown = false;

  /** Frame leak detector for monitoring (diagnostic purposes) */
  #activeFrames = new Set<VideoFrame>();
  #leakMonitorInterval: number | null = null;
  
  /** Legacy compatibility flag */
  #shouldStopProcessing = false;





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
   * Handle fatal errors in dual-worker processing
   * 
   * @param error - The error that occurred
   */
  #handleFatalError(error: any): void {
    // Prevent duplicate cleanup calls
    if (!this.#isRecording) {
      return;
    }

    console.error('SlowTrackRecorder: Fatal error in dual-worker processing:', error);
    
    // Signal all loops to terminate
    this.#shouldStopProcessing = true;
    this.#isRecording = false;
    
    // Cleanup dual workers
    this.#cleanupDualWorkers();
    
    // Reset all state
    this.#recordingStartTime = null;
    this.#videoFrameCount = 0;
    this.#lastDiagnosticTime = 0;
    
    // Create proper error object and emit
    const fatalError = error instanceof Error ? error : new Error(String(error || 'Unknown processing error'));
    this.#emit('error', fatalError);
  }

  /**
   * Handle messages received from the video worker
   * 
   * @param event - Message event from the video worker
   */
  #handleVideoWorkerMessage(event: MessageEvent<VideoWorkerResponse>): void {
    try {
      switch (event.data.type) {
        case 'ready':
          this.#isVideoWorkerReady = true;
          this.#finalVideoCodec = event.data.finalCodec || null;
          this.#finalCodec = this.#finalVideoCodec; // Backward compatibility
          console.log('SlowTrackRecorder: Video worker ready with codec:', this.#finalVideoCodec);
          
          // Check if both workers are ready
          this.#checkWorkersReady();
          break;
        
        case 'video-chunk':
          if (event.data.chunk) {
            this.#videoChunks.push(event.data.chunk);
            if (event.data.metadata) {
              this.#chunkMetadata.set(event.data.chunk, event.data.metadata);
            }
            // Log first few chunks for startup diagnostics
            if (this.#videoChunks.length <= 3) {
              console.log(`SlowTrackRecorder: Video chunk ${this.#videoChunks.length} received (${event.data.chunk.byteLength} bytes)`);
            }
          }
          break;
        
        case 'pressure':
          this.#handleVideoBackpressureMessage(event.data);
          break;
        
        case 'error':
          this.#handleVideoWorkerError(event.data.error || 'Unknown video worker error');
          break;
        
        case 'complete':
          console.log('SlowTrackRecorder: Video worker completed');
          break;
        
        default:
          console.warn('SlowTrackRecorder: Unknown message type from video worker:', event.data);
      }
    } catch (error) {
      console.error('SlowTrackRecorder: Error handling video worker message:', error);
    }
  }

  /**
   * Handle messages received from the audio worker
   * 
   * @param event - Message event from the audio worker
   */
  #handleAudioWorkerMessage(event: MessageEvent<AudioWorkerResponse>): void {
    try {
      switch (event.data.type) {
        case 'ready':
          this.#isAudioWorkerReady = true;
          this.#finalAudioCodec = event.data.finalCodec || null;
          console.log('SlowTrackRecorder: Audio worker ready with codec:', this.#finalAudioCodec);
          
          // Check if both workers are ready
          this.#checkWorkersReady();
          break;
        
        case 'audio-chunk':
          if (event.data.chunk) {
            this.#audioChunks.push(event.data.chunk);
            if (event.data.metadata) {
              this.#chunkMetadata.set(event.data.chunk, event.data.metadata);
            }
            // Log first few chunks for startup diagnostics
            if (this.#audioChunks.length <= 3) {
              console.log(`SlowTrackRecorder: Audio chunk ${this.#audioChunks.length} received (${event.data.chunk.byteLength} bytes)`);
            }
          }
          break;
        
        case 'error':
          this.#handleAudioWorkerError(event.data.error || 'Unknown audio worker error');
          break;
        
        case 'complete':
          console.log('SlowTrackRecorder: Audio worker completed');
          break;
        
        default:
          console.warn('SlowTrackRecorder: Unknown message type from audio worker:', event.data);
      }
    } catch (error) {
      console.error('SlowTrackRecorder: Error handling audio worker message:', error);
    }
  }

  /**
   * Check if both workers are ready and resolve start promise
   */
  #checkWorkersReady(): void {
    const audioEnabled = this.#config.audio?.enabled === true;
    const bothReady = this.#isVideoWorkerReady && (!audioEnabled || this.#isAudioWorkerReady);
    
    if (bothReady && this.#startPromiseResolve) {
      console.log('SlowTrackRecorder: Both workers ready, starting recording');
      this.#startPromiseResolve();
      this.#startPromiseResolve = null;
      this.#startPromiseReject = null;
    }
  }





  /**
   * Handle backpressure messages from video worker
   * 
   * @param data - Backpressure message data from video worker
   */
  #handleVideoBackpressureMessage(data: VideoWorkerResponse): void {
    const encoderQueue = data.queueSize || 0;
    const isImmediate = data.immediate || false;
    
    if (data.status === 'high') {
      const hysteresisInfo = data.consecutiveCount ? ` (attempt ${data.consecutiveCount})` : '';
      const immediateInfo = isImmediate ? ' [IMMEDIATE]' : '';
      console.warn(`SlowTrackRecorder: Video encoder backpressure HIGH${hysteresisInfo}${immediateInfo} (queue: ${encoderQueue})`);
      
      this.#isPumpPaused = true;
      if (this.#pressureHighTimestamp === null) {
        this.#pressureHighTimestamp = performance.now();
        this.#startPerformanceMonitoring();
      }
      
      if (isImmediate) {
        console.warn(`SlowTrackRecorder: 🚨 IMMEDIATE video encoder overload detected`);
      }
    } else if (data.status === 'low') {
      const immediateInfo = isImmediate ? ' [IMMEDIATE]' : '';
      console.log(`SlowTrackRecorder: Video encoder backpressure LOW${immediateInfo} (queue: ${encoderQueue})`);
      
      this.#isPumpPaused = false;
      this.#pressureHighTimestamp = null;
      this.#stopPerformanceMonitoring();
      
      if (isImmediate) {
        console.log(`SlowTrackRecorder: ✅ IMMEDIATE video encoder recovery detected`);
      }
    }
  }

  /**
   * Handle error messages from video worker
   */
  #handleVideoWorkerError(errorMessage: string): void {
    const error = new Error(`Video worker error: ${errorMessage}`);
    console.error('SlowTrackRecorder: Video worker error:', errorMessage);
    
    if (this.#startPromiseReject) {
      this.#startPromiseReject(error);
      this.#startPromiseResolve = null;
      this.#startPromiseReject = null;
    }
    
    if (this.#stopPromiseReject) {
      this.#stopPromiseReject(error);
    }
    
    this.#emit('error', error);
    this.#cleanupDualWorkers();
  }

  /**
   * Handle error messages from audio worker
   */
  #handleAudioWorkerError(errorMessage: string): void {
    const error = new Error(`Audio worker error: ${errorMessage}`);
    console.error('SlowTrackRecorder: Audio worker error:', errorMessage);
    
    // Audio errors are less critical - disable audio and continue with video-only
    console.warn('SlowTrackRecorder: Disabling audio due to worker error, continuing with video-only recording');
    
    if (this.#audioWorker) {
      this.#audioWorker.terminate();
      this.#audioWorker = null;
    }
    this.#isAudioWorkerReady = false;
    
    // Check if video worker is ready to continue
    this.#checkWorkersReady();
  }

  /**
   * Start monitoring for prolonged backpressure and provide measured user feedback
   * Uses a two-stage warning system with professional, non-alarming messaging
   */
  #startPerformanceMonitoring(): void {
    if (this.#performanceCheckInterval !== null) {
      return; // Already monitoring
    }

    this.#performanceCheckInterval = window.setInterval(() => {
      if (!this.#pressureHighTimestamp) return;
      
      const duration = performance.now() - this.#pressureHighTimestamp;
      const durationSeconds = Math.round(duration / 1000);
      
      // First-level warning: 12 seconds (measured, non-alarming)
      if (duration > 12000 && !this.#firstLevelWarningShown) {
        this.#firstLevelWarningShown = true;
        const message = 'Performance notice: Recording quality may be reduced due to system load. This will not affect your current recording.';
        
        console.info(`SlowTrackRecorder: ${message} (${durationSeconds}s backpressure)`);
        // Emit as info event, not error
        this.#emit('error', new Error(message));
      }
      
      // Second-level warning: 25 seconds (continued guidance)
      if (duration > 25000 && !this.#secondLevelWarningShown) {
        this.#secondLevelWarningShown = true;
        const message = 'Continued performance constraints detected. For optimal quality in future recordings, consider closing other applications or reducing recording resolution.';
        
        console.info(`SlowTrackRecorder: ${message} (${durationSeconds}s backpressure)`);
        // Emit as info event, not error
        this.#emit('error', new Error(message));
      }
      
      // Log periodic updates for debugging without user notification
      if (duration > 30000 && durationSeconds % 10 === 0) {
        console.log(`SlowTrackRecorder: Backpressure continues (${durationSeconds}s) - system adapting quality gracefully`);
      }
    }, 1000); // Check every second
  }

  /**
   * Stop performance monitoring and reset warning state
   */
  #stopPerformanceMonitoring(): void {
    if (this.#performanceCheckInterval !== null) {
      clearInterval(this.#performanceCheckInterval);
      this.#performanceCheckInterval = null;
    }
    
    // Reset warning flags for next backpressure event
    this.#firstLevelWarningShown = false;
    this.#secondLevelWarningShown = false;
  }

  /**
   * 🎯 SURGICAL STRIKE: Start lightweight frame leak monitoring
   * This is our "poor man's leak detector" that will immediately expose frame leaks
   */
  #startLeakMonitoring(): void {
    if (this.#leakMonitorInterval !== null) {
      clearInterval(this.#leakMonitorInterval);
    }

    this.#leakMonitorInterval = window.setInterval(() => {
      const activeCount = this.#activeFrames.size;
      
      if (activeCount > 50) {
        console.error(`🚨 CRITICAL FRAME LEAK DETECTED! In-flight frames: ${activeCount}`);
        console.error('🚨 This confirms a memory leak in the video processing pipeline');
        
        // Additional diagnostic info
        console.error('🚨 Leak Details:', {
          activeFramesCount: activeCount,
          isRecording: this.#isRecording,
          isPumpPaused: this.#isPumpPaused,
          videoFrameCount: this.#videoFrameCount
        });
      } else if (activeCount > 20) {
        console.warn(`⚠️ High frame count detected: ${activeCount} frames in-flight`);
      } else if (activeCount > 0) {
        console.log(`📊 LEAK DETECTOR: ${activeCount} frames in-flight (main thread tracking)`);
      } else {
        console.log(`📊 LEAK DETECTOR: 0 frames in-flight - main thread clean`);
      }
    }, 1000); // Check every second for more frequent updates
  }

  /**
   * 🎯 SURGICAL STRIKE: Stop leak monitoring and cleanup
   */
  #stopLeakMonitoring(): void {
    if (this.#leakMonitorInterval !== null) {
      clearInterval(this.#leakMonitorInterval);
      this.#leakMonitorInterval = null;
    }

    // Final leak report
    const remainingFrames = this.#activeFrames.size;
    if (remainingFrames > 0) {
      console.warn(`🚨 LEAK DETECTED AT SHUTDOWN: ${remainingFrames} frames were never cleaned up`);
      
      // Emergency cleanup - close any remaining frames
      let closedCount = 0;
      for (const frame of this.#activeFrames) {
        try {
          frame.close();
          closedCount++;
        } catch (error) {
          console.warn('Failed to close leaked frame:', error);
        }
      }
      console.warn(`🧹 Emergency cleanup: closed ${closedCount} leaked frames`);
    }
    
    this.#activeFrames.clear();
  }



  /**
   * Handle error messages from legacy single worker (deprecated)
   * @deprecated Use #handleVideoWorkerError and #handleAudioWorkerError instead
   * 
   * @param errorMessage - Error message from worker
   */
  #handleWorkerError(errorMessage: string): void {
    const error = new Error(`Legacy worker error: ${errorMessage}`);
    
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
   * Start recording from the provided MediaStream using dual-worker architecture
   * 
   * @param stream - MediaStream to record (typically from getUserMedia or getDisplayMedia)
   * @returns Promise that resolves when recording has started
   */
  async start(stream: MediaStream): Promise<void> {
    try {
      // 1. Validate State & Setup
      if (this.#isRecording) {
        throw new Error('Recording already in progress');
      }
      
      this.#lastResult = null;
      this.#shouldStopProcessing = false;
      this.#videoFrameCount = 0;
      this.#lastDiagnosticTime = 0;
      this.#recordingStartTime = performance.now();
      
      // Clear chunk buffers
      this.#videoChunks = [];
      this.#audioChunks = [];
      this.#chunkMetadata.clear();
      
      // Reset backpressure state
      this.#isPumpPaused = false;
      this.#pressureHighTimestamp = null;
      this.#stopPerformanceMonitoring();
      
      // Reset user feedback state
      this.#firstLevelWarningShown = false;
      this.#secondLevelWarningShown = false;
      
      console.log('SlowTrackRecorder: 🚀 Starting dual-worker architecture');

      // 2. Extract and Validate Tracks
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];
      if (!videoTrack) {
        throw new Error('No video tracks found in the provided MediaStream');
      }

      const videoSettings = videoTrack.getSettings();
      const audioEnabled = this.#config.audio?.enabled === true && !!audioTrack;
      let audioSettings: MediaTrackSettings | null = null;
      
      console.log('SlowTrackRecorder: 🔍 Video Track Settings:', {
        width: videoSettings.width,
        height: videoSettings.height,
        frameRate: videoSettings.frameRate
      });

      if (audioEnabled && audioTrack) {
        audioSettings = audioTrack.getSettings();
        console.log('SlowTrackRecorder: 🔍 Audio Track Settings:', {
          sampleRate: audioSettings.sampleRate,
          channelCount: audioSettings.channelCount
        });
      }

      // 3. Create and Setup Video Worker
      console.log('SlowTrackRecorder: Creating video worker...');
      this.#videoWorker = new Worker(
        new URL('./video.worker.ts', import.meta.url),
        { type: 'module' }
      );
      this.#videoWorker.onmessage = (event) => this.#handleVideoWorkerMessage(event);

      // 4. Create and Setup Audio Worker (if audio enabled)
      if (audioEnabled && audioTrack) {
        console.log('SlowTrackRecorder: Creating audio worker...');
        this.#audioWorker = new Worker(
          new URL('./audio.worker.ts', import.meta.url),
          { type: 'module' }
        );
        this.#audioWorker.onmessage = (event) => this.#handleAudioWorkerMessage(event);
      }

      // 5. Create MediaStreamTrackProcessors and Send Streams to Workers
      const baseConfig = {
        ...this.#config,
        width: videoSettings.width || this.#config.width,
        height: videoSettings.height || this.#config.height,
        frameRate: videoSettings.frameRate || this.#config.frameRate,
      };

      // Create video stream for worker
      const clonedVideoTrack = videoTrack.clone();
      const videoProcessor = new MediaStreamTrackProcessor({ track: clonedVideoTrack } as MediaStreamTrackProcessorInit);
      const videoStream = videoProcessor.readable;
      
      // Send video configuration to video worker
      const videoMessage: VideoWorkerRequest = {
        type: 'start',
        config: baseConfig,
        videoStream: videoStream,
        actualVideoSettings: videoSettings
      };
      
      console.log('SlowTrackRecorder: Sending video stream to video worker');
      this.#videoWorker.postMessage(videoMessage, [videoStream]);

      // Send audio configuration to audio worker (if enabled)
      if (audioEnabled && audioTrack && this.#audioWorker && audioSettings) {
        const clonedAudioTrack = audioTrack.clone();
        const audioProcessor = new MediaStreamTrackProcessor({ track: clonedAudioTrack } as MediaStreamTrackProcessorInit);
        const audioStream = audioProcessor.readable;
        
        const audioConfig = {
          ...baseConfig,
          audio: {
            ...this.#config.audio!,
            sampleRate: (audioSettings.sampleRate || this.#config.audio!.sampleRate) as 48000 | 44100 | 32000 | 16000,
            numberOfChannels: (audioSettings.channelCount || this.#config.audio!.numberOfChannels) as 1 | 2
          }
        };

        const audioMessage: AudioWorkerRequest = {
          type: 'start',
          config: audioConfig,
          audioStream: audioStream,
          actualAudioSettings: audioSettings
        };
        
        console.log('SlowTrackRecorder: Sending audio stream to audio worker');
        this.#audioWorker.postMessage(audioMessage, [audioStream]);
      }

      // 6. Wait for Workers to be Ready
      console.log('SlowTrackRecorder: Waiting for workers to be ready...');
      await new Promise<void>((resolve, reject) => {
        this.#startPromiseResolve = resolve;
        this.#startPromiseReject = reject;
        
        // Timeout if workers don't respond
        setTimeout(() => {
          if (this.#startPromiseReject) {
            this.#startPromiseReject(new Error('Worker initialization timeout after 15 seconds'));
            this.#startPromiseResolve = null;
            this.#startPromiseReject = null;
          }
        }, 15000);
      });

      // 7. Finalize Recording State
      this.#isRecording = true;
      
      console.log('SlowTrackRecorder: 🎬 Dual-worker recording started successfully');
      console.log(`SlowTrackRecorder: Video codec: ${this.#finalVideoCodec}, Audio codec: ${this.#finalAudioCodec}`);
      
      if (audioEnabled) {
        console.log('🎬 SlowTrackRecorder: A/V recording session initiated with dual workers');
      } else {
        console.log('🎬 SlowTrackRecorder: Video-only recording session initiated');
      }
      
      this.#emit('start');

    } catch (error) {
      // 8. Comprehensive Cleanup on Error
      console.error('SlowTrackRecorder: Error in dual-worker start:', error);
      
      this.#cleanupDualWorkers();
      this.#isRecording = false;
      this.#shouldStopProcessing = false;
      this.#recordingStartTime = null;
      this.#stopPerformanceMonitoring();

      this.#emit('error', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Stop recording and return the final video file using dual-worker architecture
   * 
   * @returns Promise that resolves with the recorded video as a Blob
   */
  async stop(): Promise<Blob> {
    console.log('🎬 SlowTrackRecorder: Dual-worker recording session ending');
    
    // Idempotency Check
    if (!this.#isRecording) {
      throw new Error('Recording is not currently active');
    }

    // State Change
    this.#isRecording = false;

    return new Promise<Blob>((resolve, reject) => {
      this.#stopPromiseResolve = resolve;
      this.#stopPromiseReject = reject;

      // Timeout protection
      this.#stopTimeout = window.setTimeout(() => {
        const timeoutError = new Error('Dual-worker stop operation timed out after 20 seconds');
        this.#cleanupStopOperation();
        reject(timeoutError);
        this.#emit('error', timeoutError);
      }, 20000); // Longer timeout for dual-worker coordination

      this.#stopDualWorkers().then(resolve).catch(reject);
    });
  }

  /**
   * Coordinate stopping both workers and perform main thread muxing
   */
  async #stopDualWorkers(): Promise<Blob> {
    try {
      console.log('SlowTrackRecorder: Coordinating dual-worker stop operation');
      
      const stopPromises: Promise<void>[] = [];
      
      // Send stop command to video worker
      if (this.#videoWorker) {
        console.log('SlowTrackRecorder: Stopping video worker...');
        const videoStopPromise = new Promise<void>((resolve) => {
          const originalHandler = this.#videoWorker!.onmessage;
          this.#videoWorker!.onmessage = (event: MessageEvent<VideoWorkerResponse>) => {
            if (event.data.type === 'complete') {
              console.log('SlowTrackRecorder: Video worker stopped');
              this.#videoWorker!.onmessage = originalHandler;
              resolve();
            } else if (originalHandler) {
              originalHandler.call(this.#videoWorker!, event);
            }
          };
        });
        this.#videoWorker.postMessage({ type: 'stop' });
        stopPromises.push(videoStopPromise);
      }

      // Send stop command to audio worker (if exists)
      if (this.#audioWorker) {
        console.log('SlowTrackRecorder: Stopping audio worker...');
        const audioStopPromise = new Promise<void>((resolve) => {
          const originalHandler = this.#audioWorker!.onmessage;
          this.#audioWorker!.onmessage = (event: MessageEvent<AudioWorkerResponse>) => {
            if (event.data.type === 'complete') {
              console.log('SlowTrackRecorder: Audio worker stopped');
              this.#audioWorker!.onmessage = originalHandler;
              resolve();
            } else if (originalHandler) {
              originalHandler.call(this.#audioWorker!, event);
            }
          };
        });
        this.#audioWorker.postMessage({ type: 'stop' });
        stopPromises.push(audioStopPromise);
      }

      // Wait for both workers to complete
      console.log(`SlowTrackRecorder: Waiting for ${stopPromises.length} workers to complete...`);
      await Promise.all(stopPromises);
      
      console.log('SlowTrackRecorder: All workers completed, starting main thread muxing');
      console.log(`SlowTrackRecorder: Collected ${this.#videoChunks.length} video chunks, ${this.#audioChunks.length} audio chunks`);

      // Perform main thread muxing
      const finalBlob = await this.#performMainThreadMuxing();
      
      // Clear timeout since we completed successfully
      if (this.#stopTimeout !== null) {
        clearTimeout(this.#stopTimeout);
        this.#stopTimeout = null;
      }

      // Store result for analysis
      this.#lastResult = {
        blob: finalBlob,
        requestedConfig: { ...this.#config },
        finalConfig: this.#createFinalConfig()
      };

      // Cleanup and emit success
      this.#cleanupStopOperation();
      this.#emit('stop', finalBlob);
      
      return finalBlob;

    } catch (error) {
      console.error('SlowTrackRecorder: Error in dual-worker stop operation:', error);
      this.#cleanupStopOperation();
      const stopError = error instanceof Error ? error : new Error(String(error));
      this.#emit('error', stopError);
      throw stopError;
    }
  }

  /**
   * Perform muxing on the main thread using collected chunks
   */
  async #performMainThreadMuxing(): Promise<Blob> {
    try {
      // Determine container type based on video codec
      const containerType: 'mp4' | 'webm' = (this.#finalVideoCodec === 'av1' || this.#finalVideoCodec === 'vp9') ? 'webm' : 'mp4';
      console.log(`SlowTrackRecorder: Creating ${containerType.toUpperCase()} container for ${this.#finalVideoCodec} video codec`);

      // Combine and sort all chunks by timestamp for A/V sync
      const allChunks: Array<{chunk: EncodedVideoChunk | EncodedAudioChunk, type: 'video' | 'audio', timestamp: number}> = [];
      
      // Add video chunks
      this.#videoChunks.forEach(chunk => {
        allChunks.push({ chunk, type: 'video', timestamp: chunk.timestamp });
      });
      
      // Add audio chunks
      this.#audioChunks.forEach(chunk => {
        allChunks.push({ chunk, type: 'audio', timestamp: chunk.timestamp });
      });

      // Sort by timestamp to maintain A/V synchronization
      allChunks.sort((a, b) => a.timestamp - b.timestamp);
      console.log(`SlowTrackRecorder: Sorted ${allChunks.length} total chunks by timestamp for A/V sync`);

      let finalBlob: Blob;

      if (containerType === 'mp4') {
        // Use mp4-muxer for H.264/HEVC
        const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
        const target = new ArrayBufferTarget();
        
        const muxerConfig: any = {
          target,
          video: {
            codec: this.#finalVideoCodec === 'hevc' ? 'hevc' : 'avc',
            width: this.#config.width,
            height: this.#config.height
          },
          fastStart: 'fragmented',
          firstTimestampBehavior: 'offset'
        };

        // Add audio track if we have audio chunks
        if (this.#audioChunks.length > 0 && this.#finalAudioCodec) {
          muxerConfig.audio = {
            codec: 'aac', // MP4 containers use AAC
            sampleRate: this.#config.audio?.sampleRate || 48000,
            numberOfChannels: this.#config.audio?.numberOfChannels || 2
          };
        }

        const muxer = new Muxer(muxerConfig);
        console.log('SlowTrackRecorder: Created MP4 muxer with config:', muxerConfig);

        // Add chunks in timestamp order
        for (const { chunk, type } of allChunks) {
          const metadata = this.#chunkMetadata.get(chunk) || {};
          if (type === 'video') {
            muxer.addVideoChunk(chunk as EncodedVideoChunk, metadata);
          } else {
            muxer.addAudioChunk(chunk as EncodedAudioChunk, metadata);
          }
        }

        muxer.finalize();
        finalBlob = new Blob([target.buffer], { type: 'video/mp4' });
        console.log(`SlowTrackRecorder: Created MP4 blob, size: ${finalBlob.size} bytes`);

      } else {
        // Use webm-muxer for AV1/VP9
        const WebMMuxer = (await import('webm-muxer')).default;
        const muxedChunks: Uint8Array[] = [];
        
        const muxerConfig: any = {
          target: (data: Uint8Array) => {
            muxedChunks.push(data);
          },
          video: {
            codec: this.#finalVideoCodec === 'av1' ? 'V_AV01' : 'V_VP9',
            width: this.#config.width,
            height: this.#config.height
          },
          firstTimestampBehavior: 'offset'
        };

        // Add audio track if we have audio chunks
        if (this.#audioChunks.length > 0 && this.#finalAudioCodec) {
          const audioCodecMap: Record<string, string> = {
            'opus': 'A_OPUS',
            'flac': 'A_FLAC'
          };
          muxerConfig.audio = {
            codec: audioCodecMap[this.#finalAudioCodec] || 'A_OPUS',
            sampleRate: this.#config.audio?.sampleRate || 48000,
            numberOfChannels: this.#config.audio?.numberOfChannels || 2
          };
        }

        const muxer = new WebMMuxer(muxerConfig);
        console.log('SlowTrackRecorder: Created WebM muxer with config:', muxerConfig);

        // Add chunks in timestamp order
        for (const { chunk, type } of allChunks) {
          const metadata = this.#chunkMetadata.get(chunk) || {};
          if (type === 'video') {
            muxer.addVideoChunk(chunk as EncodedVideoChunk, metadata);
          } else {
            muxer.addAudioChunk(chunk as EncodedAudioChunk, metadata);
          }
        }

        muxer.finalize();
        finalBlob = new Blob(muxedChunks as BlobPart[], { type: 'video/webm' });
        console.log(`SlowTrackRecorder: Created WebM blob, size: ${finalBlob.size} bytes`);
      }

      return finalBlob;

    } catch (error) {
      console.error('SlowTrackRecorder: Error in main thread muxing:', error);
      throw new Error(`Main thread muxing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create final configuration object for result analysis
   */
  #createFinalConfig(): FinalEncoderConfig | undefined {
    if (!this.#finalVideoCodec) {
      return undefined;
    }

    const containerType: 'mp4' | 'webm' = (this.#finalVideoCodec === 'av1' || this.#finalVideoCodec === 'vp9') ? 'webm' : 'mp4';
    const recordingDuration = this.#recordingStartTime ? (performance.now() - this.#recordingStartTime) : 0;

    return {
      video: {
        codec: this.#finalVideoCodec,
        width: this.#config.width,
        height: this.#config.height,
        bitrate: this.#config.bitrate,
        framerate: this.#config.frameRate,
        hardwareAccelerationUsed: this.#config.hardwareAcceleration === 'prefer-hardware'
      },
      audio: this.#finalAudioCodec ? {
        codec: this.#finalAudioCodec,
        sampleRate: this.#config.audio?.sampleRate || 48000,
        numberOfChannels: this.#config.audio?.numberOfChannels || 2,
        bitrate: this.#config.audio?.bitrate || 128000
      } : undefined,
      container: containerType,
      duration: recordingDuration
    };
  }

  /**
   * Clean up dual workers and resources
   */
  #cleanupDualWorkers(): void {
    // Terminate video worker
    if (this.#videoWorker) {
      this.#videoWorker.terminate();
      this.#videoWorker = null;
    }
    
    // Terminate audio worker
    if (this.#audioWorker) {
      this.#audioWorker.terminate();
      this.#audioWorker = null;
    }
    
    // Reset worker state
    this.#isVideoWorkerReady = false;
    this.#isAudioWorkerReady = false;
    
    // Clear chunk buffers
    this.#videoChunks = [];
    this.#audioChunks = [];
    this.#chunkMetadata.clear();
    
    // Reset codec state
    this.#finalVideoCodec = null;
    this.#finalAudioCodec = null;
    this.#finalCodec = null;
    
    console.log('SlowTrackRecorder: Dual workers cleaned up');
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

    // Cleanup dual workers
    this.#cleanupDualWorkers();

    // Reset state
    this.#shouldStopProcessing = false;
    this.#isPumpPaused = false;
    this.#pressureHighTimestamp = null;
    this.#stopPerformanceMonitoring();
    
    // Stop leak monitoring and cleanup
    this.#stopLeakMonitoring();
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
    // Maintain backward compatibility by returning video codec
    return this.#finalVideoCodec || this.#finalCodec;
  }






}


