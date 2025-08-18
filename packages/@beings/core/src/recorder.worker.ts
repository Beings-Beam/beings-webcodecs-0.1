/// <reference lib="webworker" />

/**
 * Recorder Worker - Video and Audio Encoding Implementation
 * 
 * This worker handles the heavy lifting of video and audio processing and encoding
 * for the SlowTrackRecorder. Implements WebCodecs VideoEncoder and AudioEncoder
 * with mp4-muxer and webm-muxer for container creation.
 */

// Dynamic imports to avoid worker loading issues
// import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
// import WebMMuxer from 'webm-muxer';
import type { RecorderWorkerRequest, RecorderWorkerResponse, AudioConfig, FinalEncoderConfig } from './types';

// Module-level state variables
let videoEncoder: VideoEncoder | null = null;
let muxer: any | null = null; // Will be Muxer<ArrayBufferTarget> | WebMMuxer after dynamic import
let mp4Target: any | null = null; // Will be ArrayBufferTarget after dynamic import
let streamReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let currentCodec: string | null = null;

// Audio pipeline state variables
let audioEncoder: AudioEncoder | null = null;
let audioStreamReader: ReadableStreamDefaultReader<AudioData> | null = null;

// Audio upmixing state
let needsUpmixing = false;
let originalStreamChannels = 0;
let finalEncoderChannels = 0;
let currentAudioConfig: AudioEncoderConfig | null = null;

// Final configuration tracking (ground truth for post-recording analysis)
let finalVideoConfig: VideoEncoderConfig | null = null;
let finalAudioEncoderConfig: AudioEncoderConfig | null = null;
let finalContainerType: 'mp4' | 'webm' | null = null;
let recordingStartTime: number | null = null;
let hardwareAccelerationUsed: boolean | null = null;

// Downscaling state variables
let needsScaling = false;
let scaledWidth = 0;
let scaledHeight = 0;
let offscreenCanvas: OffscreenCanvas | null = null;
let canvasContext: OffscreenCanvasRenderingContext2D | null = null;

// Muxer chunk collection state
let muxedChunks: Uint8Array[] = [];

/**
 * Calculate scaled dimensions that fit within hardware limits while preserving aspect ratio
 * 
 * @param originalWidth - Original stream width
 * @param originalHeight - Original stream height  
 * @param maxWidth - Maximum allowed width (default: 1920)
 * @param maxHeight - Maximum allowed height (default: 1080)
 * @returns Object with scaled dimensions and scaling flag
 */
