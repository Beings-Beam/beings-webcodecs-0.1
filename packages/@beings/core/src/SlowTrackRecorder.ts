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
  
  /** Track pending normalized frames to ensure cleanup */
  #pendingNormalizedFrames = new Set<VideoFrame>();
  
  /** Track original frames from MediaStreamTrackProcessor */
  #pendingOriginalFrames = new Set<VideoFrame>();
  
  /** Track original audio frames from MediaStreamTrackProcessor */
  #pendingOriginalAudioFrames = new Set<AudioData>();
  
  /** Event-driven backpressure control */
  #isPumpPaused = false;
  #pressureHighTimestamp: number | null = null;
  #performanceCheckInterval: number | null = null;
  
  /** Refined user feedback system */
  #firstLevelWarningShown = false;
  #secondLevelWarningShown = false;
  
  /** Enhanced frame lifecycle tracking for diagnostics */
  #frameLifecycleMap = new Map<VideoFrame, { type: 'original' | 'normalized', operation: string, created: number }>();
  #maxFrameLifetime = 5000; // 5 seconds - warn about frames held longer than this

  /** 🎯 SURGICAL STRIKE: Lightweight frame leak detector */
  #activeFrames = new Set<VideoFrame>();
  #leakMonitorInterval: number | null = null;





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
        
        case 'pressure':
          this.#handleBackpressureMessage(event.data);
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
   * Handle backpressure messages from worker for event-driven flow control
   * 
   * @param data - Backpressure message data from worker
   */
  #handleBackpressureMessage(data: RecorderWorkerResponse): void {
    if (data.status === 'high') {
      const hysteresisInfo = data.consecutiveCount ? ` (attempt ${data.consecutiveCount}, backoff ${data.backoffMultiplier}x)` : '';
      console.warn(`SlowTrackRecorder: Worker backpressure HIGH${hysteresisInfo}, pausing SYNCHRONIZED A/V pumps (video queue: ${data.videoQueueSize}, audio queue: ${data.audioQueueSize})`);
      this.#isPumpPaused = true;
      if (this.#pressureHighTimestamp === null) {
        this.#pressureHighTimestamp = performance.now();
        // Start monitoring for prolonged backpressure
        this.#startPerformanceMonitoring();
      }
    } else if (data.status === 'low') {
      console.log(`SlowTrackRecorder: Worker backpressure LOW, resuming SYNCHRONIZED A/V pumps (video queue: ${data.videoQueueSize}, audio queue: ${data.audioQueueSize}) - hysteresis cooldown active`);
      this.#isPumpPaused = false;
      this.#pressureHighTimestamp = null;
      // Stop performance monitoring when backpressure is resolved
      this.#stopPerformanceMonitoring();
    }
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
   * Track frame lifecycle for enhanced diagnostics and leak detection
   * 
   * @param frame - VideoFrame to track
   * @param type - Type of frame ('original' from stream or 'normalized' for worker)
   * @param operation - Description of the operation being performed
   */
  #trackFrameLifecycle(frame: VideoFrame, type: 'original' | 'normalized', operation: string): void {
    const frameInfo = {
      type,
      operation,
      created: performance.now()
    };
    
    // Track for debugging and cleanup
    this.#frameLifecycleMap.set(frame, frameInfo);
    
    if (type === 'original') {
      this.#pendingOriginalFrames.add(frame);
    } else {
      this.#pendingNormalizedFrames.add(frame);
    }
    
    // Debug: Warn about frames held too long (potential leak detection)
    setTimeout(() => {
      if (this.#frameLifecycleMap.has(frame)) {
        const info = this.#frameLifecycleMap.get(frame)!;
        const lifetime = performance.now() - info.created;
        console.warn(`SlowTrackRecorder: Frame held for ${Math.round(lifetime)}ms, potential leak:`, {
          type: info.type,
          operation: info.operation,
          timestamp: frame.timestamp,
          lifetime: `${Math.round(lifetime)}ms`
        });
      }
    }, this.#maxFrameLifetime);
  }

  /**
   * Untrack frame when it's properly cleaned up
   * 
   * @param frame - VideoFrame to remove from tracking
   */
  #untrackFrameLifecycle(frame: VideoFrame): void {
    this.#frameLifecycleMap.delete(frame);
    this.#pendingOriginalFrames.delete(frame);
    this.#pendingNormalizedFrames.delete(frame);
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
      
      // Reset backpressure state for new recording
      this.#isPumpPaused = false;
      this.#pressureHighTimestamp = null;
      this.#stopPerformanceMonitoring();
      
      // Reset user feedback state
      this.#firstLevelWarningShown = false;
      this.#secondLevelWarningShown = false;

      // Leak monitoring disabled for performance testing
      // this.#startLeakMonitoring();

      // 2. Extract Tracks and Get ACTUAL Settings
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];
      if (!videoTrack) {
        throw new Error('No video tracks found in the provided MediaStream');
      }

      // 🎯 CRITICAL FIX: Extract actual track settings for configuration matching
      const videoSettings = videoTrack.getSettings();
      console.log('SlowTrackRecorder: 🔍 ACTUAL Video Track Settings:', {
        width: videoSettings.width,
        height: videoSettings.height,
        frameRate: videoSettings.frameRate,
        aspectRatio: videoSettings.aspectRatio,
        facingMode: videoSettings.facingMode
      });
      
      console.log('SlowTrackRecorder: 📋 REQUESTED Video Config:', {
        width: this.#config.width,
        height: this.#config.height,
        frameRate: this.#config.frameRate
      });

      // 🚨 CONFIGURATION MISMATCH DETECTION #1: Video Dimensions
      if (videoSettings.width !== this.#config.width || videoSettings.height !== this.#config.height) {
        console.warn('SlowTrackRecorder: ⚠️ VIDEO DIMENSION MISMATCH DETECTED!', {
          actualWidth: videoSettings.width,
          requestedWidth: this.#config.width,
          actualHeight: videoSettings.height,
          requestedHeight: this.#config.height
        });
      }

      // 🚨 CONFIGURATION MISMATCH DETECTION #2: Frame Rate
      if (videoSettings.frameRate && Math.abs(videoSettings.frameRate - this.#config.frameRate) > 1) {
        console.warn('SlowTrackRecorder: ⚠️ VIDEO FRAME RATE MISMATCH DETECTED!', {
          actualFrameRate: videoSettings.frameRate,
          requestedFrameRate: this.#config.frameRate
        });
      }

      const audioEnabled = this.#config.audio?.enabled === true && !!audioTrack;
      
      let audioSettings: MediaTrackSettings | null = null;
      if (audioTrack && audioEnabled) {
        audioSettings = audioTrack.getSettings();
        console.log('SlowTrackRecorder: 🔍 ACTUAL Audio Track Settings:', {
          sampleRate: audioSettings.sampleRate,
          channelCount: audioSettings.channelCount,
          sampleSize: audioSettings.sampleSize,
          echoCancellation: audioSettings.echoCancellation,
          noiseSuppression: audioSettings.noiseSuppression,
          autoGainControl: audioSettings.autoGainControl
        });
        
        console.log('SlowTrackRecorder: 📋 REQUESTED Audio Config:', {
          sampleRate: this.#config.audio?.sampleRate,
          numberOfChannels: this.#config.audio?.numberOfChannels,
          codec: this.#config.audio?.codec,
          bitrate: this.#config.audio?.bitrate
        });

        // 🚨 CONFIGURATION MISMATCH DETECTION #3: Audio Sample Rate
        if (audioSettings.sampleRate && this.#config.audio && 
            audioSettings.sampleRate !== this.#config.audio.sampleRate) {
          console.error('SlowTrackRecorder: 🚨 CRITICAL AUDIO SAMPLE RATE MISMATCH!', {
            actualSampleRate: audioSettings.sampleRate,
            requestedSampleRate: this.#config.audio.sampleRate,
            message: 'This WILL cause A/V sync issues and encoding failures!'
          });
        }

        // 🚨 CONFIGURATION MISMATCH DETECTION #4: Audio Channel Count
        if (audioSettings.channelCount && this.#config.audio && 
            audioSettings.channelCount !== this.#config.audio.numberOfChannels) {
          console.warn('SlowTrackRecorder: ⚠️ AUDIO CHANNEL COUNT MISMATCH DETECTED!', {
            actualChannelCount: audioSettings.channelCount,
            requestedChannelCount: this.#config.audio.numberOfChannels,
            message: 'Upmixing/downmixing may be required'
          });
        }
      }

      if (this.#config.audio?.enabled && !audioTrack) {
        console.warn('SlowTrackRecorder: Audio enabled in config but no audio track found in stream. Proceeding with video-only recording.');
      }

      // 3. Initialize Worker
      this.#worker = new Worker(
        new URL('./recorder.worker.ts', import.meta.url),
        { type: 'module' }
      );
      this.#worker.onmessage = this.#handleWorkerMessage.bind(this);

      // 4. Create Direct Processing Pipeline (TransformStream removed)
      // 🎯 RACE CONDITION FIX: Clone video track to prevent premature termination
      const clonedVideoTrack = videoTrack.clone();
      const videoProcessor = new MediaStreamTrackProcessor({ track: clonedVideoTrack } as MediaStreamTrackProcessorInit);
      
      console.log('SlowTrackRecorder: 🎬 Created direct MediaStreamTrackProcessor pipeline (no TransformStream)');

      // 🎯 DIRECT PIPELINE: Create transform stream just for worker transfer (no processing)
      this.#videoTransformStream = new TransformStream<VideoFrame, VideoFrame>();
      const videoReader = videoProcessor.readable.getReader();
      const videoWriter = this.#videoTransformStream.writable.getWriter();

      const processingPromises: Promise<void>[] = [
        this.#processVideoStreamDirect(videoReader, videoWriter)
      ];

      let audioStreamForWorker: ReadableStream<AudioData> | undefined;

      if (audioEnabled) {
        this.#audioTransformStream = new TransformStream<AudioData, AudioData>(undefined, undefined, {
          highWaterMark: 500, // Increased buffer for audio to prevent throttling
          size: () => 1
        });
        // 🎯 RACE CONDITION FIX: Clone audio track for consistency
        const clonedAudioTrack = audioTrack.clone();
        const audioProcessor = new MediaStreamTrackProcessor({ track: clonedAudioTrack } as MediaStreamTrackProcessorInit);
        const audioReader = audioProcessor.readable.getReader();
        const audioWriter = this.#audioTransformStream.writable.getWriter();
        
        console.log('SlowTrackRecorder: 🎵 Created MediaStreamTrackProcessor with cloned audio track');
        processingPromises.push(this.#processAudioStream(audioReader, audioWriter));
        audioStreamForWorker = this.#audioTransformStream.readable;
      }

      // Launch the processing loops in the background with debugging
      console.log(`SlowTrackRecorder: 🚀 Starting ${processingPromises.length} processing loops`);
      Promise.all(processingPromises).then(() => {
        console.log('SlowTrackRecorder: ✅ All processing loops completed normally');
      }).catch(error => {
        console.error('SlowTrackRecorder: 🚨 Processing loop error:', error);
        this.#handleFatalError(error);
      });

      // 5. Post Message to Worker (REVERTED to stream-based)
      const message = {
        type: 'start' as const,
        config: {
          ...this.#config,
          // Use actual track settings for perfect configuration matching
          width: videoSettings.width || this.#config.width,
          height: videoSettings.height || this.#config.height,
          frameRate: videoSettings.frameRate || this.#config.frameRate,
          audio: audioEnabled && audioSettings && this.#config.audio ? {
            ...this.#config.audio,
            sampleRate: audioSettings.sampleRate || this.#config.audio.sampleRate,
            numberOfChannels: audioSettings.channelCount || this.#config.audio.numberOfChannels
          } as AudioConfig : this.#config.audio
        },
        stream: this.#videoTransformStream.readable,
        audioStream: audioStreamForWorker,
        actualVideoSettings: videoSettings,
        actualAudioSettings: audioSettings
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
      this.#stopPerformanceMonitoring();

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
    
    // Clean up any pending normalized frames that haven't been processed
    console.log(`SlowTrackRecorder: Cleaning up ${this.#pendingNormalizedFrames.size} pending normalized frames, ${this.#pendingOriginalFrames.size} original video frames, and ${this.#pendingOriginalAudioFrames.size} original audio frames`);
    
    for (const frame of this.#pendingNormalizedFrames) {
      try {
        frame.close();
      } catch (closeError) {
        // Frame might have been closed already, ignore
      }
    }
    this.#pendingNormalizedFrames.clear();
    
    // Clean up any pending original video frames
    for (const frame of this.#pendingOriginalFrames) {
      try {
        frame.close();
      } catch (closeError) {
        // Frame might have been closed already, ignore
      }
    }
    this.#pendingOriginalFrames.clear();
    
    // Clear frame lifecycle tracking
    this.#frameLifecycleMap.clear();
    
    // Clean up any pending original audio frames
    for (const frame of this.#pendingOriginalAudioFrames) {
      try {
        frame.close();
      } catch (closeError) {
        // Frame might have been closed already, ignore
      }
    }
    this.#pendingOriginalAudioFrames.clear();
    
    // Additional cleanup: Force garbage collection after a short delay
    setTimeout(() => {
      try {
        // @ts-ignore - gc() is available in Node.js with --expose-gc flag
        if (typeof gc !== 'undefined') {
          // @ts-ignore
          gc();
          console.log('SlowTrackRecorder: Forced garbage collection after cleanup');
        }
      } catch (gcError) {
        // gc() not available, ignore
      }
    }, 100);
    
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
    this.#isPumpPaused = false;
    this.#pressureHighTimestamp = null;
    this.#stopPerformanceMonitoring();
    
    // 🎯 SURGICAL STRIKE: Stop leak monitoring and cleanup
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
    return this.#finalCodec;
  }

  /**
   * 🎯 DIRECT PIPELINE: Processes video frames directly from MediaStreamTrackProcessor
   * Eliminates TransformStream bottleneck for maximum performance
   * @param reader - Direct reader from MediaStreamTrackProcessor
   */
  async #processVideoStreamDirect(
    reader: ReadableStreamDefaultReader<VideoFrame>,
    writer: WritableStreamDefaultWriter<VideoFrame>
  ): Promise<void> {
    try {
      console.log('SlowTrackRecorder: 🎬 Direct video processing loop starting');
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
          console.log('SlowTrackRecorder: 🎬 Video stream ended (done=true)');
          break; // The stream has ended.
        }
        
        // Debug: Log every frame read for troubleshooting
        console.log(`SlowTrackRecorder: 🎬 Read frame ${this.#videoFrameCount + 1} from MediaStreamTrackProcessor`);
        console.log(`SlowTrackRecorder: 📊 Writer state before processing - desiredSize: ${writer.desiredSize}`);

        // Track frame for cleanup (logging removed for performance)
        if (frame) {
          this.#activeFrames.add(frame);
          this.#trackFrameLifecycle(frame, 'original', 'received_from_stream');
        }

        // Process frame and send directly to worker
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

          // Track normalized frame for cleanup
          this.#activeFrames.add(normalizedFrame);
          this.#trackFrameLifecycle(normalizedFrame, 'normalized', 'created_for_worker');

          // 🎯 NON-BLOCKING WRITE: Prevent main thread hanging on backpressure
          const frameId = this.#videoFrameCount;
          
          // Check writer state before attempting write
          if (writer.desiredSize !== null && writer.desiredSize <= 0) {
            console.log(`SlowTrackRecorder: 🚨 Writer backpressure detected, dropping frame ${frameId} (desiredSize: ${writer.desiredSize})`);
            normalizedFrame.close();
            this.#activeFrames.delete(normalizedFrame);
          } else {
            // Non-blocking write with error handling
            writer.write(normalizedFrame).then(() => {
              // Success - frame transferred
              this.#activeFrames.delete(normalizedFrame);
              if (frameId % 100 === 0) {
                console.log(`SlowTrackRecorder: ✅ Frame ${frameId} successfully transferred (non-blocking)`);
              }
            }).catch(writeError => {
              // Write failed - clean up frame
              console.warn(`SlowTrackRecorder: ⚠️ Frame ${frameId} write failed:`, writeError instanceof Error ? writeError.message : String(writeError));
              try {
                normalizedFrame.close();
              } catch (closeError) {
                // Frame might already be closed
              }
              this.#activeFrames.delete(normalizedFrame);
            });
          }

        } finally {
          // Always close original frame and remove from leak detector
          frame.close();
          this.#activeFrames.delete(frame);
          this.#untrackFrameLifecycle(frame);
        }
        
        // Debug: Log loop iteration completion
        console.log(`SlowTrackRecorder: 🔄 Completed processing frame ${this.#videoFrameCount}, continuing to next iteration`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : (error ? String(error) : 'Unknown error');
      console.error('SlowTrackRecorder: A fatal error occurred in the video processing loop.', errorMessage);
      throw error instanceof Error ? error : new Error(errorMessage);
    } finally {
      try {
        await writer.close();
      } catch (closeError) {
        console.warn('SlowTrackRecorder: Video writer close failed (expected during error cleanup):', closeError instanceof Error ? closeError.message : String(closeError));
      }
      reader.releaseLock();
    }
  }

  /**
   * @deprecated Legacy TransformStream-based processing - replaced by direct processing
   */
  async #processVideoStream(
    reader: ReadableStreamDefaultReader<VideoFrame>,
    writer: WritableStreamDefaultWriter<VideoFrame>
  ): Promise<void> {
    try {
      console.log('SlowTrackRecorder: 🎬 Video processing loop starting');
      while (true) {
        // Check if we should stop processing due to stop signal or error in another loop
        if (this.#shouldStopProcessing) {
          console.log('SlowTrackRecorder: Stop signal received, terminating video processing loop');
          break;
        }

        // **KEY CHANGE**: Wait here if the pump is paused due to backpressure
        if (this.#isPumpPaused) {
          console.log('🚨 PUMP PAUSED: Waiting due to backpressure...');
          await new Promise(resolve => setTimeout(resolve, 100));
          continue; // Re-check conditions without reading new frames
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
          console.log('SlowTrackRecorder: 🎬 Video stream ended (done=true)');
          break; // The stream has ended.
        }
        
        // Debug: Log every frame read for troubleshooting
        console.log(`SlowTrackRecorder: 🎬 Read frame ${this.#videoFrameCount + 1} from MediaStreamTrackProcessor`);

        // Track frame for cleanup (logging removed for performance)
        if (frame) {
          this.#activeFrames.add(frame);
          this.#trackFrameLifecycle(frame, 'original', 'received_from_stream');
        }

        // We wrap the processing of each frame to ensure the original is always closed.
        try {
          this.#videoFrameCount++;
          const now = performance.now();
          
          // Debug: Log frame details for leak investigation
          if (this.#videoFrameCount % 20 === 0) {
            console.log(`SlowTrackRecorder: Processing frame ${this.#videoFrameCount}, pending: ${this.#pendingNormalizedFrames.size}`);
          }
          
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

          // Forward the newly timestamped frame to the worker
          const frameId = this.#videoFrameCount; // Track frame for debugging

          // Track normalized frame for cleanup (logging removed for performance)
          this.#activeFrames.add(normalizedFrame);
          this.#trackFrameLifecycle(normalizedFrame, 'normalized', 'created_for_worker');
          
          // === LAYER A: PROACTIVE PREVENTION (The "Belt") ===
          // Check stream capacity BEFORE attempting write - handles obvious backpressure cases
          if (writer.desiredSize !== null && writer.desiredSize <= 0) {
            // Stream is under backpressure - defer write by closing frame immediately
            console.log(`SlowTrackRecorder: 🚨 BACKPRESSURE DETECTED - Frame ${frameId} proactively deferred (desiredSize: ${writer.desiredSize})`);
            
            // 🎯 CRITICAL FIX: Close BOTH frames to prevent memory leak
            try {
              normalizedFrame.close();
              this.#activeFrames.delete(normalizedFrame);
              console.log(`SlowTrackRecorder: ✅ Closed normalized frame ${frameId}`);
            } catch (closeError) {
              console.warn(`SlowTrackRecorder: Error closing normalized frame ${frameId}:`, closeError);
            }
            
            // 🎯 CRITICAL FIX: Close original frame too (this was the leak!)
            try {
              frame.close();
              this.#activeFrames.delete(frame);
              console.log(`SlowTrackRecorder: ✅ Closed original frame ${frameId} (LEAK FIX)`);
            } catch (closeError) {
              console.warn(`SlowTrackRecorder: Error closing original frame ${frameId}:`, closeError);
            }
            
            this.#untrackFrameLifecycle(normalizedFrame);
            this.#untrackFrameLifecycle(frame);
            
            // Continue to next frame - both frames now properly closed
            continue;
          }
          
          // === LAYER B: DEFENSIVE RECOVERY (The "Suspenders") ===
          // Stream appeared ready, but race condition may occur between check and write
          try {
            // Use Promise.race to handle race condition where buffer fills between check and write
            await Promise.race([
              writer.write(normalizedFrame),
              new Promise<never>((_, reject) => 
                setTimeout(() => reject(new Error('write timeout - race condition detected')), 100)
              )
            ]);
            // Frame successfully transferred to worker - remove from leak detector
            this.#activeFrames.delete(normalizedFrame);
            
            // Reduced logging frequency for performance
            if (frameId % 100 === 0) {
              console.log(`SlowTrackRecorder: Frame ${frameId} successfully queued to worker (desiredSize: ${writer.desiredSize})`);
            }
          } catch (writeError) {
            const errorMsg = writeError instanceof Error ? writeError.message : String(writeError);
            const isRaceCondition = errorMsg.includes('race condition detected');
            const errorType = isRaceCondition ? 'race condition' : 'write error';
            
            console.warn(`SlowTrackRecorder: Video frame ${frameId} ${errorType}: ${errorMsg}`);
            
            // 🎯 SURGICAL STRIKE: Close frame and remove from leak detector on error
            try {
              normalizedFrame.close();
              this.#activeFrames.delete(normalizedFrame);
              console.log(`SlowTrackRecorder: Closed frame ${frameId} after ${errorType}`);
            } catch (closeError) {
              console.warn(`SlowTrackRecorder: Error closing failed frame ${frameId}:`, closeError);
            }
          } finally {
            // ALWAYS remove the frame from the tracking set once it's been handled
            this.#untrackFrameLifecycle(normalizedFrame);
          }

        } finally {
          // Always close original frame and remove from leak detector
          frame.close();
          this.#activeFrames.delete(frame);
          this.#untrackFrameLifecycle(frame);
        }
        
        // Debug: Log loop iteration completion
        console.log(`SlowTrackRecorder: 🔄 Completed processing frame ${this.#videoFrameCount}, continuing to next iteration`);
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

        // **SYNCHRONIZED PUMP CONTROL**: Wait here if the pump is paused due to backpressure
        // This ensures both audio and video processing pause together, maintaining A/V sync
        if (this.#isPumpPaused) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue; // Re-check conditions without reading new frames
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

        // Track the original audio frame to ensure cleanup
        if (frame) {
          this.#pendingOriginalAudioFrames.add(frame);
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
          // Remove from tracking
          this.#pendingOriginalAudioFrames.delete(frame);
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


