/// <reference lib="webworker" />
/**
 * Recorder Worker - Video and Audio Encoding Implementation
 *
 * This worker handles the heavy lifting of video and audio processing and encoding
 * for the SlowTrackRecorder. Implements WebCodecs VideoEncoder and AudioEncoder
 * with mp4-muxer and webm-muxer for container creation.
 */
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import WebMMuxer from 'webm-muxer';
// Module-level state variables
let videoEncoder = null;
let muxer = null;
let mp4Target = null; // Store MP4 target separately
let streamReader = null;
let currentCodec = null;
// Audio pipeline state variables
let audioEncoder = null;
let audioStreamReader = null;
// Downscaling state variables
let needsScaling = false;
let scaledWidth = 0;
let scaledHeight = 0;
let offscreenCanvas = null;
let canvasContext = null;
// Muxer chunk collection state
let muxedChunks = [];
/**
 * Calculate scaled dimensions that fit within hardware limits while preserving aspect ratio
 *
 * @param originalWidth - Original stream width
 * @param originalHeight - Original stream height
 * @param maxWidth - Maximum allowed width (default: 1920)
 * @param maxHeight - Maximum allowed height (default: 1080)
 * @returns Object with scaled dimensions and scaling flag
 */
function calculateScaledDimensions(originalWidth, originalHeight, maxWidth = 1920, maxHeight = 1080) {
    // If already within limits, no scaling needed
    if (originalWidth <= maxWidth && originalHeight <= maxHeight) {
        return { width: originalWidth, height: originalHeight, needsScaling: false };
    }
    // Calculate scaling ratios for both dimensions
    const widthRatio = maxWidth / originalWidth;
    const heightRatio = maxHeight / originalHeight;
    // Use the smaller ratio to ensure we stay within both limits
    const scalingFactor = Math.min(widthRatio, heightRatio);
    // Calculate new dimensions (ensure even numbers for video encoder compatibility)
    const scaledWidth = Math.floor(originalWidth * scalingFactor / 2) * 2;
    const scaledHeight = Math.floor(originalHeight * scalingFactor / 2) * 2;
    // Ensure dimensions are divisible by 16 for maximum hardware compatibility
    let finalWidth = Math.floor(scaledWidth / 16) * 16;
    let finalHeight = Math.floor(scaledHeight / 16) * 16;
    // Additional constraint: ensure dimensions are reasonable for H.264 hardware encoders
    // Some hardware encoders have issues with non-standard resolutions
    if (finalWidth < 640)
        finalWidth = 640;
    if (finalHeight < 360)
        finalHeight = 360;
    // Ensure we don't exceed common hardware encoder limits
    if (finalWidth > 1920)
        finalWidth = 1920;
    if (finalHeight > 1080)
        finalHeight = 1080;
    return { width: finalWidth, height: finalHeight, needsScaling: true };
}
/**
 * Determine target resolution based on user selection
 *
 * @param originalWidth - Original stream width
 * @param originalHeight - Original stream height
 * @param resolutionTarget - User-selected resolution target ('auto', '4k', '1080p', '720p', '540p')
 * @returns Object with target dimensions and scaling flag
 */
function determineTargetResolution(originalWidth, originalHeight, resolutionTarget) {
    switch (resolutionTarget) {
        case 'auto':
            // For auto mode, use smart scaling but snap to standard resolutions for better codec support
            const scaled = calculateScaledDimensions(originalWidth, originalHeight, 1920, 1080);
            // Snap to standard resolutions for better hardware encoder compatibility
            if (scaled.width >= 1600) {
                return { width: 1920, height: 1080, needsScaling: true }; // 1080p
            }
            else if (scaled.width >= 1200) {
                return { width: 1280, height: 720, needsScaling: true }; // 720p
            }
            else if (scaled.width >= 800) {
                return { width: 960, height: 540, needsScaling: true }; // 540p
            }
            else {
                return { width: 640, height: 360, needsScaling: true }; // 360p
            }
        case '4k':
            return { width: 3840, height: 2160, needsScaling: true };
        case '1080p':
            return { width: 1920, height: 1080, needsScaling: true };
        case '720p':
            return { width: 1280, height: 720, needsScaling: true };
        case '540p':
            return { width: 960, height: 540, needsScaling: true };
        default:
            // Fallback to 720p for unknown targets (safe standard resolution)
            console.warn('Worker: Unknown resolution target, falling back to 720p:', resolutionTarget);
            return { width: 1280, height: 720, needsScaling: true };
    }
}
/**
 * Process a video frame through downscaling using OffscreenCanvas
 *
 * @param originalFrame - The high-resolution VideoFrame to be scaled down
 */
