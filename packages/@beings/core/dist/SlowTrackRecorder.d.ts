import type { AudioConfig } from './types';
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
export declare class SlowTrackRecorder {
    #private;
    /**
     * Check if the SlowTrackRecorder is supported in the current environment
     *
     * @returns {boolean} True if WebCodecs and required APIs are available
     */
    static isSupported(): boolean;
    /**
     * Create a new SlowTrackRecorder instance
     *
     * @param config - Recording configuration parameters
     */
    constructor(config: SlowTrackRecorderConfig);
    /**
     * Register an event listener for recorder events
     *
     * @param event - Event type to listen for
     * @param callback - Function to call when event is emitted
     */
    on<T extends keyof RecorderEvents>(event: T, callback: RecorderEvents[T]): void;
    /**
     * Remove an event listener
     *
     * @param event - Event type to stop listening for
     * @param callback - Function to remove from listeners
     */
    off<T extends keyof RecorderEvents>(event: T, callback: RecorderEvents[T]): void;
    /**
     * Start recording from the provided MediaStream
     *
     * @param stream - MediaStream to record (typically from getUserMedia or getDisplayMedia)
     * @returns Promise that resolves when recording has started
     */
    start(stream: MediaStream): Promise<void>;
    /**
     * Stop recording and return the final video file
     *
     * @returns Promise that resolves with the recorded video as a Blob
     */
    stop(): Promise<Blob>;
    /**
     * Pause the current recording session
     *
     * @returns Promise that resolves when recording is paused
     */
    pause(): Promise<void>;
    /**
     * Resume a paused recording session
     *
     * @returns Promise that resolves when recording has resumed
     */
    resume(): Promise<void>;
    /**
     * Get the final codec that was selected by the automatic fallback system
     *
     * @returns The codec that is actually being used ('av1', 'hevc', 'h264', 'vp9', or null if not determined)
     */
    getFinalCodec(): 'av1' | 'hevc' | 'h264' | 'vp9' | null;
}
//# sourceMappingURL=SlowTrackRecorder.d.ts.map