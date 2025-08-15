var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var _SlowTrackRecorder_instances, _a, _SlowTrackRecorder_config, _SlowTrackRecorder_listeners, _SlowTrackRecorder_worker, _SlowTrackRecorder_isRecording, _SlowTrackRecorder_isWorkerReady, _SlowTrackRecorder_stopPromiseResolve, _SlowTrackRecorder_stopPromiseReject, _SlowTrackRecorder_stopTimeout, _SlowTrackRecorder_finalCodec, _SlowTrackRecorder_startPromiseResolve, _SlowTrackRecorder_startPromiseReject, _SlowTrackRecorder_validateAudioConfig, _SlowTrackRecorder_emit, _SlowTrackRecorder_handleWorkerMessage, _SlowTrackRecorder_handleFileMessage, _SlowTrackRecorder_handleWorkerError, _SlowTrackRecorder_cleanupStopOperation;
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
    /**
     * Check if the SlowTrackRecorder is supported in the current environment
     *
     * @returns {boolean} True if WebCodecs and required APIs are available
     */
    static isSupported() {
        const hasVideoSupport = typeof window.MediaStreamTrackProcessor !== 'undefined' &&
            typeof window.VideoEncoder !== 'undefined';
        const hasAudioSupport = typeof window.AudioEncoder !== 'undefined';
        // Log audio capability for debugging
        if (hasVideoSupport && !hasAudioSupport) {
            console.info('SlowTrackRecorder: Video recording supported, audio recording not available');
        }
        else if (hasVideoSupport && hasAudioSupport) {
            console.info('SlowTrackRecorder: Both video and audio recording supported');
        }
        // Return true if video is supported (audio is optional enhancement)
        return hasVideoSupport;
    }
    /**
     * Create a new SlowTrackRecorder instance
     *
     * @param config - Recording configuration parameters
     */
    constructor(config) {
        _SlowTrackRecorder_instances.add(this);
        _SlowTrackRecorder_config.set(this, void 0);
        _SlowTrackRecorder_listeners.set(this, new Map());
        _SlowTrackRecorder_worker.set(this, null);
        _SlowTrackRecorder_isRecording.set(this, false);
        _SlowTrackRecorder_isWorkerReady.set(this, false);
        _SlowTrackRecorder_stopPromiseResolve.set(this, null);
        _SlowTrackRecorder_stopPromiseReject.set(this, null);
        _SlowTrackRecorder_stopTimeout.set(this, null);
        _SlowTrackRecorder_finalCodec.set(this, null);
        _SlowTrackRecorder_startPromiseResolve.set(this, null);
        _SlowTrackRecorder_startPromiseReject.set(this, null);
        // Validate and sanitize audio configuration if provided
        if (config.audio) {
            const validatedAudio = __classPrivateFieldGet(_a, _a, "m", _SlowTrackRecorder_validateAudioConfig).call(_a, config.audio);
            __classPrivateFieldSet(this, _SlowTrackRecorder_config, { ...config, audio: validatedAudio }, "f");
        }
        else {
            __classPrivateFieldSet(this, _SlowTrackRecorder_config, config, "f");
        }
    }
    /**
     * Register an event listener for recorder events
     *
     * @param event - Event type to listen for
     * @param callback - Function to call when event is emitted
     */
    on(event, callback) {
        if (!__classPrivateFieldGet(this, _SlowTrackRecorder_listeners, "f").has(event)) {
            __classPrivateFieldGet(this, _SlowTrackRecorder_listeners, "f").set(event, new Set());
        }
        __classPrivateFieldGet(this, _SlowTrackRecorder_listeners, "f").get(event).add(callback);
    }
    /**
     * Remove an event listener
     *
     * @param event - Event type to stop listening for
     * @param callback - Function to remove from listeners
     */
    off(event, callback) {
        const listeners = __classPrivateFieldGet(this, _SlowTrackRecorder_listeners, "f").get(event);
        if (listeners) {
            listeners.delete(callback);
        }
    }
    /**
     * Start recording from the provided MediaStream
     *
     * @param stream - MediaStream to record (typically from getUserMedia or getDisplayMedia)
     * @returns Promise that resolves when recording has started
     */
    async start(stream) {
        try {
            // Validate State: Check if already recording
            if (__classPrivateFieldGet(this, _SlowTrackRecorder_isRecording, "f")) {
                throw new Error('Recording already in progress');
            }
            // Extract Tracks: Get both video and audio tracks from the stream
            const videoTracks = stream.getVideoTracks();
            const audioTracks = stream.getAudioTracks();
            if (videoTracks.length === 0) {
                throw new Error('No video tracks found in the provided MediaStream');
            }
            const videoTrack = videoTracks[0];
            const audioTrack = audioTracks.length > 0 ? audioTracks[0] : null;
            // Audio Configuration Check: Validate audio availability vs config
            const audioEnabled = __classPrivateFieldGet(this, _SlowTrackRecorder_config, "f").audio?.enabled === true;
            const hasAudio = audioTrack !== null && audioEnabled;
            if (audioEnabled && !audioTrack) {
                console.warn('SlowTrackRecorder: Audio enabled in config but no audio tracks found in stream, proceeding with video-only recording');
            }
            // Initialize Worker: Create new worker instance
            __classPrivateFieldSet(this, _SlowTrackRecorder_worker, new Worker(new URL('./recorder.worker.ts', import.meta.url), { type: 'module' }), "f");
            // Attach Message Handler: Listen for messages from worker
            __classPrivateFieldGet(this, _SlowTrackRecorder_worker, "f").onmessage = __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_handleWorkerMessage).bind(this);
            // Create Stream Processors: Convert tracks to readable streams
            const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
            const videoStream = videoProcessor.readable;
            let audioStream;
            if (hasAudio) {
                try {
                    const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
                    audioStream = audioProcessor.readable;
                }
                catch (error) {
                    console.warn('SlowTrackRecorder: Failed to create audio processor, proceeding with video-only:', error);
                    audioStream = undefined;
                }
            }
            // Post Message: Transfer streams to the worker
            const message = {
                type: 'start',
                config: __classPrivateFieldGet(this, _SlowTrackRecorder_config, "f"),
                stream: videoStream,
                audioStream: audioStream
            };
            const transferables = [videoStream];
            if (audioStream) {
                transferables.push(audioStream);
            }
            __classPrivateFieldGet(this, _SlowTrackRecorder_worker, "f").postMessage(message, transferables);
            // Wait for worker initialization: Create promise to wait for 'ready' or 'error' message
            await new Promise((resolve, reject) => {
                __classPrivateFieldSet(this, _SlowTrackRecorder_startPromiseResolve, resolve, "f");
                __classPrivateFieldSet(this, _SlowTrackRecorder_startPromiseReject, reject, "f");
                // Set a timeout to prevent infinite waiting
                setTimeout(() => {
                    if (__classPrivateFieldGet(this, _SlowTrackRecorder_startPromiseReject, "f")) {
                        __classPrivateFieldGet(this, _SlowTrackRecorder_startPromiseReject, "f").call(this, new Error('Worker initialization timeout - no response from worker after 10 seconds'));
                        __classPrivateFieldSet(this, _SlowTrackRecorder_startPromiseResolve, null, "f");
                        __classPrivateFieldSet(this, _SlowTrackRecorder_startPromiseReject, null, "f");
                    }
                }, 10000); // 10 second timeout
            });
            // Finalize State & Emit Event: Mark as recording and notify listeners
            __classPrivateFieldSet(this, _SlowTrackRecorder_isRecording, true, "f");
            __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_emit).call(this, 'start');
        }
        catch (error) {
            // Clean Up: Terminate worker if it exists
            if (__classPrivateFieldGet(this, _SlowTrackRecorder_worker, "f")) {
                __classPrivateFieldGet(this, _SlowTrackRecorder_worker, "f").terminate();
                __classPrivateFieldSet(this, _SlowTrackRecorder_worker, null, "f");
            }
            // Reset State: Ensure clean state after error
            __classPrivateFieldSet(this, _SlowTrackRecorder_isRecording, false, "f");
            // Emit Error: Notify listeners of the error
            __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_emit).call(this, 'error', error instanceof Error ? error : new Error(String(error)));
            // Re-throw to maintain async error propagation
            throw error;
        }
    }
    /**
     * Stop recording and return the final video file
     *
     * @returns Promise that resolves with the recorded video as a Blob
     */
    async stop() {
        // Idempotency Check: Prevent multiple stop calls
        if (!__classPrivateFieldGet(this, _SlowTrackRecorder_isRecording, "f")) {
            throw new Error('Recording is not currently active');
        }
        // State Change: Mark as no longer recording
        __classPrivateFieldSet(this, _SlowTrackRecorder_isRecording, false, "f");
        // Promise Creation: Create promise for async file return
        return new Promise((resolve, reject) => {
            __classPrivateFieldSet(this, _SlowTrackRecorder_stopPromiseResolve, resolve, "f");
            __classPrivateFieldSet(this, _SlowTrackRecorder_stopPromiseReject, reject, "f");
            // Timeout: Ensure we don't wait forever for worker response
            __classPrivateFieldSet(this, _SlowTrackRecorder_stopTimeout, window.setTimeout(() => {
                const timeoutError = new Error('Recording stop operation timed out');
                __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_cleanupStopOperation).call(this);
                reject(timeoutError);
                __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_emit).call(this, 'error', timeoutError);
            }, 10000), "f"); // 10 second timeout
            // Send Stop Command: Tell worker to finalize recording
            if (__classPrivateFieldGet(this, _SlowTrackRecorder_worker, "f")) {
                __classPrivateFieldGet(this, _SlowTrackRecorder_worker, "f").postMessage({ type: 'stop' });
            }
            else {
                __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_cleanupStopOperation).call(this);
                reject(new Error('Worker not available for stop operation'));
            }
        });
    }
    /**
     * Pause the current recording session
     *
     * @returns Promise that resolves when recording is paused
     */
    async pause() {
        // TODO: Implement recording pause functionality
    }
    /**
     * Resume a paused recording session
     *
     * @returns Promise that resolves when recording has resumed
     */
    async resume() {
        // TODO: Implement recording resume functionality
    }
    /**
     * Get the final codec that was selected by the automatic fallback system
     *
     * @returns The codec that is actually being used ('av1', 'hevc', 'h264', 'vp9', or null if not determined)
     */
    getFinalCodec() {
        return __classPrivateFieldGet(this, _SlowTrackRecorder_finalCodec, "f");
    }
}
_a = SlowTrackRecorder, _SlowTrackRecorder_config = new WeakMap(), _SlowTrackRecorder_listeners = new WeakMap(), _SlowTrackRecorder_worker = new WeakMap(), _SlowTrackRecorder_isRecording = new WeakMap(), _SlowTrackRecorder_isWorkerReady = new WeakMap(), _SlowTrackRecorder_stopPromiseResolve = new WeakMap(), _SlowTrackRecorder_stopPromiseReject = new WeakMap(), _SlowTrackRecorder_stopTimeout = new WeakMap(), _SlowTrackRecorder_finalCodec = new WeakMap(), _SlowTrackRecorder_startPromiseResolve = new WeakMap(), _SlowTrackRecorder_startPromiseReject = new WeakMap(), _SlowTrackRecorder_instances = new WeakSet(), _SlowTrackRecorder_validateAudioConfig = function _SlowTrackRecorder_validateAudioConfig(audioConfig) {
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
    }
    catch (error) {
        console.warn('SlowTrackRecorder: Error validating audio config:', error);
        return undefined;
    }
}, _SlowTrackRecorder_emit = function _SlowTrackRecorder_emit(event, ...args) {
    const listeners = __classPrivateFieldGet(this, _SlowTrackRecorder_listeners, "f").get(event);
    if (listeners) {
        listeners.forEach(callback => {
            try {
                callback(...args);
            }
            catch (error) {
                // Prevent listener errors from breaking the recorder
                console.error(`Error in ${event} event listener:`, error);
            }
        });
    }
}, _SlowTrackRecorder_handleWorkerMessage = function _SlowTrackRecorder_handleWorkerMessage(event) {
    try {
        switch (event.data.type) {
            case 'ready':
                __classPrivateFieldSet(this, _SlowTrackRecorder_isWorkerReady, true, "f");
                __classPrivateFieldSet(this, _SlowTrackRecorder_finalCodec, event.data.finalCodec || null, "f");
                console.log('SlowTrackRecorder: Worker ready with codec:', __classPrivateFieldGet(this, _SlowTrackRecorder_finalCodec, "f"));
                // Resolve the start promise if pending
                if (__classPrivateFieldGet(this, _SlowTrackRecorder_startPromiseResolve, "f")) {
                    __classPrivateFieldGet(this, _SlowTrackRecorder_startPromiseResolve, "f").call(this);
                    __classPrivateFieldSet(this, _SlowTrackRecorder_startPromiseResolve, null, "f");
                    __classPrivateFieldSet(this, _SlowTrackRecorder_startPromiseReject, null, "f");
                }
                break;
            case 'file':
                __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_handleFileMessage).call(this, event.data);
                break;
            case 'error':
                __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_handleWorkerError).call(this, event.data.error || 'Unknown worker error');
                break;
            default:
                console.warn('SlowTrackRecorder: Unknown message type from worker:', event.data);
        }
    }
    catch (error) {
        console.error('SlowTrackRecorder: Error handling worker message:', error);
    }
}, _SlowTrackRecorder_handleFileMessage = function _SlowTrackRecorder_handleFileMessage(data) {
    if (!data.blob) {
        const error = new Error('No blob received in file message from worker');
        __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_handleWorkerError).call(this, error.message);
        return;
    }
    try {
        // Clear the timeout since we received the response
        if (__classPrivateFieldGet(this, _SlowTrackRecorder_stopTimeout, "f") !== null) {
            clearTimeout(__classPrivateFieldGet(this, _SlowTrackRecorder_stopTimeout, "f"));
            __classPrivateFieldSet(this, _SlowTrackRecorder_stopTimeout, null, "f");
        }
        // Use the blob directly from the worker (no conversion needed)
        const videoBlob = data.blob;
        // Resolve the stop promise with the video blob
        if (__classPrivateFieldGet(this, _SlowTrackRecorder_stopPromiseResolve, "f")) {
            __classPrivateFieldGet(this, _SlowTrackRecorder_stopPromiseResolve, "f").call(this, videoBlob);
            __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_emit).call(this, 'stop', videoBlob);
        }
        // Cleanup worker and reset state
        __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_cleanupStopOperation).call(this);
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_handleWorkerError).call(this, `Failed to process video file: ${errorMessage}`);
    }
}, _SlowTrackRecorder_handleWorkerError = function _SlowTrackRecorder_handleWorkerError(errorMessage) {
    const error = new Error(`Worker error: ${errorMessage}`);
    // If we have a pending start operation, reject it
    if (__classPrivateFieldGet(this, _SlowTrackRecorder_startPromiseReject, "f")) {
        __classPrivateFieldGet(this, _SlowTrackRecorder_startPromiseReject, "f").call(this, error);
        __classPrivateFieldSet(this, _SlowTrackRecorder_startPromiseResolve, null, "f");
        __classPrivateFieldSet(this, _SlowTrackRecorder_startPromiseReject, null, "f");
    }
    // If we have a pending stop operation, reject it
    if (__classPrivateFieldGet(this, _SlowTrackRecorder_stopPromiseReject, "f")) {
        __classPrivateFieldGet(this, _SlowTrackRecorder_stopPromiseReject, "f").call(this, error);
    }
    // Emit error event
    __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_emit).call(this, 'error', error);
    // Cleanup resources
    __classPrivateFieldGet(this, _SlowTrackRecorder_instances, "m", _SlowTrackRecorder_cleanupStopOperation).call(this);
}, _SlowTrackRecorder_cleanupStopOperation = function _SlowTrackRecorder_cleanupStopOperation() {
    // Clear timeout if it exists
    if (__classPrivateFieldGet(this, _SlowTrackRecorder_stopTimeout, "f") !== null) {
        clearTimeout(__classPrivateFieldGet(this, _SlowTrackRecorder_stopTimeout, "f"));
        __classPrivateFieldSet(this, _SlowTrackRecorder_stopTimeout, null, "f");
    }
    // Reset promise handlers
    __classPrivateFieldSet(this, _SlowTrackRecorder_stopPromiseResolve, null, "f");
    __classPrivateFieldSet(this, _SlowTrackRecorder_stopPromiseReject, null, "f");
    // Terminate and cleanup worker
    if (__classPrivateFieldGet(this, _SlowTrackRecorder_worker, "f")) {
        __classPrivateFieldGet(this, _SlowTrackRecorder_worker, "f").terminate();
        __classPrivateFieldSet(this, _SlowTrackRecorder_worker, null, "f");
    }
    // Reset state
    __classPrivateFieldSet(this, _SlowTrackRecorder_isWorkerReady, false, "f");
};
//# sourceMappingURL=SlowTrackRecorder.js.map