async function processFrameWithDownscaling(originalFrame) {
    if (!canvasContext || !offscreenCanvas || !videoEncoder) {
        throw new Error('Downscaling components not initialized');
    }
    try {
        // Draw the high-resolution frame onto the scaled canvas
        canvasContext.drawImage(originalFrame, 0, 0, scaledWidth, scaledHeight);
        // Create a new, low-resolution VideoFrame from the canvas
        const scaledFrame = new VideoFrame(offscreenCanvas, {
            timestamp: originalFrame.timestamp,
            duration: originalFrame.duration || undefined
        });
        // Encode the scaled frame
        videoEncoder.encode(scaledFrame);
        // Clean up the scaled frame
        scaledFrame.close();
    }
    catch (error) {
        console.error('Worker: Error in processFrameWithDownscaling:', error);
        throw error;
    }
}
/**
 * Setup and configure the AudioEncoder for the given audio configuration
 *
 * @param audioConfig - Audio configuration from the main thread
 * @param containerType - Container type ('mp4' or 'webm') to determine codec compatibility
 */
async function setupAudioEncoder(audioConfig, containerType) {
    try {
        console.log('Worker: Setting up audio encoder with config:', audioConfig, 'container:', containerType);
        // Map audio codec to WebCodecs-compatible format based on container type
        let webCodecsCodec;
        let muxerCodec;
        switch (audioConfig.codec) {
            case 'opus':
                if (containerType !== 'webm') {
                    throw new Error('Opus codec is only supported in WebM containers');
                }
                webCodecsCodec = 'opus';
                muxerCodec = 'A_OPUS';
                break;
            case 'aac':
                if (containerType !== 'mp4') {
                    throw new Error('AAC codec is only supported in MP4 containers');
                }
                webCodecsCodec = 'mp4a.40.2'; // AAC-LC profile
                muxerCodec = 'aac';
                break;
            case 'mp3':
                if (containerType !== 'mp4') {
                    throw new Error('MP3 codec is only supported in MP4 containers');
                }
                webCodecsCodec = 'mp3';
                muxerCodec = 'mp3';
                break;
            case 'flac':
                if (containerType !== 'webm') {
                    throw new Error('FLAC codec is only supported in WebM containers');
                }
                webCodecsCodec = 'flac';
                muxerCodec = 'A_FLAC';
                break;
            default:
                throw new Error(`Unsupported audio codec: ${audioConfig.codec}`);
        }
        // Build audio encoder configuration
        const audioEncoderConfig = {
            codec: webCodecsCodec,
            sampleRate: audioConfig.sampleRate,
            numberOfChannels: audioConfig.numberOfChannels,
            bitrate: audioConfig.bitrate
        };
        console.log('Worker: Testing audio encoder configuration:', audioEncoderConfig);
        // Validate configuration support
        const configSupport = await AudioEncoder.isConfigSupported(audioEncoderConfig);
        console.log('Worker: Audio encoder configuration support:', {
            supported: configSupport.supported,
            config: configSupport.config
        });
        if (!configSupport.supported) {
            throw new Error(`Audio encoder configuration not supported: ${JSON.stringify(audioEncoderConfig)}`);
        }
        // Create AudioEncoder instance
        audioEncoder = new AudioEncoder({
            output: (chunk, metadata) => {
                try {
                    // Pass encoded audio chunk to muxer
                    if (muxer) {
                        muxer.addAudioChunk(chunk, metadata || {});
                    }
                }
                catch (error) {
                    console.error('Worker: Audio muxer error:', error);
                    self.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
                }
            },
            error: (error) => {
                console.error('Worker: AudioEncoder error:', error);
                self.postMessage({ type: 'error', error: error.message });
            }
        });
        // Configure the audio encoder
        audioEncoder.configure(configSupport.config || audioEncoderConfig);
        console.log('Worker: Audio encoder successfully configured with codec:', webCodecsCodec);
    }
    catch (error) {
        console.error('Worker: Error setting up audio encoder:', error);
        throw error;
    }
}
/**
 * Handle incoming messages from the main thread
 */