function calculateScaledDimensions(
  originalWidth: number, 
  originalHeight: number, 
  maxWidth = 1920, 
  maxHeight = 1080
) {
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
  if (finalWidth < 640) finalWidth = 640;
  if (finalHeight < 360) finalHeight = 360;
  
  // Ensure we don't exceed common hardware encoder limits
  if (finalWidth > 1920) finalWidth = 1920;
  if (finalHeight > 1080) finalHeight = 1080;
  
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
function determineTargetResolution(
  originalWidth: number,
  originalHeight: number,
  resolutionTarget: string
) {
  switch (resolutionTarget) {
    case 'auto':
      // For auto mode, use smart scaling but snap to standard resolutions for better codec support
      const scaled = calculateScaledDimensions(originalWidth, originalHeight, 1920, 1080);
      
      // Snap to standard resolutions for better hardware encoder compatibility
      if (scaled.width >= 1600) {
        return { width: 1920, height: 1080, needsScaling: true }; // 1080p
      } else if (scaled.width >= 1200) {
        return { width: 1280, height: 720, needsScaling: true };  // 720p
      } else if (scaled.width >= 800) {
        return { width: 960, height: 540, needsScaling: true };   // 540p
      } else {
        return { width: 640, height: 360, needsScaling: true };   // 360p
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
 * Extract codec name from full codec string for backward compatibility
 * @param codecString - Full codec string (e.g., 'hvc1.1.6.L93.B0')
 * @returns Simple codec name (e.g., 'hevc')
 */
function extractCodecName(codecString: string): 'av1' | 'hevc' | 'h264' | 'vp9' | undefined {
  if (codecString.startsWith('av01')) return 'av1';
  if (codecString.startsWith('hvc1') || codecString.startsWith('hev1')) return 'hevc';
  if (codecString.startsWith('avc1') || codecString.startsWith('avc3')) return 'h264';
  if (codecString.startsWith('vp09')) return 'vp9';
  return undefined;
}

/**
 * Convert 32-bit float audio to 16-bit integer format for encoder compatibility
 * 
 * @param audioData - The f32 AudioData frame to be converted
 * @returns New s16 AudioData frame with converted samples
 */
function convertF32toS16(audioData: AudioData): AudioData {
  try {
    const sampleRate = audioData.sampleRate;
    const numberOfChannels = audioData.numberOfChannels;
    const numberOfFrames = audioData.numberOfFrames;
    const timestamp = audioData.timestamp;
    const duration = audioData.duration;
    
    console.log(`Worker: Converting f32 to s16 - ${numberOfChannels} channels, ${numberOfFrames} frames @ ${sampleRate}Hz`);
    
    // Calculate buffer size (interleaved format)
    const bufferSize = numberOfFrames * numberOfChannels;
    const s16Buffer = new Int16Array(bufferSize);
    
    // Copy f32 data to temporary buffer
    const f32Buffer = new Float32Array(bufferSize);
    audioData.copyTo(f32Buffer, { planeIndex: 0 });
    
    // Convert each f32 sample to s16
    for (let i = 0; i < bufferSize; i++) {
      const sample = Math.max(-1, Math.min(1, f32Buffer[i])); // Clamp to valid range
      s16Buffer[i] = Math.round(sample * 32767); // Convert to 16-bit range
    }
    
    // Create new s16 AudioData frame
    const s16AudioData = new AudioData({
      format: 's16',
      sampleRate: sampleRate,
      numberOfChannels: numberOfChannels,
      numberOfFrames: numberOfFrames,
      timestamp: timestamp,
      data: s16Buffer
    });
    
    console.log(`Worker: ✅ Converted f32 to s16 - ${numberOfChannels} channels, ${numberOfFrames} frames`);
    return s16AudioData;
    
  } catch (error) {
    console.error('Worker: Error in convertF32toS16:', error);
    throw error;
  }
}

/**
 * Upmix mono audio to stereo by duplicating the mono channel to both left and right channels
 * 
 * @param monoAudioData - The mono AudioData frame to be upmixed
 * @returns New stereo AudioData frame with duplicated channels
 */
function upmixMonoToStereo(monoAudioData: AudioData): AudioData {
  try {
    // Verify input is actually mono
    if (monoAudioData.numberOfChannels !== 1) {
      throw new Error(`Expected mono audio (1 channel), got ${monoAudioData.numberOfChannels} channels`);
    }
    
    const sampleRate = monoAudioData.sampleRate;
    const numberOfFrames = monoAudioData.numberOfFrames;
    const timestamp = monoAudioData.timestamp;
    const duration = monoAudioData.duration;
    const originalFormat = monoAudioData.format;
    
    console.log(`Worker: Upmixing mono to stereo - preserving original format: ${originalFormat}`);
    
    // Preserve the original format to prevent bit depth corruption
    // Check if the original format is 16-bit integer (s16 or s16-planar)
    const is16Bit = originalFormat === 's16' || originalFormat === 's16-planar';
    
    if (is16Bit) {
      // Handle 16-bit integer format - preserve bit depth
      const stereoBufferSize = numberOfFrames * 2; // 2 channels, interleaved
      const stereoBuffer = new Int16Array(stereoBufferSize);
      
      // Format-aware copying - check actual input format to prevent corruption
      const inputFormat = monoAudioData.format;
      console.log(`Worker: Input format detected: ${inputFormat}, treating as 16-bit output`);
      
      if (inputFormat && inputFormat.startsWith('f32')) {
        // Source is 32-bit float, convert to 16-bit integer
        console.log('Worker: Converting float32 input to int16 output');
        const monoBuffer = new Float32Array(numberOfFrames);
        monoAudioData.copyTo(monoBuffer, { planeIndex: 0 });
        
        // Convert float samples to 16-bit integers (with proper scaling)
        for (let i = 0; i < numberOfFrames; i++) {
          const sample = Math.max(-1, Math.min(1, monoBuffer[i])); // Clamp to valid range
          const intSample = Math.round(sample * 32767); // Convert to 16-bit range
          stereoBuffer[i * 2] = intSample;     // Left channel
          stereoBuffer[i * 2 + 1] = intSample; // Right channel
        }
        
      } else if (inputFormat && inputFormat.startsWith('s16')) {
        // Source is already 16-bit integer, just copy directly (no conversion!)
        console.log('Worker: Copying int16 input to int16 output (no conversion)');
        const monoBuffer = new Int16Array(numberOfFrames);
        monoAudioData.copyTo(monoBuffer, { planeIndex: 0 });
        
        // Direct copy - no format conversion needed
        for (let i = 0; i < numberOfFrames; i++) {
          const sample = monoBuffer[i];
          stereoBuffer[i * 2] = sample;     // Left channel
          stereoBuffer[i * 2 + 1] = sample; // Right channel
        }
        
      } else {
        // Handle other formats or throw an error
        throw new Error(`Unsupported source audio format for upmixing: ${inputFormat}`);
      }
      
      // Create new stereo AudioData frame with preserved 16-bit format
      const stereoAudioData = new AudioData({
        format: 's16', // Preserve 16-bit integer format
        sampleRate: sampleRate,
        numberOfChannels: 2,
        numberOfFrames: numberOfFrames,
        timestamp: timestamp,
        data: stereoBuffer
      });
      
      console.log(`Worker: ✅ Upmixed mono to stereo - preserved 16-bit format - ${numberOfFrames} frames @ ${sampleRate}Hz`);
      return stereoAudioData;
      
    } else {
      // Handle float formats - use original logic but preserve format
      const stereoBufferSize = numberOfFrames * 2; // 2 channels
      const stereoBuffer = new Float32Array(stereoBufferSize);
      
      // Copy mono data to a temporary buffer
      const monoBuffer = new Float32Array(numberOfFrames);
      monoAudioData.copyTo(monoBuffer, { planeIndex: 0 });
      
      // Duplicate mono samples to both stereo channels (interleaved format)
      for (let i = 0; i < numberOfFrames; i++) {
        const sample = monoBuffer[i];
        stereoBuffer[i * 2] = sample;     // Left channel
        stereoBuffer[i * 2 + 1] = sample; // Right channel
      }
      
      // Create new stereo AudioData frame with preserved float format
      const stereoAudioData = new AudioData({
        format: (originalFormat && originalFormat.includes('planar')) ? 'f32-planar' : 'f32',
        sampleRate: sampleRate,
        numberOfChannels: 2,
        numberOfFrames: numberOfFrames,
        timestamp: timestamp,
        data: stereoBuffer
      });
      
      console.log(`Worker: Upmixed mono to stereo - preserved float format: ${originalFormat} - ${numberOfFrames} frames @ ${sampleRate}Hz`);
      return stereoAudioData;
    }
    
  } catch (error) {
    console.error('Worker: Error in upmixMonoToStereo:', error);
    throw error;
  }
}

/**
 * Process a video frame through downscaling using OffscreenCanvas
 * 
 * @param originalFrame - The high-resolution VideoFrame to be scaled down
 */
async function processFrameWithDownscaling(originalFrame: VideoFrame): Promise<void> {
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
    
  } catch (error) {
    console.error('Worker: Error in processFrameWithDownscaling:', error);
    throw error;
  }
}

/**
 * Dynamically import and create MP4 muxer
 */
async function createMP4Muxer(config: any) {
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ ...config, target });
  return { muxer, target };
}

/**
 * Dynamically import and create WebM muxer
 */
async function createWebMMuxer(config: any) {
  const WebMMuxer = (await import('webm-muxer')).default;
  const muxer = new WebMMuxer(config);
  return muxer;
}

/**
 * Check video codec support with a timeout to prevent hanging on problematic codec checks
 * 
 * @param config - VideoEncoder configuration to test
 * @param timeout - Timeout in milliseconds (default: 2000ms)
 * @returns Promise that resolves with config support result or rejects on timeout
 */
async function checkVideoSupportWithTimeout(
  config: VideoEncoderConfig, 
  timeout = 2000
): Promise<VideoEncoderSupport> {
  console.log(`Worker: 🔍 Starting codec support check with ${timeout}ms timeout for:`, config.codec);
  return new Promise((resolve, reject) => {
    // Create timeout promise that rejects after specified time
    const timeoutPromise = new Promise<never>((_, timeoutReject) => {
      setTimeout(() => {
        console.log(`Worker: ⏱️ TIMEOUT TRIGGERED for codec ${config.codec} after ${timeout}ms`);
        timeoutReject(new Error(`Codec support check timeout after ${timeout}ms`));
      }, timeout);
    });

    // Race the actual support check against the timeout
    Promise.race([VideoEncoder.isConfigSupported(config), timeoutPromise])
      .then((result) => {
        console.log(`Worker: ✅ Codec support check completed for ${config.codec}:`, result);
        resolve(result);
      })
      .catch((error) => {
        console.log(`Worker: ❌ Codec support check failed for ${config.codec}:`, error.message);
        reject(error);
      });
  });
}

/**
 * Check audio codec support with a timeout to prevent hanging on problematic codec checks
 * 
 * @param config - AudioEncoder configuration to test
 * @param timeout - Timeout in milliseconds (default: 2000ms)
 * @returns Promise that resolves with config support result or rejects on timeout
 */
async function checkAudioSupportWithTimeout(
  config: AudioEncoderConfig, 
  timeout = 2000
): Promise<AudioEncoderSupport> {
  return new Promise((resolve, reject) => {
    // Create timeout promise that rejects after specified time
    const timeoutPromise = new Promise<never>((_, timeoutReject) => {
      setTimeout(() => {
        timeoutReject(new Error(`Codec support check timeout after ${timeout}ms`));
      }, timeout);
    });

    // Race the actual support check against the timeout
    Promise.race([AudioEncoder.isConfigSupported(config), timeoutPromise])
      .then(resolve)
      .catch(reject);
  });
}

/**
 * Setup and configure the AudioEncoder for the given audio configuration
 * 
 * @param audioConfig - Audio configuration from the main thread
 * @param containerType - Container type ('mp4' or 'webm') to determine codec compatibility
 * @param originalSampleRate - Original sample rate from the audio stream
 */
async function setupAudioEncoder(audioConfig: AudioConfig & { codec: 'auto' | 'opus' | 'aac' | 'mp3' | 'flac' }, containerType: 'mp4' | 'webm', originalSampleRate: number): Promise<void> {
  try {
    console.log('Worker: Setting up audio encoder with config:', audioConfig, 'container:', containerType);
    
    // Handle auto-selection of audio codec based on container type
    let finalAudioConfig = audioConfig;
    if (audioConfig.codec === 'auto') {
      if (containerType === 'mp4') {
        finalAudioConfig = { ...audioConfig, codec: 'aac' };
        console.log('Worker: Auto-selected AAC audio codec for MP4 container');
      } else if (containerType === 'webm') {
        finalAudioConfig = { ...audioConfig, codec: 'opus' };
        console.log('Worker: Auto-selected Opus audio codec for WebM container');
      } else {
        // Fallback to AAC as most widely supported
        finalAudioConfig = { ...audioConfig, codec: 'aac' };
        console.log('Worker: Auto-selected AAC audio codec (fallback for unknown container)');
      }
      console.log('Worker: Final audio config after auto-selection:', finalAudioConfig);
    }
    
    // Map audio codec to WebCodecs-compatible format based on container type
    let webCodecsCodec: string;
    let muxerCodec: string;
    
    switch (finalAudioConfig.codec) {
      case 'opus':
        if (containerType !== 'webm') {
          // Auto-convert OPUS to AAC for MP4 containers
          console.log('Worker: Auto-converting OPUS to AAC for MP4 container compatibility');
          webCodecsCodec = 'mp4a.40.2'; // AAC-LC profile
          muxerCodec = 'aac';
        } else {
          webCodecsCodec = 'opus';
          muxerCodec = 'A_OPUS';
        }
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
        throw new Error(`Unsupported audio codec: ${finalAudioConfig.codec}`);
    }
    
    // Build audio encoder configuration
    // Always use the original stream's sample rate to prevent mismatches
    let sampleRate = originalSampleRate;
    let numberOfChannels = finalAudioConfig.numberOfChannels;
    
    console.log(`Worker: Using original stream sample rate: ${sampleRate}Hz (configured: ${finalAudioConfig.sampleRate}Hz)`);
    
    let audioEncoderConfig: AudioEncoderConfig = {
      codec: webCodecsCodec,
      sampleRate: sampleRate,
      numberOfChannels: numberOfChannels,
      bitrate: finalAudioConfig.bitrate
    };
    
    console.log('Worker: Testing audio encoder configuration:', audioEncoderConfig);
    
    // Validate configuration support with timeout and fallback strategy
    let configSupport = await checkAudioSupportWithTimeout(audioEncoderConfig, 2000);
    console.log('Worker: Audio encoder configuration support:', {
      supported: configSupport.supported,
      config: configSupport.config
    });
    
    console.log('Worker: Detailed encoder config comparison:', {
      requested: audioEncoderConfig,
      supported: configSupport.config
    });
    
    // If initial config is not supported, try fallback configurations
    if (!configSupport.supported) {
      console.log('Worker: Initial audio config not supported, trying fallback configurations...');
      
      // Fallback strategy: try different configurations in order of preference
      const fallbackConfigs = [];
      
      if (finalAudioConfig.codec === 'aac') {
        // AAC fallbacks - try to preserve original channel count first, then change channels as last resort
        fallbackConfigs.push(
          // First priority: Try different bitrates with ORIGINAL channel count
          { ...audioEncoderConfig, bitrate: 192000 },
          { ...audioEncoderConfig, bitrate: 128000 },
          { ...audioEncoderConfig, bitrate: 96000 },
          { ...audioEncoderConfig, bitrate: 64000 },
          // Second priority: Only if original channel count fails, try stereo
          { ...audioEncoderConfig, numberOfChannels: 2, bitrate: 192000 },
          { ...audioEncoderConfig, numberOfChannels: 2, bitrate: 128000 },
          { ...audioEncoderConfig, numberOfChannels: 2, bitrate: 96000 },
          { ...audioEncoderConfig, numberOfChannels: 2, bitrate: 64000 },
          // Last resort: Try minimal config
          { codec: 'mp4a.40.2', sampleRate: originalSampleRate, numberOfChannels: 2, bitrate: 128000 }
        );
      } else if (finalAudioConfig.codec === 'opus') {
        // Opus fallbacks - try to preserve original channel count first, then change channels as last resort
        fallbackConfigs.push(
          // First priority: Try different bitrates with ORIGINAL channel count
          { ...audioEncoderConfig, bitrate: 192000 },
          { ...audioEncoderConfig, bitrate: 128000 },
          { ...audioEncoderConfig, bitrate: 96000 },
          { ...audioEncoderConfig, bitrate: 64000 },
          // Second priority: Only if original channel count fails, try stereo
          { ...audioEncoderConfig, numberOfChannels: 2, bitrate: 192000 },
          { ...audioEncoderConfig, numberOfChannels: 2, bitrate: 128000 },
          { ...audioEncoderConfig, numberOfChannels: 2, bitrate: 96000 },
          { ...audioEncoderConfig, numberOfChannels: 2, bitrate: 64000 },
          // Last resort: Try minimal config
          { codec: 'opus', sampleRate: originalSampleRate, numberOfChannels: 2, bitrate: 128000 }
        );
      }
      
      // Try each fallback configuration
      let fallbackWorked = false;
      for (let i = 0; i < fallbackConfigs.length; i++) {
        const fallbackConfig = fallbackConfigs[i];
        console.log(`Worker: Trying fallback audio config ${i + 1}/${fallbackConfigs.length}:`, fallbackConfig);
        
        try {
          const fallbackSupport = await checkAudioSupportWithTimeout(fallbackConfig, 2000);
          if (fallbackSupport.supported) {
            console.log(`Worker: ✅ Fallback audio config ${i + 1} succeeded:`, fallbackConfig);
            audioEncoderConfig = fallbackConfig;
            configSupport = fallbackSupport;
            fallbackWorked = true;
            break;
          } else {
            console.log(`Worker: ❌ Fallback audio config ${i + 1} not supported`);
          }
        } catch (error) {
          console.log(`Worker: ❌ Fallback audio config ${i + 1} failed:`, error instanceof Error ? error.message : String(error));
        }
      }
      
      if (!fallbackWorked) {
        console.warn(`Worker: All audio configurations failed at ${originalSampleRate}Hz sample rate, disabling audio recording`);
        throw new Error(`No supported audio encoder configuration found at ${originalSampleRate}Hz. Tried ${fallbackConfigs.length + 1} configurations. Browser may not support this sample rate. Falling back to video-only recording.`);
      }
    }
    
    // Create AudioEncoder instance
    audioEncoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => {
        try {
          // Pass encoded audio chunk to muxer
          if (muxer) {
            muxer.addAudioChunk(chunk, metadata || {});
          }
        } catch (error) {
          console.error('Worker: Audio muxer error:', error);
          self.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      },
      error: (error: Error) => {
        console.error('Worker: AudioEncoder error:', error);
        self.postMessage({ type: 'error', error: error.message });
      }
    });
    
    // Store the final configuration for later reference
    currentAudioConfig = configSupport.config || audioEncoderConfig;
    
    // Configure the audio encoder
    audioEncoder.configure(currentAudioConfig);
    
    // Capture final audio configuration for post-recording analysis
    finalAudioEncoderConfig = currentAudioConfig ? { ...currentAudioConfig } : null;
    
    // Detect channel mismatch and set up upmixing if needed
    originalStreamChannels = finalAudioEncoderConfig?.numberOfChannels || 0;
    finalEncoderChannels = currentAudioConfig.numberOfChannels;
    
    if (originalStreamChannels === 1 && finalEncoderChannels === 2) {
      needsUpmixing = true;
      console.log('Worker: 🎵 Channel mismatch detected - enabling mono-to-stereo upmixing');
      console.log(`Worker: Stream channels: ${originalStreamChannels}, Encoder channels: ${finalEncoderChannels}`);
    } else if (originalStreamChannels !== finalEncoderChannels) {
      console.warn(`Worker: ⚠️ Unsupported channel mismatch - Stream: ${originalStreamChannels}, Encoder: ${finalEncoderChannels}`);
      console.warn('Worker: This configuration may cause audio processing issues');
    } else {
      needsUpmixing = false;
      console.log(`Worker: ✅ Channel configuration matches - ${originalStreamChannels} channels`);
    }
    
    console.log('Worker: Audio encoder successfully configured with codec:', webCodecsCodec);
    
  } catch (error) {
    console.error('Worker: Error setting up audio encoder:', error);
    throw error;
  }
}