self.onmessage = (event) => {
    try {
        const { data } = event;
        // Handle different message types
        switch (data.type) {
            case 'start':
                if (data.config && data.stream) {
                    handleStartMessage(data);
                }
                break;
            case 'stop':
                handleStopMessage();
                break;
            default:
                console.warn('Worker: Unknown message type:', data);
        }
    }
    catch (error) {
        // Prevent worker crashes on malformed messages
        console.error('Worker: Error handling message:', error);
    }
};
/**
 * Handle the 'start' message from main thread
 *
 * @param data - The start message data containing config and stream
 */
async function handleStartMessage(data) {
    try {
        console.log('Worker: Received start command', {
            config: data.config,
            hasStream: !!data.stream
        });
        if (!data.config) {
            throw new Error('No configuration provided');
        }
        // Step 1: Determine target resolution based on user selection
        const originalWidth = data.config.width;
        const originalHeight = data.config.height;
        const resolutionTarget = data.config.resolutionTarget || 'auto';
        const targetDimensions = determineTargetResolution(originalWidth, originalHeight, resolutionTarget);
        // Store scaling state for processing loop
        needsScaling = targetDimensions.needsScaling;
        scaledWidth = targetDimensions.width;
        scaledHeight = targetDimensions.height;
        console.log('Worker: Resolution determination:', {
            original: { width: originalWidth, height: originalHeight },
            target: resolutionTarget,
            final: { width: scaledWidth, height: scaledHeight },
            needsScaling,
            aspectRatioPreserved: resolutionTarget === 'auto'
        });
        // Step 2: Create OffscreenCanvas if scaling is needed
        if (needsScaling) {
            offscreenCanvas = new OffscreenCanvas(scaledWidth, scaledHeight);
            canvasContext = offscreenCanvas.getContext('2d');
            if (!canvasContext) {
                throw new Error('Failed to create 2D context for downscaling canvas');
            }
            console.log('Worker: Created OffscreenCanvas for downscaling', { scaledWidth, scaledHeight });
        }
        // Step 3: Intelligent Codec Selection with Automatic Fallback
        // Sanitize frame rate to reasonable range
        const receivedFrameRate = data.config.frameRate || 30;
        const validatedFrameRate = Math.max(1, Math.min(120, receivedFrameRate));
        console.log('Worker: Received config:', data.config);
        console.log('Worker: Frame rate validation:', {
            received: receivedFrameRate,
            validated: validatedFrameRate
        });
        // Calculate keyframe interval in frames from seconds
        const keyframeIntervalFrames = data.config.keyframeIntervalSeconds
            ? Math.round(data.config.keyframeIntervalSeconds * validatedFrameRate)
            : Math.round(2 * validatedFrameRate); // Default to 2 seconds
        console.log('Worker: Keyframe interval calculation:', {
            keyframeIntervalSeconds: data.config.keyframeIntervalSeconds || 2,
            frameRate: validatedFrameRate,
            keyframeIntervalFrames
        });
        // Base encoder configuration template with advanced settings
        const baseEncoderConfig = {
            width: scaledWidth, // Use scaled dimensions
            height: scaledHeight, // Use scaled dimensions  
            bitrate: data.config.bitrate,
            framerate: validatedFrameRate, // Use validated dynamic frame rate
            keyframeInterval: keyframeIntervalFrames, // Keyframe interval in frames
            latencyMode: 'realtime', // Optimization hint for real-time encoding
            hardwareAcceleration: data.config.hardwareAcceleration || 'prefer-hardware' // User-configurable hardware acceleration
        };
        let finalCodec = null;
        let encoderConfig = null;
        try {
            // Check if a specific codec was provided in config (for testing purposes)
            if (data.config.codec) {
                console.log(`Worker: Specific codec provided in config: ${data.config.codec}`);
                // Special test mode: Force VP9 fallback by skipping all H.264 attempts
                if (data.config.codec === 'FORCE_VP9_FALLBACK') {
                    console.warn('Worker: 🧪 TEST MODE: Forcing VP9 fallback by skipping all H.264 codecs');
                    throw new Error('TEST MODE: All H.264 codecs artificially disabled');
                }
                console.log(`Worker: Testing specific codec configuration:`, { ...baseEncoderConfig, codec: data.config.codec });
                const specificConfig = { ...baseEncoderConfig, codec: data.config.codec };
                const configSupport = await VideoEncoder.isConfigSupported(specificConfig);
                console.log(`Worker: Specific codec ${data.config.codec} support result:`, configSupport);
                console.log(`Worker: Support details - supported: ${configSupport.supported}, config: ${JSON.stringify(configSupport.config)}`);
                if (configSupport.supported && configSupport.config) {
                    const accelStatus = configSupport.config.hardwareAcceleration || 'unknown';
                    console.log(`Worker: 🔧 Hardware acceleration status for ${data.config.codec}: ${accelStatus}`);
                }
                if (configSupport.supported) {
                    encoderConfig = specificConfig;
                    // Determine codec family from codec string
                    if (data.config.codec.startsWith('avc1')) {
                        finalCodec = 'h264';
                        console.log(`Worker: ✅ Specific H.264 codec configuration successful: ${data.config.codec}`);
                    }
                    else if (data.config.codec.startsWith('vp09')) {
                        finalCodec = 'vp9';
                        console.log(`Worker: ✅ Specific VP9 codec configuration successful: ${data.config.codec}`);
                    }
                    else {
                        console.warn(`Worker: ⚠️ Specific codec ${data.config.codec} accepted but codec family unknown, will proceed with unknown codec`);
                        finalCodec = 'h264'; // Default assumption for unknown codecs
                    }
                }
                else {
                    console.warn(`Worker: ❌ Specific codec ${data.config.codec} not supported, falling back to automatic selection`);
                    console.warn(`Worker: Rejection reason:`, configSupport);
                }
            }
            // If no specific codec was provided or it failed, use codec selection logic
            if (!encoderConfig) {
                const codecSelection = data.config.codecSelection || 'auto';
                console.log('Worker: Using codec selection:', codecSelection);
                // Define codec strategies in priority order
                const codecStrategies = [
                    {
                        name: 'av1',
                        codecs: ['av01.0.04M.08'], // AV1 Main Profile, Level 4.0, 8-bit
                        muxerType: 'webm',
                        mimeType: 'video/webm'
                    },
                    {
                        name: 'hevc',
                        codecs: [
                            'hvc1.1.6.L93.B0', // HEVC Main Profile, Level 3.1 (alternative)
                            'hev1.1.6.L93.B0', // HEVC Main Profile, Level 3.1
                            'hvc1.1.6.L120.B0', // HEVC Main Profile, Level 4.0 (alternative)
                            'hev1.1.6.L120.B0', // HEVC Main Profile, Level 4.0
                            'hvc1.1.6.L150.B0', // HEVC Main Profile, Level 5.0 (alternative)
                            'hev1.1.6.L150.B0', // HEVC Main Profile, Level 5.0
                            'hvc1.1.2.L93.B0', // HEVC Main Profile, different constraint flags
                            'hev1.1.2.L93.B0', // HEVC Main Profile, different constraint flags
                            'hvc1.2.4.L93.B0', // HEVC Main10 Profile (alternative)
                            'hev1.2.4.L93.B0', // HEVC Main10 Profile
                            'hvc1.1.6.L90.B0', // Level 3.0 (alternative)
                            'hev1.1.6.L90.B0', // Level 3.0
                            'hvc1.1.6.L60.B0', // Level 2.0 (alternative)
                            'hev1.1.6.L60.B0' // Level 2.0
                        ],
                        muxerType: 'mp4',
                        mimeType: 'video/mp4'
                    },
                    {
                        name: 'h264',
                        codecs: [
                            'avc1.42001f', // H.264 Baseline Profile, Level 3.1 (most common)
                            'avc1.42E01E', // H.264 Baseline Profile, Level 3.0
                            'avc1.4D401E', // H.264 Main Profile, Level 3.0
                            'avc1.640028', // H.264 High Profile, Level 4.0
                            'avc1.42001E', // H.264 Baseline Profile, Level 3.0
                            'avc1.420029' // H.264 Baseline Profile, Level 4.1
                        ],
                        muxerType: 'mp4',
                        mimeType: 'video/mp4'
                    },
                    {
                        name: 'vp9',
                        codecs: ['vp09.00.10.08'], // VP9 Profile 0, Level 1.0, 8-bit
                        muxerType: 'webm',
                        mimeType: 'video/webm'
                    }
                ];
                // Determine which strategies to try based on codec selection
                let strategiesToTry;
                if (codecSelection === 'auto') {
                    // Auto-detect: try all codecs in priority order
                    strategiesToTry = codecStrategies;
                    console.log('Worker: Auto-detect mode - trying codecs in priority order: AV1 → HEVC → H.264 → VP9');
                }
                else {
                    // Specific codec requested: try only that codec
                    strategiesToTry = codecStrategies.filter(strategy => strategy.name === codecSelection);
                    console.log(`Worker: Specific codec requested: ${codecSelection.toUpperCase()}`);
                }
                // Try each strategy in order
                for (const strategy of strategiesToTry) {
                    console.log(`Worker: Attempting ${strategy.name.toUpperCase()} codec configuration...`);
                    // Special logging for AV1 to debug Mac support
                    if (strategy.name === 'av1') {
                        console.log('Worker: 🧪 AV1 Debug - Testing AV1 encoding support on this platform...');
                        console.log('Worker: 🧪 AV1 Debug - User Agent:', navigator.userAgent);
                        console.log('Worker: 🧪 AV1 Debug - Platform:', navigator.platform);
                    }
                    for (const codec of strategy.codecs) {
                        try {
                            const testConfig = { ...baseEncoderConfig, codec };
                            console.log(`Worker: Testing ${strategy.name.toUpperCase()} codec ${codec}...`);
                            const configSupport = await VideoEncoder.isConfigSupported(testConfig);
                            console.log(`Worker: ${strategy.name.toUpperCase()} codec ${codec} support:`, {
                                supported: configSupport.supported,
                                config: configSupport.config ? {
                                    codec: configSupport.config.codec,
                                    hardwareAcceleration: configSupport.config.hardwareAcceleration,
                                    width: configSupport.config.width,
                                    height: configSupport.config.height
                                } : null
                            });
                            if (configSupport.supported) {
                                encoderConfig = testConfig;
                                finalCodec = strategy.name;
                                // Log hardware acceleration status
                                if (configSupport.config) {
                                    const accelStatus = configSupport.config.hardwareAcceleration || 'unknown';
                                    console.log(`Worker: ✅ ${strategy.name.toUpperCase()} configuration successful with codec: ${codec} (Hardware accel: ${accelStatus})`);
                                }
                                else {
                                    console.log(`Worker: ✅ ${strategy.name.toUpperCase()} configuration successful with codec: ${codec}`);
                                }
                                // Success - break out of both loops
                                break;
                            }
                            else {
                                console.log(`Worker: ❌ ${strategy.name.toUpperCase()} codec ${codec} not supported`);
                            }
                        }
                        catch (error) {
                            console.warn(`Worker: Error testing ${strategy.name.toUpperCase()} codec ${codec}:`, error);
                        }
                    }
                    // If we found a working codec, break out of strategy loop
                    if (encoderConfig) {
                        break;
                    }
                    console.warn(`Worker: ⚠️ No ${strategy.name.toUpperCase()} codec profiles were supported, trying next codec...`);
                }
                // Final error handling
                if (!encoderConfig) {
                    if (codecSelection === 'auto') {
                        throw new Error('Auto-detect failed - no supported codec profiles found in the entire fallback chain (AV1 → HEVC → H.264 → VP9)');
                    }
                    else {
                        // Provide specific error messages for each codec
                        let errorMessage = `${codecSelection.toUpperCase()} codec configuration failed`;
                        if (codecSelection === 'av1') {
                            errorMessage += ' - AV1 encoding is not supported on this system. AV1 encoding support in Chrome on macOS is very limited. Please try Auto-detect, HEVC, or H.264 instead.';
                        }
                        else if (codecSelection === 'hevc') {
                            errorMessage += ' - HEVC encoding is not supported on this system. Please try Auto-detect or H.264 instead.';
                        }
                        else {
                            errorMessage += ` - no supported ${codecSelection.toUpperCase()} profiles found`;
                        }
                        throw new Error(errorMessage);
                    }
                }
            }
        }
        catch (codecError) {
            // The new loop-based strategy already includes all fallbacks, so if we get here, everything failed
            console.error('Worker: All codec strategies failed:', codecError instanceof Error ? codecError.message : String(codecError));
            throw codecError;
        }
        if (!encoderConfig || !finalCodec) {
            throw new Error('No codec configuration succeeded');
        }
        console.log('Worker: Final encoder configuration:', encoderConfig);
        console.log('Worker: Selected codec:', finalCodec);
        // Ensure finalCodec is valid before proceeding
        if (!finalCodec) {
            throw new Error('finalCodec is null after successful codec configuration - this should not happen');
        }
        // Step 4: Instantiate appropriate muxer based on final codec selection
        // Reset chunk collection for new recording
        muxedChunks = [];
        currentCodec = encoderConfig.codec;
        // Determine container type for audio codec compatibility
        const containerType = (finalCodec === 'av1' || finalCodec === 'vp9') ? 'webm' : 'mp4';
        // Check if audio is enabled and available
        const audioEnabled = data.config.audio?.enabled === true && data.audioStream;
        if (finalCodec === 'av1') {
            // AV1 codec - use WebM muxer
            console.log('Worker: Using WebM muxer for AV1 codec', audioEnabled ? 'with audio' : 'video-only');
            const muxerConfig = {
                target: (data) => {
                    muxedChunks.push(data);
                },
                video: {
                    codec: 'V_AV01',
                    width: scaledWidth,
                    height: scaledHeight
                },
                firstTimestampBehavior: 'offset'
            };
            // Add audio track if enabled
            if (audioEnabled && data.config.audio) {
                const audioCodec = data.config.audio.codec === 'opus' ? 'A_OPUS' : 'A_FLAC';
                muxerConfig.audio = {
                    codec: audioCodec,
                    sampleRate: data.config.audio.sampleRate,
                    numberOfChannels: data.config.audio.numberOfChannels
                };
            }
            muxer = new WebMMuxer(muxerConfig);
        }
        else if (finalCodec === 'hevc') {
            // HEVC/H.265 codec - use MP4 muxer
            console.log('Worker: Using MP4 muxer for HEVC/H.265 codec', audioEnabled ? 'with audio' : 'video-only');
            mp4Target = new ArrayBufferTarget();
            const muxerConfig = {
                target: mp4Target,
                video: {
                    codec: 'hevc',
                    width: scaledWidth,
                    height: scaledHeight
                },
                fastStart: 'fragmented',
                firstTimestampBehavior: 'offset'
            };
            // Add audio track if enabled
            if (audioEnabled && data.config.audio) {
                const audioCodec = data.config.audio.codec === 'aac' ? 'aac' : 'mp3';
                muxerConfig.audio = {
                    codec: audioCodec,
                    sampleRate: data.config.audio.sampleRate,
                    numberOfChannels: data.config.audio.numberOfChannels
                };
            }
            muxer = new Muxer(muxerConfig);
        }
        else if (finalCodec === 'h264') {
            // H.264 codec - use MP4 muxer
            console.log('Worker: Using MP4 muxer for H.264 codec', audioEnabled ? 'with audio' : 'video-only');
            mp4Target = new ArrayBufferTarget();
            const muxerConfig = {
                target: mp4Target,
                video: {
                    codec: 'avc',
                    width: scaledWidth,
                    height: scaledHeight
                },
                fastStart: 'fragmented',
                firstTimestampBehavior: 'offset'
            };
            // Add audio track if enabled
            if (audioEnabled && data.config.audio) {
                const audioCodec = data.config.audio.codec === 'aac' ? 'aac' : 'mp3';
                muxerConfig.audio = {
                    codec: audioCodec,
                    sampleRate: data.config.audio.sampleRate,
                    numberOfChannels: data.config.audio.numberOfChannels
                };
            }
            muxer = new Muxer(muxerConfig);
        }
        else if (finalCodec === 'vp9') {
            // VP9 codec - use WebM muxer
            console.log('Worker: Using WebM muxer for VP9 codec', audioEnabled ? 'with audio' : 'video-only');
            const muxerConfig = {
                target: (data) => {
                    muxedChunks.push(data);
                },
                video: {
                    codec: 'V_VP9',
                    width: scaledWidth,
                    height: scaledHeight
                },
                firstTimestampBehavior: 'offset'
            };
            // Add audio track if enabled
            if (audioEnabled && data.config.audio) {
                const audioCodec = data.config.audio.codec === 'opus' ? 'A_OPUS' : 'A_FLAC';
                muxerConfig.audio = {
                    codec: audioCodec,
                    sampleRate: data.config.audio.sampleRate,
                    numberOfChannels: data.config.audio.numberOfChannels
                };
            }
            muxer = new WebMMuxer(muxerConfig);
        }
        else {
            throw new Error(`Invalid final codec: ${finalCodec}. This should never happen.`);
        }
        // Step 3: Setup Audio Encoder (if audio is enabled)
        if (audioEnabled && data.config.audio) {
            console.log('Worker: Setting up audio encoder...');
            await setupAudioEncoder(data.config.audio, containerType);
        }
        // Step 4: Instantiate VideoEncoder with output callback
        videoEncoder = new VideoEncoder({
            output: (chunk, metadata) => {
                try {
                    // Pass both chunk and metadata to the muxer - let encoder tell muxer the format
                    if (muxer) {
                        muxer.addVideoChunk(chunk, metadata || {});
                    }
                }
                catch (error) {
                    console.error('Worker: Video muxer error:', error);
                    self.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
                }
            },
            error: (error) => {
                console.error('Worker: VideoEncoder error:', error);
                self.postMessage({ type: 'error', error: error.message });
            }
        });
        // Step 5: Configure Video Encoder
        videoEncoder.configure(encoderConfig);
        // Send confirmation back to main thread with final codec information
        console.log('Worker: About to send ready message with finalCodec:', finalCodec);
        const response = {
            type: 'ready',
            finalCodec
        };
        self.postMessage(response);
        console.log('Worker: Ready message sent successfully');
        // Step 6: Start Processing - Concurrent video and audio processing
        if (!data.stream) {
            throw new Error('No video stream provided');
        }
        const processingPromises = [startVideoProcessing(data.stream)];
        // Add audio processing if audio is enabled and stream is available
        if (audioEnabled && data.audioStream) {
            console.log('Worker: Starting concurrent audio processing...');
            processingPromises.push(startAudioProcessing(data.audioStream));
        }
        // Wait for both video and audio processing to complete
        await Promise.all(processingPromises);
    }
    catch (error) {
        console.error('Worker: Error in handleStartMessage:', error);
        self.postMessage({
            type: 'error',
            error: error instanceof Error ? error.message : String(error)
        });
    }
}
/**
 * Process video frames from the stream through the encoder
 *
 * @param stream - ReadableStream of VideoFrame objects from main thread
 */
async function startVideoProcessing(stream) {
    try {
        // Get reader from the stream
        streamReader = stream.getReader();
        console.log('Worker: Starting video frame processing loop');
        // Continuous processing loop
        while (true) {
            const { done, value: frame } = await streamReader.read();
            // Check if stream is complete
            if (done) {
                console.log('Worker: Video stream ended, stopping processing');
                break;
            }
            // Backpressure management - wait for encoder to catch up
            if (videoEncoder && videoEncoder.encodeQueueSize > 30) {
                console.warn('Worker: Video encoder queue getting full, waiting for it to drain. Queue size:', videoEncoder.encodeQueueSize);
                // Wait until the queue size drops to a reasonable level
                while (videoEncoder && videoEncoder.encodeQueueSize > 15) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                console.log('Worker: Video encoder queue drained to:', videoEncoder?.encodeQueueSize);
            }
            // Encode the frame (with conditional downscaling)
            if (videoEncoder && frame) {
                if (needsScaling) {
                    // Downscaling path: process frame through OffscreenCanvas
                    await processFrameWithDownscaling(frame);
                }
                else {
                    // Direct path: encode frame as-is
                    videoEncoder.encode(frame);
                }
                // Always release the original frame memory
                frame.close();
            }
        }
    }
    catch (error) {
        console.error('Worker: Error in video processing loop:', error);
        self.postMessage({
            type: 'error',
            error: error instanceof Error ? error.message : String(error)
        });
    }
}
/**
 * Process audio frames from the stream through the encoder
 *
 * @param stream - ReadableStream of AudioData objects from main thread
 */