/**
 * Handle incoming messages from the main thread
 */
self.onmessage = (event: MessageEvent<RecorderWorkerRequest>) => {
  console.log('🔔 Worker: Received message:', event.data.type);
  try {
    const { data } = event;
    
    // Handle different message types
    switch (data.type) {
      case 'start':
        console.log('🎬 Worker: Processing start message...');
        if (data.config && data.stream) {
          handleStartMessage(data as RecorderWorkerRequest & { config: any; stream: ReadableStream<VideoFrame> });
        }
        break;
      
      case 'stop':
        console.log('🛑 Worker: Processing stop message...');
        handleStopMessage();
        break;
      
      default:
        console.warn('Worker: Unknown message type:', data);
    }
  } catch (error) {
    // Prevent worker crashes on malformed messages
    console.error('Worker: Error handling message:', error);
  }
};

console.log('✅ Worker: Message handler registered, worker ready to receive messages');

/**
 * Handle the 'start' message from main thread
 * 
 * @param data - The start message data containing config and stream
 */
async function handleStartMessage(data: RecorderWorkerRequest): Promise<void> {
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
      width: scaledWidth,  // Use scaled dimensions
      height: scaledHeight, // Use scaled dimensions  
      bitrate: data.config.bitrate,
      framerate: validatedFrameRate, // Use validated dynamic frame rate
      keyframeInterval: keyframeIntervalFrames, // Keyframe interval in frames
      latencyMode: 'realtime' as LatencyMode, // Optimization hint for real-time encoding
      hardwareAcceleration: data.config.hardwareAcceleration || 'prefer-hardware' // User-configurable hardware acceleration
    };

    let finalCodec: 'av1' | 'hevc' | 'h264' | 'vp9' | null = null;
    let encoderConfig: any = null;

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
        
        const configSupport = await checkVideoSupportWithTimeout(specificConfig, 2000);
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
          } else if (data.config.codec.startsWith('vp09')) {
            finalCodec = 'vp9';
            console.log(`Worker: ✅ Specific VP9 codec configuration successful: ${data.config.codec}`);
          } else {
            console.warn(`Worker: ⚠️ Specific codec ${data.config.codec} accepted but codec family unknown, will proceed with unknown codec`);
            finalCodec = 'h264'; // Default assumption for unknown codecs
          }
        } else {
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
              'hvc1.1.6.L93.B0',    // HEVC Main Profile, Level 3.1 (alternative)
              'hev1.1.6.L93.B0',    // HEVC Main Profile, Level 3.1
              'hvc1.1.6.L120.B0',   // HEVC Main Profile, Level 4.0 (alternative)
              'hev1.1.6.L120.B0',   // HEVC Main Profile, Level 4.0
              'hvc1.1.6.L150.B0',   // HEVC Main Profile, Level 5.0 (alternative)
              'hev1.1.6.L150.B0',   // HEVC Main Profile, Level 5.0
              'hvc1.1.2.L93.B0',    // HEVC Main Profile, different constraint flags
              'hev1.1.2.L93.B0',    // HEVC Main Profile, different constraint flags
              'hvc1.2.4.L93.B0',    // HEVC Main10 Profile (alternative)
              'hev1.2.4.L93.B0',    // HEVC Main10 Profile
              'hvc1.1.6.L90.B0',    // Level 3.0 (alternative)
              'hev1.1.6.L90.B0',    // Level 3.0
              'hvc1.1.6.L60.B0',    // Level 2.0 (alternative)
              'hev1.1.6.L60.B0'     // Level 2.0
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
              'avc1.420029'  // H.264 Baseline Profile, Level 4.1
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
        let strategiesToTry: typeof codecStrategies;
        if (codecSelection === 'auto') {
          // Auto-detect: try all codecs in priority order
          strategiesToTry = codecStrategies;
          console.log('Worker: Auto-detect mode - trying codecs in priority order: AV1 → HEVC → H.264 → VP9');
        } else {
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
              
              const configSupport = await checkVideoSupportWithTimeout(testConfig, 2000);
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
                finalCodec = strategy.name as 'av1' | 'hevc' | 'h264' | 'vp9';
                
                // Log hardware acceleration status
                if (configSupport.config) {
                  const accelStatus = configSupport.config.hardwareAcceleration || 'unknown';
                  console.log(`Worker: ✅ ${strategy.name.toUpperCase()} configuration successful with codec: ${codec} (Hardware accel: ${accelStatus})`);
                } else {
                  console.log(`Worker: ✅ ${strategy.name.toUpperCase()} configuration successful with codec: ${codec}`);
                }
                
                // Success - break out of both loops
                break;
              } else {
                console.log(`Worker: ❌ ${strategy.name.toUpperCase()} codec ${codec} not supported`);
              }
            } catch (error) {
              // Handle both timeout errors and other codec check errors
              if (error instanceof Error && error.message.includes('timeout')) {
                console.warn(`Worker: ⏱️ ${strategy.name.toUpperCase()} codec ${codec} check timed out after 2 seconds - likely hanging, skipping to next codec`);
              } else {
                console.warn(`Worker: Error testing ${strategy.name.toUpperCase()} codec ${codec}:`, error);
              }
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
          } else {
            // Provide specific error messages for each codec
            let errorMessage = `${codecSelection.toUpperCase()} codec configuration failed`;
            if (codecSelection === 'av1') {
              errorMessage += ' - AV1 encoding is not supported on this system. AV1 encoding support in Chrome on macOS is very limited. Please try Auto-detect, HEVC, or H.264 instead.';
            } else if (codecSelection === 'hevc') {
              errorMessage += ' - HEVC encoding is not supported on this system. Please try Auto-detect or H.264 instead.';
            } else {
              errorMessage += ` - no supported ${codecSelection.toUpperCase()} profiles found`;
            }
            throw new Error(errorMessage);
          }
        }
      }

    } catch (codecError) {
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
    const containerType: 'mp4' | 'webm' = (finalCodec === 'av1' || finalCodec === 'vp9') ? 'webm' : 'mp4';
    
    // Check if audio is enabled and available
    let audioEnabled = data.config.audio?.enabled === true && data.audioStream;
    
    if (finalCodec === 'av1') {
      // AV1 codec - use WebM muxer
      console.log('Worker: Using WebM muxer for AV1 codec', audioEnabled ? 'with audio' : 'video-only');
      const muxerConfig: any = {
        target: (data: any) => {
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
      
      muxer = await createWebMMuxer(muxerConfig);
    } else if (finalCodec === 'hevc') {
      // HEVC/H.265 codec - use MP4 muxer
      console.log('Worker: Using MP4 muxer for HEVC/H.265 codec', audioEnabled ? 'with audio' : 'video-only');
      const muxerConfig: any = {
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
        // For MP4 containers, use AAC (OPUS and other codecs are not compatible)
        const audioCodec = 'aac';
        muxerConfig.audio = {
          codec: audioCodec,
          sampleRate: data.config.audio.sampleRate,
          numberOfChannels: data.config.audio.numberOfChannels
        };
        console.log(`Worker: Using AAC audio codec for HEVC/MP4 container (original request: ${data.config.audio.codec})`);
      }
      
      const { muxer: mp4Muxer, target } = await createMP4Muxer(muxerConfig);
      muxer = mp4Muxer;
      mp4Target = target;
    } else if (finalCodec === 'h264') {
      // H.264 codec - use MP4 muxer
      console.log('Worker: Using MP4 muxer for H.264 codec', audioEnabled ? 'with audio' : 'video-only');
      const muxerConfig: any = {
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
        // For MP4 containers, use AAC (OPUS and other codecs are not compatible)
        const audioCodec = 'aac';
        muxerConfig.audio = {
          codec: audioCodec,
          sampleRate: data.config.audio.sampleRate,
          numberOfChannels: data.config.audio.numberOfChannels
        };
        console.log(`Worker: Using AAC audio codec for H.264/MP4 container (original request: ${data.config.audio.codec})`);
      }
      
      const { muxer: mp4Muxer, target } = await createMP4Muxer(muxerConfig);
      muxer = mp4Muxer;
      mp4Target = target;
    } else if (finalCodec === 'vp9') {
      // VP9 codec - use WebM muxer
      console.log('Worker: Using WebM muxer for VP9 codec', audioEnabled ? 'with audio' : 'video-only');
      const muxerConfig: any = {
        target: (data: any) => {
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
      
      muxer = await createWebMMuxer(muxerConfig);
    } else {
      throw new Error(`Invalid final codec: ${finalCodec}. This should never happen.`);
    }

    // Step 3: Setup Audio Encoder (if audio is enabled)
    if (audioEnabled && data.config.audio) {
      try {
        console.log('Worker: Setting up audio encoder...');
        
        // Extract original sample rate from the audio configuration
        // The main thread should have passed the detected sample rate in the config
        const originalSampleRate = data.config.audio.sampleRate;
        console.log('Worker: Using original audio sample rate:', originalSampleRate, 'Hz');
        
        await setupAudioEncoder(data.config.audio, containerType, originalSampleRate);
        console.log('Worker: ✅ Audio encoder setup successful');
      } catch (audioError) {
        console.warn('Worker: ⚠️ Audio setup failed, proceeding with video-only recording:', audioError instanceof Error ? audioError.message : String(audioError));
        // Disable audio for this recording session
        audioEnabled = false;
        // Continue with video-only recording
      }
    }

    // Step 4: Instantiate VideoEncoder with output callback
    videoEncoder = new VideoEncoder({
      output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => {
        try {
          // Pass both chunk and metadata to the muxer - let encoder tell muxer the format
          if (muxer) {
            muxer.addVideoChunk(chunk, metadata || {});
          }
        } catch (error) {
          console.error('Worker: Video muxer error:', error);
          self.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      },
      error: (error: Error) => {
        console.error('Worker: VideoEncoder error:', error);
        self.postMessage({ type: 'error', error: error.message });
      }
    });

    // Step 5: Configure Video Encoder
    videoEncoder.configure(encoderConfig);
    
    // Capture final video configuration for post-recording analysis
    finalVideoConfig = { ...encoderConfig };
    finalContainerType = containerType;
    
    // Capture hardware acceleration status from the encoder configuration
    hardwareAccelerationUsed = encoderConfig.hardwareAcceleration === 'prefer-hardware';

    // Send confirmation back to main thread with final codec information
    console.log('Worker: About to send ready message with finalCodec:', finalCodec);
    const response: RecorderWorkerResponse = {
      type: 'ready',
      finalCodec
    };
    self.postMessage(response);
    console.log('Worker: Ready message sent successfully');

    // Step 6: Start Processing - Concurrent video and audio processing
    if (!data.stream) {
      throw new Error('No video stream provided');
    }

    const processingPromises: Promise<void>[] = [startVideoProcessing(data.stream)];
    
    // Add audio processing if audio is enabled and stream is available
    if (audioEnabled && data.audioStream) {
      console.log('Worker: Starting concurrent audio processing...');
      processingPromises.push(startAudioProcessing(data.audioStream));
    }
    
    // Wait for both video and audio processing to complete
    await Promise.all(processingPromises);

  } catch (error) {
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
async function startVideoProcessing(stream: ReadableStream<VideoFrame>): Promise<void> {
  try {
    // Get reader from the stream
    streamReader = stream.getReader();
    
    console.log('Worker: Starting video frame processing loop');
    
    // Capture recording start time for duration calculation
    if (recordingStartTime === null) {
      recordingStartTime = performance.now();
    }
    
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
        } else {
          // Direct path: encode frame as-is
          videoEncoder.encode(frame);
        }
        // Always release the original frame memory
        frame.close();
      }
    }
    
  } catch (error) {
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
async function startAudioProcessing(stream: ReadableStream<AudioData>): Promise<void> {
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
        let frameToEncode = audioFrame;
        let needsCleanup = false;
        
        try {
          // Debug audio frame properties
          console.log('Worker: Processing audio frame:', {
            sampleRate: audioFrame.sampleRate,
            numberOfChannels: audioFrame.numberOfChannels,
            numberOfFrames: audioFrame.numberOfFrames,
            format: audioFrame.format,
            needsUpmixing: needsUpmixing
          });
          
          // Handle channel mismatch with upmixing
          if (needsUpmixing && audioFrame.numberOfChannels === 1 && finalEncoderChannels === 2) {
            console.log('Worker: 🎵 Upmixing mono frame to stereo');
            frameToEncode = upmixMonoToStereo(audioFrame);
            needsCleanup = true; // We created a new frame that needs cleanup
          } else if (currentAudioConfig && audioFrame.numberOfChannels !== currentAudioConfig.numberOfChannels) {
            console.warn(`Worker: ⚠️ Unsupported channel mismatch - Frame has ${audioFrame.numberOfChannels} channels, encoder expects ${currentAudioConfig.numberOfChannels}. Skipping frame.`);
            audioFrame.close();
            return;
          }
          
          // Check for sample rate mismatches
          if (currentAudioConfig && audioFrame.sampleRate !== currentAudioConfig.sampleRate) {
            console.warn(`Worker: Sample rate mismatch - Frame has ${audioFrame.sampleRate}Hz, encoder expects ${currentAudioConfig.sampleRate}Hz. Skipping frame.`);
            audioFrame.close();
            if (needsCleanup && frameToEncode !== audioFrame) {
              frameToEncode.close();
            }
            return;
          }
          
          // Check for format mismatch and convert if needed
          let finalFrameToEncode = frameToEncode;
          let formatConversionNeeded = false;
          
          if (frameToEncode.format && frameToEncode.format.startsWith('f32') && 
              currentAudioConfig && currentAudioConfig.codec && currentAudioConfig.codec.includes('aac')) {
            // Convert f32 to s16 for AAC encoder compatibility
            console.log('Worker: 🔄 Converting f32 audio to s16 for AAC encoder');
            finalFrameToEncode = convertF32toS16(frameToEncode);
            formatConversionNeeded = true;
          }
          
          // Encode the frame (original, upmixed, or format-converted)
          audioEncoder.encode(finalFrameToEncode);
          
          // Clean up frames
          if (formatConversionNeeded && finalFrameToEncode !== frameToEncode) {
            finalFrameToEncode.close(); // Close the converted frame
          }
          
        } catch (error) {
          console.error('Worker: Error processing audio frame:', {
            sampleRate: audioFrame.sampleRate,
            numberOfChannels: audioFrame.numberOfChannels,
            numberOfFrames: audioFrame.numberOfFrames,
            format: audioFrame.format,
            needsUpmixing: needsUpmixing,
            error: error
          });
          // Cleanup on error
          if (needsCleanup && frameToEncode !== audioFrame) {
            frameToEncode.close();
          }
          throw error;
        }
        
        // Release frame memory
        audioFrame.close();
        if (needsCleanup && frameToEncode !== audioFrame) {
          frameToEncode.close();
        }
      }
    }
    
  } catch (error) {
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
async function handleStopMessage(): Promise<void> {
  try {
    console.log('Worker: Received stop command, finalizing recording');

    // Step 1: Cancel Stream Readers - Stop processing new frames
    if (streamReader) {
      try {
        await streamReader.cancel();
        console.log('Worker: Video stream reader cancelled');
      } catch (error) {
        console.warn('Worker: Error cancelling video stream reader:', error);
      }
      streamReader = null;
    }

    if (audioStreamReader) {
      try {
        await audioStreamReader.cancel();
        console.log('Worker: Audio stream reader cancelled');
      } catch (error) {
        console.warn('Worker: Error cancelling audio stream reader:', error);
      }
      audioStreamReader = null;
    }

    // Step 2: Flush Encoders - Process any remaining buffered frames
    if (videoEncoder) {
      try {
        await videoEncoder.flush();
        console.log('Worker: VideoEncoder flushed');
      } catch (error) {
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
      } catch (error) {
        console.warn('Worker: Error flushing audio encoder:', error);
      }
      // Close the encoder
      audioEncoder.close();
      audioEncoder = null;
      currentAudioConfig = null;
    }

    // Step 3: Finalize Muxer - Complete the video file
    let finalBlob: Blob;
    if (muxer) {
      try {
        if (currentCodec?.startsWith('avc1') || currentCodec?.startsWith('hev1') || currentCodec?.startsWith('hvc1')) {
          // MP4 muxer with ArrayBufferTarget - buffer stored in target (H.264 and HEVC)
          muxer.finalize();
          if (mp4Target && mp4Target.buffer) {
            finalBlob = new Blob([mp4Target.buffer], { type: 'video/mp4' });
            const codecType = currentCodec?.startsWith('avc1') ? 'H.264' : 'HEVC';
            console.log(`Worker: MP4 muxer finalized for ${codecType}, buffer size:`, mp4Target.buffer.byteLength, 'bytes');
          } else {
            throw new Error('MP4 target buffer not available after finalization');
          }
        } else {
          // WebM muxer with callback - data collected in muxedChunks (AV1 and VP9)
          muxer.finalize();
          finalBlob = new Blob(muxedChunks as BlobPart[], { type: 'video/webm' });
          const codecType = currentCodec?.startsWith('av01') ? 'AV1' : 'VP9';
          console.log(`Worker: WebM muxer finalized for ${codecType}, collected`, muxedChunks.length, 'chunks');
        }
      } catch (error) {
        console.error('Worker: Error finalizing muxer:', error);
        self.postMessage({ type: 'error', error: 'Failed to finalize video file' });
        return;
      }
      muxer = null;
    } else {
      console.error('Worker: No muxer available for finalization');
      self.postMessage({ type: 'error', error: 'No muxer available for finalization' });
      return;
    }

    console.log('Worker: Created final blob, size:', finalBlob.size, 'bytes', 'type:', finalBlob.type);

    // Step 4: Assemble Final Configuration Data
    const recordingEndTime = performance.now();
    const recordingDuration = recordingStartTime ? (recordingEndTime - recordingStartTime) : 0;
    
    let finalConfig: FinalEncoderConfig | undefined = undefined;
    
    if (finalVideoConfig && finalContainerType) {
      finalConfig = {
        video: {
          ...finalVideoConfig,
          hardwareAccelerationUsed: hardwareAccelerationUsed ?? false
        },
        audio: finalAudioEncoderConfig ? { ...finalAudioEncoderConfig } : undefined,
        container: finalContainerType,
        duration: recordingDuration
      };
      
      console.log('Worker: Final configuration assembled:', finalConfig);
    } else {
      console.warn('Worker: Could not assemble final configuration - missing video config or container type');
    }

    // Step 5: Send File - Transfer the completed video blob and final config to main thread
    const response: RecorderWorkerResponse = {
      type: 'file', 
      blob: finalBlob,
      finalConfig: finalConfig,
      finalCodec: finalVideoConfig?.codec ? extractCodecName(finalVideoConfig.codec) : undefined
    };
    
    self.postMessage(response);
    console.log('Worker: Video blob and final config sent to main thread');

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
    
    // Reset audio upmixing state
    needsUpmixing = false;
    originalStreamChannels = 0;
    finalEncoderChannels = 0;
    currentAudioConfig = null;
    
    // Reset final configuration tracking
    finalVideoConfig = null;
    finalAudioEncoderConfig = null;
    finalContainerType = null;
    recordingStartTime = null;
    hardwareAccelerationUsed = null;

    // Step 6: Close Worker - Terminate this worker thread
    self.close();

  } catch (error) {
    console.error('Worker: Error in handleStopMessage:', error);
    self.postMessage({ 
      type: 'error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
}