async function startAudioProcessing(stream) {
    try {
        // Get reader from the stream
        audioStreamReader = stream.getReader();
        console.log('Worker: Starting audio frame processing loop');
        // Continuous processing loop
        while (true) {
            const { done, value: audioFrame } = await audioStreamReader.read();
            // Check if stream is complete
            if (done) {
                console.log('Worker: Audio stream ended, stopping processing');
                break;
            }
            // Backpressure management - wait for encoder to catch up
            if (audioEncoder && audioEncoder.encodeQueueSize > 30) {
                console.warn('Worker: Audio encoder queue getting full, waiting for it to drain. Queue size:', audioEncoder.encodeQueueSize);
                // Wait until the queue size drops to a reasonable level
                while (audioEncoder && audioEncoder.encodeQueueSize > 15) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                console.log('Worker: Audio encoder queue drained to:', audioEncoder?.encodeQueueSize);
            }
            // Encode the audio frame
            if (audioEncoder && audioFrame) {
                audioEncoder.encode(audioFrame);
                // Release the original frame memory
                audioFrame.close();
            }
        }
    }
    catch (error) {
        console.error('Worker: Error in audio processing loop:', error);
        self.postMessage({
            type: 'error',
            error: error instanceof Error ? error.message : String(error)
        });
    }
}
/**
 * Handle the 'stop' message from main thread
 * Finalizes the recording and sends the complete video file back
 */
async function handleStopMessage() {
    try {
        console.log('Worker: Received stop command, finalizing recording');
        // Step 1: Cancel Stream Readers - Stop processing new frames
        if (streamReader) {
            try {
                await streamReader.cancel();
                console.log('Worker: Video stream reader cancelled');
            }
            catch (error) {
                console.warn('Worker: Error cancelling video stream reader:', error);
            }
            streamReader = null;
        }
        if (audioStreamReader) {
            try {
                await audioStreamReader.cancel();
                console.log('Worker: Audio stream reader cancelled');
            }
            catch (error) {
                console.warn('Worker: Error cancelling audio stream reader:', error);
            }
            audioStreamReader = null;
        }
        // Step 2: Flush Encoders - Process any remaining buffered frames
        if (videoEncoder) {
            try {
                await videoEncoder.flush();
                console.log('Worker: VideoEncoder flushed');
            }
            catch (error) {
                console.warn('Worker: Error flushing video encoder:', error);
            }
            // Close the encoder
            videoEncoder.close();
            videoEncoder = null;
        }
        if (audioEncoder) {
            try {
                await audioEncoder.flush();
                console.log('Worker: AudioEncoder flushed');
            }
            catch (error) {
                console.warn('Worker: Error flushing audio encoder:', error);
            }
            // Close the encoder
            audioEncoder.close();
            audioEncoder = null;
        }
        // Step 3: Finalize Muxer - Complete the video file
        let finalBlob;
        if (muxer) {
            try {
                if (currentCodec?.startsWith('avc1') || currentCodec?.startsWith('hev1') || currentCodec?.startsWith('hvc1')) {
                    // MP4 muxer with ArrayBufferTarget - buffer stored in target (H.264 and HEVC)
                    muxer.finalize();
                    if (mp4Target && mp4Target.buffer) {
                        finalBlob = new Blob([mp4Target.buffer], { type: 'video/mp4' });
                        const codecType = currentCodec?.startsWith('avc1') ? 'H.264' : 'HEVC';
                        console.log(`Worker: MP4 muxer finalized for ${codecType}, buffer size:`, mp4Target.buffer.byteLength, 'bytes');
                    }
                    else {
                        throw new Error('MP4 target buffer not available after finalization');
                    }
                }
                else {
                    // WebM muxer with callback - data collected in muxedChunks (AV1 and VP9)
                    muxer.finalize();
                    finalBlob = new Blob(muxedChunks, { type: 'video/webm' });
                    const codecType = currentCodec?.startsWith('av01') ? 'AV1' : 'VP9';
                    console.log(`Worker: WebM muxer finalized for ${codecType}, collected`, muxedChunks.length, 'chunks');
                }
            }
            catch (error) {
                console.error('Worker: Error finalizing muxer:', error);
                self.postMessage({ type: 'error', error: 'Failed to finalize video file' });
                return;
            }
            muxer = null;
        }
        else {
            console.error('Worker: No muxer available for finalization');
            self.postMessage({ type: 'error', error: 'No muxer available for finalization' });
            return;
        }
        console.log('Worker: Created final blob, size:', finalBlob.size, 'bytes', 'type:', finalBlob.type);
        // Step 4: Send File - Transfer the completed video blob to main thread
        self.postMessage({ type: 'file', blob: finalBlob });
        console.log('Worker: Video blob sent to main thread');
        // Step 5: Cleanup resources
        // Reset chunk collection
        muxedChunks = [];
        // Reset downscaling resources
        offscreenCanvas = null;
        canvasContext = null;
        needsScaling = false;
        scaledWidth = 0;
        scaledHeight = 0;
        // Reset codec state
        currentCodec = null;
        mp4Target = null;
        // Step 6: Close Worker - Terminate this worker thread
        self.close();
    }
    catch (error) {
        console.error('Worker: Error in handleStopMessage:', error);
        self.postMessage({
            type: 'error',
            error: error instanceof Error ? error.message : String(error)
        });
    }
}
//# sourceMappingURL=recorder.worker.js.map