/// <reference lib="webworker" />

/**
 * Legacy Single Recorder Worker - DEPRECATED
 * 
 * @deprecated This single-worker implementation has been replaced by the dual-worker
 * architecture (video.worker.ts + audio.worker.ts) to eliminate performance bottlenecks.
 * 
 * The single-worker approach suffered from resource contention where high-frequency 
 * audio processing would starve the video encoder, causing frame drops and A/V sync issues.
 * 
 * This file is maintained for compatibility during transition period only.
 * Will be removed in v2.0. Use the new dual-worker architecture instead.
 * 
 * @see video.worker.ts - Dedicated video processing worker
 * @see audio.worker.ts - Dedicated audio processing worker
 * @see SlowTrackRecorder.ts - Main conductor class
 */

// Dynamic imports to avoid worker loading issues
// import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
// import WebMMuxer from 'webm-muxer';
import type { RecorderWorkerRequest, RecorderWorkerResponse, AudioConfig, FinalEncoderConfig, SyncData } from './types';

// Module-level state variables
let videoEncoder: VideoEncoder | null = null;
let muxer: any | null = null; // Will be Muxer<ArrayBufferTarget> | WebMMuxer after dynamic import
let mp4Target: any | null = null; // Will be ArrayBufferTarget after dynamic import
let streamReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let currentCodec: string | null = null;
let needsKeyFrame = false;

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

// 🚀 NEW ARCHITECTURE: Timestamp tracking for worker-side normalization
let firstVideoTimestamp: number | null = null;
let firstAudioTimestamp: number | null = null;

// Downscaling state variables
let needsScaling = false;
let scaledWidth = 0;
let scaledHeight = 0;
let offscreenCanvas: OffscreenCanvas | null = null;
let canvasContext: OffscreenCanvasRenderingContext2D | null = null;

// Muxer chunk collection state
let muxedChunks: Uint8Array[] = [];

// Drift detection configuration and state
const ENABLE_DRIFT_DETECTION = true;
const SYNC_UPDATE_FRAME_INTERVAL = 30; // Send an update roughly once per second at 30fps
let videoFramesProcessed = 0;
let audioFramesProcessed = 0;
let videoFramesDropped = 0;

// Time-based sync tracking (more accurate than frame counting)
let totalVideoTimeProcessed = 0; // Total video time in milliseconds
let totalAudioTimeProcessed = 0; // Total audio time in milliseconds

// Event-driven backpressure management with hysteresis
// 🎯 COORDINATED BACKPRESSURE: Lowered thresholds for better main thread coordination
const HIGH_WATER_MARK = 8;   // Start throttling (was 30, too high)
const LOW_WATER_MARK = 3;    // Resume processing (was 10, too high)
const CRITICAL_WATER_MARK = 15; // Emergency threshold for force-dropping
const HYSTERESIS_COOLDOWN_MS = 500; // Prevent flapping with 500ms cooldown (reduced for responsiveness)
let isThrottled = false;
let lastLowPressureTimestamp = 0;
let consecutiveHighPressureCount = 0;

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
 * Send A/V sync diagnostics update to main thread
 * Calculates drift as time difference in milliseconds (positive = audio ahead)
 */
function sendSyncUpdate(): void {
  if (!ENABLE_DRIFT_DETECTION) return;
  
  // Calculate time-based drift in milliseconds
  const timeDrift = totalAudioTimeProcessed - totalVideoTimeProcessed;
  
  // Also calculate frame-based drift for legacy compatibility
  const frameDrift = audioFramesProcessed - videoFramesProcessed;
  
  const syncData: SyncData = {
    videoFramesProcessed,
    audioFramesProcessed,
    drift: Math.round(timeDrift), // Use time-based drift as primary metric
    timestamp: performance.now()
  };
  
  // 🎬 A/V SYNC CONSOLE LOGGING with encoder queue status
  const absDrift = Math.abs(syncData.drift);
  const videoQueue = videoEncoder?.encodeQueueSize || 0;
  const audioQueue = audioEncoder?.encodeQueueSize || 0;
  
  if (absDrift > 15) {
    console.warn(`🚨 Worker: SIGNIFICANT A/V DRIFT detected: ${syncData.drift}ms (Video: ${videoFramesProcessed} frames, Audio: ${audioFramesProcessed} frames) | Queues - Video: ${videoQueue}, Audio: ${audioQueue}`);
  } else if (absDrift > 5) {
    console.log(`⚠️ Worker: Minor A/V drift: ${syncData.drift}ms (Video: ${videoFramesProcessed}, Audio: ${audioFramesProcessed}) | Queues - Video: ${videoQueue}, Audio: ${audioQueue}`);
  } else if (videoFramesProcessed % 150 === 0) { // Log perfect sync less frequently (every 5 seconds at 30fps)
    console.log(`✅ Worker: Perfect A/V sync: ${syncData.drift}ms drift (Video: ${videoFramesProcessed}, Audio: ${audioFramesProcessed}) | Queues - Video: ${videoQueue}, Audio: ${audioQueue}`);
  }
  
  // 📊 COMPREHENSIVE HEALTH CHECK: Replace individual per-frame logs with periodic summary
  if (videoFramesProcessed % 150 === 0) {
    const healthDuration = Math.round(performance.now() / 1000);
    console.log(`📊 Health Check (${healthDuration}s): Video Frames: ${videoFramesProcessed}, Audio Frames: ${audioFramesProcessed}, A/V Drift: ${timeDrift.toFixed(0)}ms, Queues(V/A): ${videoQueue}/${audioQueue}, Mode: ${needsScaling ? 'downscaling' : 'direct'}, Dropped: ${videoFramesDropped}`);
  }
  
  self.postMessage({
    type: 'sync-update',
    syncData
  });
}

/**
 * Check encoder queue size and emit backpressure events when thresholds are crossed
 * This implements event-driven flow control with hysteresis to prevent system flapping
 */
function checkQueueAndNotify(): void {
  if (!videoEncoder) return;
  
  const queueSize = videoEncoder.encodeQueueSize;
  const audioQueueSize = audioEncoder?.encodeQueueSize || 0;
  const currentTime = performance.now();

  if (queueSize > HIGH_WATER_MARK && !isThrottled) {
    // Check hysteresis: only trigger high pressure if sufficient cooldown has elapsed
    const timeSinceLastLow = currentTime - lastLowPressureTimestamp;
    
    if (timeSinceLastLow >= HYSTERESIS_COOLDOWN_MS || lastLowPressureTimestamp === 0) {
      isThrottled = true;
      consecutiveHighPressureCount++;
      
      // Calculate exponential backoff for repeated high pressure conditions
      const backoffMultiplier = Math.min(consecutiveHighPressureCount, 4); // Cap at 4x
      
      console.warn(`Worker: Backpressure HIGH (attempt ${consecutiveHighPressureCount}, backoff ${backoffMultiplier}x) - video queue: ${queueSize}, audio queue: ${audioQueueSize}`);
      self.postMessage({ 
        type: 'pressure', 
        status: 'high',
        videoQueueSize: queueSize,
        audioQueueSize: audioQueueSize,
        consecutiveCount: consecutiveHighPressureCount,
        backoffMultiplier: backoffMultiplier
      });
    } else {
      // Within cooldown period, log but don't emit event
      console.log(`Worker: Queue high (${queueSize}) but within hysteresis cooldown (${Math.round(timeSinceLastLow)}ms < ${HYSTERESIS_COOLDOWN_MS}ms)`);
    }
  } else if (queueSize < LOW_WATER_MARK && isThrottled) {
    isThrottled = false;
    lastLowPressureTimestamp = currentTime;
    consecutiveHighPressureCount = 0; // Reset consecutive counter
    
    console.log(`Worker: Backpressure LOW - video queue: ${queueSize}, audio queue: ${audioQueueSize} (cooldown starts now)`);
    self.postMessage({ 
      type: 'pressure', 
      status: 'low',
      videoQueueSize: queueSize,
      audioQueueSize: audioQueueSize,
      cooldownStartTime: currentTime
    });
  }
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
      
      // 🎯 PERFORMANCE FIX: Intelligent scaling - avoid OffscreenCanvas for minor differences
      // Snap to standard resolutions for better hardware encoder compatibility
      if (scaled.width >= 1600) {
        const targetWidth = 1920;
        const targetHeight = 1080;
        
        // Calculate percentage differences to avoid unnecessary scaling
        const widthDifference = Math.abs(originalWidth - targetWidth) / originalWidth;
        const heightDifference = Math.abs(originalHeight - targetHeight) / originalHeight;
        
        // Only scale if there's a meaningful difference (>2%) or actual downscaling needed
        if (widthDifference > 0.02 || heightDifference > 0.02 || targetWidth < originalWidth || targetHeight < originalHeight) {
          console.log(`Worker: Significant scaling needed - Width diff: ${(widthDifference * 100).toFixed(1)}%, Height diff: ${(heightDifference * 100).toFixed(1)}%`);
          return { width: targetWidth, height: targetHeight, needsScaling: true }; // 1080p with scaling
        } else {
          // 🚀 CRITICAL PERFORMANCE FIX: Use original dimensions to bypass color space conversion
          console.log(`Worker: Minor dimension difference detected - bypassing OffscreenCanvas (${originalWidth}x${originalHeight} vs ${targetWidth}x${targetHeight})`);
          return { width: originalWidth, height: originalHeight, needsScaling: false }; // Native format, no scaling
        }
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
      // 🎯 PERFORMANCE FIX: Intelligent scaling for explicit 1080p target
      const width1080Diff = Math.abs(originalWidth - 1920) / originalWidth;
      const height1080Diff = Math.abs(originalHeight - 1080) / originalHeight;
      if (width1080Diff <= 0.02 && height1080Diff <= 0.02 && originalWidth <= 1920 && originalHeight <= 1080) {
        console.log(`Worker: 1080p target - using original dimensions ${originalWidth}x${originalHeight} (close enough to 1920x1080)`);
        return { width: originalWidth, height: originalHeight, needsScaling: false };
      }
      return { width: 1920, height: 1080, needsScaling: true };
    
    case '720p':
      // 🎯 PERFORMANCE FIX: Intelligent scaling for explicit 720p target  
      const width720Diff = Math.abs(originalWidth - 1280) / originalWidth;
      const height720Diff = Math.abs(originalHeight - 720) / originalHeight;
      if (width720Diff <= 0.02 && height720Diff <= 0.02 && originalWidth <= 1280 && originalHeight <= 720) {
        console.log(`Worker: 720p target - using original dimensions ${originalWidth}x${originalHeight} (close enough to 1280x720)`);
        return { width: originalWidth, height: originalHeight, needsScaling: false };
      }
      return { width: 1280, height: 720, needsScaling: true };
    
    case '540p':
      // 🎯 PERFORMANCE FIX: Intelligent scaling for explicit 540p target
      const width540Diff = Math.abs(originalWidth - 960) / originalWidth;
      const height540Diff = Math.abs(originalHeight - 540) / originalHeight;
      if (width540Diff <= 0.02 && height540Diff <= 0.02 && originalWidth <= 960 && originalHeight <= 540) {
        console.log(`Worker: 540p target - using original dimensions ${originalWidth}x${originalHeight} (close enough to 960x540)`);
        return { width: originalWidth, height: originalHeight, needsScaling: false };
      }
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
    
    // Converting f32 to s16 (logging reduced)
    
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
    
    // Conversion complete (logging reduced)
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
    
    // Upmixing mono to stereo (logging reduced)
    
    // Preserve the original format to prevent bit depth corruption
    // Check if the original format is 16-bit integer (s16 or s16-planar)
    const is16Bit = originalFormat === 's16' || originalFormat === 's16-planar';
    
    if (is16Bit) {
      // Handle 16-bit integer format - preserve bit depth
      const stereoBufferSize = numberOfFrames * 2; // 2 channels, interleaved
      const stereoBuffer = new Int16Array(stereoBufferSize);
      
      // Format-aware copying - check actual input format to prevent corruption
      const inputFormat = monoAudioData.format;
      // Input format detected as 16-bit (logging reduced)
      
      if (inputFormat && inputFormat.startsWith('f32')) {
        // Source is 32-bit float, convert to 16-bit integer
        // Converting float32 input to int16 output (logging reduced)
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
        // Copying int16 input to int16 output (logging reduced)
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
      
      // Upmixed mono to stereo - 16-bit format preserved (logging reduced)
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
      
      // Upmixed mono to stereo - float format preserved (logging reduced)
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

  let scaledFrame: VideoFrame | null = null;
  let bitmap: ImageBitmap | null = null;

  try {
    const startTime = performance.now();
    
    // Use the non-blocking createImageBitmap API for efficient decoding
    bitmap = await createImageBitmap(originalFrame);
    const bitmapTime = performance.now() - startTime;

    // The drawImage call is now much faster as the bitmap is already prepared
    const drawStart = performance.now();
    canvasContext.drawImage(bitmap, 0, 0, scaledWidth, scaledHeight);
    const drawTime = performance.now() - drawStart;

    // Create a new, low-resolution VideoFrame from the canvas
    const frameCreateStart = performance.now();
    scaledFrame = new VideoFrame(offscreenCanvas, {
      timestamp: originalFrame.timestamp,
      duration: originalFrame.duration || undefined
    });
    const frameCreateTime = performance.now() - frameCreateStart;

    // 🎯 COORDINATED BACKPRESSURE: Intelligent frame dropping with immediate main thread notification
    const currentQueueSize = videoEncoder.encodeQueueSize;
    
    // Note: Queue status is now logged in periodic health checks
    
    if (currentQueueSize > HIGH_WATER_MARK) {
      console.warn(`Worker: Frame dropped due to encoder backpressure (queue: ${currentQueueSize}, threshold: ${HIGH_WATER_MARK})`);
      needsKeyFrame = true;
      videoFramesDropped++;
      
      // 🚀 IMMEDIATE BACKPRESSURE NOTIFICATION: Tell main thread immediately
      if (!isThrottled) {
        isThrottled = true;
        consecutiveHighPressureCount++;
        console.warn(`Worker: Sending IMMEDIATE backpressure HIGH signal (queue: ${currentQueueSize})`);
        self.postMessage({ 
          type: 'pressure', 
          status: 'high',
          videoQueueSize: currentQueueSize,
          audioQueueSize: audioEncoder?.encodeQueueSize || 0,
          encoderQueueSize: currentQueueSize, // Direct encoder queue for main thread
          immediate: true, // Flag for immediate response
          consecutiveCount: consecutiveHighPressureCount
        });
      }
      
      // Clean up frames before returning early
      if (scaledFrame) {
        scaledFrame.close();
      }
      originalFrame.close();
      return; // Return early, skipping the encode
    }
    
    // 🎯 CHECK FOR RECOVERY: Send low pressure signal if queue has drained
    if (currentQueueSize <= LOW_WATER_MARK && isThrottled) {
      isThrottled = false;
      consecutiveHighPressureCount = 0;
      lastLowPressureTimestamp = performance.now();
      console.log(`Worker: Sending IMMEDIATE backpressure LOW signal (queue: ${currentQueueSize})`);
      self.postMessage({ 
        type: 'pressure', 
        status: 'low',
        videoQueueSize: currentQueueSize,
        audioQueueSize: audioEncoder?.encodeQueueSize || 0,
        encoderQueueSize: currentQueueSize,
        immediate: true
      });
    }

    // Encode the scaled frame
    const encodeStart = performance.now();
    
    // ⏱️ TIMESTAMP LOGGING: Log scaled frame timestamp for sync verification
    if (videoFramesProcessed % 30 === 0) {
      console.log(`⏱️ Video Frame #${videoFramesProcessed} (downscaling) timestamp: ${scaledFrame.timestamp}µs (${(scaledFrame.timestamp / 1000).toFixed(1)}ms)`);
    }
    
    if (needsKeyFrame) {
      videoEncoder.encode(scaledFrame, { keyFrame: true });
      needsKeyFrame = false; // Reset the flag.
      console.log('Worker: Forced a keyframe to recover from dropped frames (downscaling path).');
    } else {
      videoEncoder.encode(scaledFrame);
    }
    const encodeTime = performance.now() - encodeStart;
    
    // Clean up the scaled frame after encoding
    scaledFrame.close();
    originalFrame.close();
    
    // Note: Frame processing status now logged in periodic health checks

    // 📊 PERIODIC DOWNSCALING PERFORMANCE: Log every 150 frames to avoid spam
    if (videoFramesProcessed % 150 === 0) {
      const totalTime = bitmapTime + drawTime + frameCreateTime + encodeTime;
      console.log(`📊 Downscaling performance sample - Bitmap: ${bitmapTime.toFixed(1)}ms, Draw: ${drawTime.toFixed(1)}ms, Create: ${frameCreateTime.toFixed(1)}ms, Encode: ${encodeTime.toFixed(1)}ms, Total: ${totalTime.toFixed(1)}ms`);
      
      if (totalTime > 16) { // More than 1 frame at 60fps
        console.warn(`📊 SLOW DOWNSCALING DETECTED - Total: ${totalTime.toFixed(1)}ms (threshold: 16ms)`);
      }
    }

    // Drift detection: increment video frame counter and track time
    if (ENABLE_DRIFT_DETECTION) {
      videoFramesProcessed++;
      // Add frame duration to total video time (in milliseconds)
      const frameDurationMs = (originalFrame.duration || 33333) / 1000; // Convert microseconds to milliseconds
      totalVideoTimeProcessed += frameDurationMs;
      
      if (videoFramesProcessed % SYNC_UPDATE_FRAME_INTERVAL === 0) {
        sendSyncUpdate();
      }
    }

  } catch (error) {
    console.error('Worker: Error in processFrameWithDownscaling:', error);
    // Clean up resources on error
    if (bitmap) {
      bitmap.close(); // Close the bitmap to release its memory
    }
    if (scaledFrame) {
      scaledFrame.close();
    }
    originalFrame.close();
    throw error;
  } finally {
    // Always clean up the bitmap, but frames are cleaned up in the main path or error handler
    if (bitmap) {
      bitmap.close(); // Close the bitmap to release its memory
    }
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
    let timeoutId: number | null = null;
    let isResolved = false;
    
    // Create timeout that rejects after specified time
    timeoutId = self.setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        console.log(`Worker: ⏱️ TIMEOUT TRIGGERED for codec ${config.codec} after ${timeout}ms`);
        reject(new Error(`Codec support check timeout after ${timeout}ms`));
      }
    }, timeout);

    // Start the actual codec support check
    VideoEncoder.isConfigSupported(config)
      .then((result) => {
        if (!isResolved) {
          isResolved = true;
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          console.log(`Worker: ✅ Codec support check completed for ${config.codec}:`, result);
          resolve(result);
        }
      })
      .catch((error) => {
        if (!isResolved) {
          isResolved = true;
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          console.log(`Worker: ❌ Codec support check failed for ${config.codec}:`, error.message);
          reject(error);
        }
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
    let timeoutId: number | null = null;
    let isResolved = false;
    
    // Create timeout that rejects after specified time
    timeoutId = self.setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        reject(new Error(`Codec support check timeout after ${timeout}ms`));
      }
    }, timeout);

    // Start the actual codec support check
    AudioEncoder.isConfigSupported(config)
      .then((result) => {
        if (!isResolved) {
          isResolved = true;
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          resolve(result);
        }
      })
      .catch((error) => {
        if (!isResolved) {
          isResolved = true;
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          reject(error);
        }
      });
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
          // 🚨 MUXER RACE CONDITION DETECTION
          if (!muxer) {
            console.error('Worker: 🚨 CRITICAL RACE CONDITION: AudioEncoder output called but muxer is null!');
            self.postMessage({ type: 'error', error: 'Muxer race condition: audio chunk received before muxer initialization' });
            return;
          }
          
          // Log first few chunks for debugging
          if (audioFramesProcessed < 3) {
            console.log(`Worker: 🎵 AudioEncoder Output Chunk ${audioFramesProcessed + 1}:`, {
              type: chunk.type,
              timestamp: chunk.timestamp,
              duration: chunk.duration,
              byteLength: chunk.byteLength,
              muxerReady: !!muxer,
              metadata: metadata
            });
          }
          
          // 📦 MUXER CHUNK VERIFICATION: Log first 5 audio chunks for initial diagnostics
          if (audioFramesProcessed < 5) {
            console.log(`📦 Muxer Audio Chunk ${audioFramesProcessed + 1} - Type: ${chunk.type}, Timestamp: ${chunk.timestamp}µs, Size: ${chunk.byteLength} bytes`);
          }
          
          // Pass encoded audio chunk to muxer
            muxer.addAudioChunk(chunk, metadata || {});
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
    console.log(`📊 Configuring AudioEncoder - Pre-config state: ${audioEncoder.state}`);
    audioEncoder.configure(currentAudioConfig);
    console.log(`📊 AudioEncoder configured successfully - Post-config state: ${audioEncoder.state}, queue size: ${audioEncoder.encodeQueueSize}`);
    
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

    // 🎯 CRITICAL DEBUGGING: Log actual vs requested track settings
    if (data.actualVideoSettings) {
      console.log('Worker: 🔍 RECEIVED Actual Video Settings:', data.actualVideoSettings);
    }
    if (data.actualAudioSettings) {
      console.log('Worker: 🔍 RECEIVED Actual Audio Settings:', data.actualAudioSettings);
    }
    
    console.log('Worker: 📋 RECEIVED Final Config (post-correction):', {
      video: {
        width: data.config.width,
        height: data.config.height,
        frameRate: data.config.frameRate
      },
      audio: data.config.audio
    });
    
    // Reset drift detection counters for new recording session
    if (ENABLE_DRIFT_DETECTION) {
      videoFramesProcessed = 0;
      audioFramesProcessed = 0;
      videoFramesDropped = 0;
      totalVideoTimeProcessed = 0;
      totalAudioTimeProcessed = 0;
    }
    
    // 🚀 NEW ARCHITECTURE: Reset timestamp tracking for worker-side normalization
    firstVideoTimestamp = null;
    firstAudioTimestamp = null;

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
      // 🎯 PERFORMANCE FIX: Optimize canvas context for maximum performance
      canvasContext = offscreenCanvas.getContext('2d', { 
        alpha: false,           // Disable alpha channel for performance boost
        desynchronized: true,   // Allow async rendering for better performance
        willReadFrequently: false // We only write to canvas, don't read back
      });
      if (!canvasContext) {
        throw new Error('Failed to create optimized 2D context for downscaling canvas');
      }
      
      // Additional performance optimizations
      canvasContext.imageSmoothingEnabled = false; // Disable smoothing for speed
      canvasContext.imageSmoothingQuality = 'low';
      
      console.log('Worker: 🎨 OffscreenCanvas scaling path enabled - will convert to RGBA format', { 
        scaledWidth, 
        scaledHeight,
        alpha: false,
        desynchronized: true,
        smoothing: false
      });
    } else {
      // 🚀 CRITICAL PERFORMANCE: Direct encoding path - no color space conversion
      console.log('Worker: 🚀 Direct encoding path enabled - frames will bypass color space conversion for maximum performance', {
        originalWidth: scaledWidth,  // scaledWidth contains original width when needsScaling=false
        originalHeight: scaledHeight // scaledHeight contains original height when needsScaling=false
      });
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
          
          // AV1 debug logging reduced for cleaner output
          
          for (const codec of strategy.codecs) {
            try {
              const testConfig = { ...baseEncoderConfig, codec };
              // Testing codec support (detailed logging reduced)
              const configSupport = await checkVideoSupportWithTimeout(testConfig, 2000);
              
              if (configSupport.supported) {
                encoderConfig = testConfig;
                finalCodec = strategy.name as 'av1' | 'hevc' | 'h264' | 'vp9';
                
                // Log hardware acceleration status
                if (configSupport.config) {
                  const accelStatus = configSupport.config.hardwareAcceleration || 'unknown';
                  // Codec configuration successful (detailed logging reduced)
                }
                
                // Success - break out of both loops
                break;
              } else {
                // Codec not supported (logging reduced)
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
    
    // 🎯 PERFORMANCE LOGGING: Show whether we bypassed color space conversion
    if (needsScaling) {
      console.log(`Worker: ⚠️ Using OffscreenCanvas scaling path (${encoderConfig.width}x${encoderConfig.height}) - RGBA color conversion will occur`);
    } else {
      console.log(`Worker: 🚀 Using direct encoding path (${encoderConfig.width}x${encoderConfig.height}) - native format bypasses color conversion for maximum performance`);
    }

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
        console.log('Worker: 🎵 VP9 MUXER Audio Track Configuration:', muxerConfig.audio);
      }
      
      console.log('Worker: 🎬 COMPLETE VP9 WebM Muxer Configuration BEFORE Creation:', muxerConfig);
      muxer = await createWebMMuxer(muxerConfig);
      console.log('Worker: ✅ VP9 WebM Muxer Created Successfully');
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
          // 🚨 MUXER RACE CONDITION DETECTION
          if (!muxer) {
            console.error('Worker: 🚨 CRITICAL RACE CONDITION: VideoEncoder output called but muxer is null!');
            self.postMessage({ type: 'error', error: 'Muxer race condition: video chunk received before muxer initialization' });
            return;
          }
          
          // Log first few chunks for debugging
          if (videoFramesProcessed < 3) {
            console.log(`Worker: 🎬 VideoEncoder Output Chunk ${videoFramesProcessed + 1}:`, {
              type: chunk.type,
              timestamp: chunk.timestamp,
              duration: chunk.duration,
              byteLength: chunk.byteLength,
              muxerReady: !!muxer,
              metadata: metadata
            });
          }
          
          // 📦 MUXER CHUNK VERIFICATION: Log first 5 video chunks for initial diagnostics
          if (videoFramesProcessed < 5) {
            console.log(`📦 Muxer Video Chunk ${videoFramesProcessed + 1} - Type: ${chunk.type}, Timestamp: ${chunk.timestamp}µs, Size: ${chunk.byteLength} bytes, Duration: ${chunk.duration}µs`);
          }
          
          // Pass both chunk and metadata to the muxer - let encoder tell muxer the format
            muxer.addVideoChunk(chunk, metadata || {});
          
          // Check queue status after processing each chunk for responsive backpressure
          checkQueueAndNotify();
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
    console.log(`📊 Configuring VideoEncoder - Pre-config state: ${videoEncoder.state}`);
    videoEncoder.configure(encoderConfig);
    console.log(`📊 VideoEncoder configured successfully - Post-config state: ${videoEncoder.state}, queue size: ${videoEncoder.encodeQueueSize}`);
    
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

    // 🎯 STARTUP SYNC FIX: Signal that worker is fully initialized and ready to receive data streams
    // This prevents the main thread from flooding the pipeline before we're ready to process
    self.postMessage({ type: 'worker-ready-for-data' });
    console.log('Worker: 🚀 Worker setup complete - ready to receive data streams');

    // Step 6: Start Processing (REVERTED to stream-based)
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
 * 🚀 NEW ARCHITECTURE: Process video frames directly from MediaStreamTrack in worker
 * This eliminates main thread bottlenecks and achieves full 30fps performance
 * 
 * @param videoTrack - MediaStreamTrack transferred from main thread
 */
async function startVideoTrackProcessing(videoTrack: MediaStreamTrack): Promise<void> {
  try {
    console.log('Worker: 🚀 Creating MediaStreamTrackProcessor in dedicated worker thread');
    
    // Create processor directly in worker for maximum performance
    const processor = new MediaStreamTrackProcessor({ track: videoTrack } as any);
    streamReader = processor.readable.getReader();
    
    console.log('Worker: 🚀 Starting high-speed video processing loop (dedicated thread)');
    
    // Capture recording start time for duration calculation
    if (recordingStartTime === null) {
      recordingStartTime = performance.now();
    }
    
    let frameCount = 0;
    const startTime = performance.now();
    
    // 🚀 DEDICATED THREAD: High-speed processing loop
    while (true) {
      const { done, value: frame } = await streamReader.read();
      
      if (done) {
        console.log('Worker: 🚀 Video track ended, stopping dedicated processing');
        break;
      }
      
      if (!frame) {
        console.warn('Worker: Received null frame, skipping');
        continue;
      }
      
      frameCount++;
      
      // Log performance every 100 frames
      if (frameCount % 100 === 0) {
        const elapsed = performance.now() - startTime;
        const fps = frameCount / (elapsed / 1000);
        console.log(`Worker: 🚀 DEDICATED THREAD PERFORMANCE: ${frameCount} frames processed at ${fps.toFixed(1)} fps`);
      }
      
      // Apply timestamp normalization in worker
      if (firstVideoTimestamp === null) {
        firstVideoTimestamp = frame.timestamp;
      }
      const normalizedTimestamp = frame.timestamp - firstVideoTimestamp;
      
      // Create normalized frame for encoding
      const normalizedFrame = new VideoFrame(frame, {
        timestamp: normalizedTimestamp,
        duration: frame.duration ?? undefined
      });
      
      // Close original frame immediately after copying
      frame.close();
      
      // 🚀 DEDICATED THREAD: Process frame directly in worker
      if (needsScaling) {
        await processFrameWithDownscaling(normalizedFrame);
      } else {
        // 🚀 DIRECT ENCODING PATH: No color space conversion - maximum performance
        if (videoEncoder) {
          const encodeStart = performance.now();
          
          // ⏱️ TIMESTAMP VERIFICATION: Periodic timestamp logging
          if (videoFramesProcessed % 150 === 0) {
            console.log(`⏱️ Video Frame #${videoFramesProcessed} (dedicated) timestamp: ${normalizedFrame.timestamp}µs (${(normalizedFrame.timestamp / 1000).toFixed(1)}ms)`);
          }
          
          if (needsKeyFrame) {
            videoEncoder.encode(normalizedFrame, { keyFrame: true });
            needsKeyFrame = false;
            console.log('Worker: 🚀 Forced keyframe in direct encoding path (dedicated thread, no downscaling)');
          } else {
            videoEncoder.encode(normalizedFrame);
          }
          
          const encodeTime = performance.now() - encodeStart;
          
          normalizedFrame.close();
          
          // 📊 PERIODIC PERFORMANCE LOG: Log direct encoding performance every 150 frames
          if (videoFramesProcessed % 150 === 0) {
            console.log(`📊 Direct encoding performance sample (dedicated) - Encode: ${encodeTime.toFixed(1)}ms (bypassed color conversion)`);
          }
          
          // Update drift detection
          if (ENABLE_DRIFT_DETECTION) {
            videoFramesProcessed++;
            const frameDurationMs = (normalizedFrame.duration || 33333) / 1000;
            totalVideoTimeProcessed += frameDurationMs;
            
            if (videoFramesProcessed % SYNC_UPDATE_FRAME_INTERVAL === 0) {
              sendSyncUpdate();
            }
          }
        }
      }
    }
    
  } catch (error) {
    console.error('Worker: Error in dedicated video track processing:', error);
    self.postMessage({ 
      type: 'error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
}

/**
 * 🚀 NEW ARCHITECTURE: Process audio frames directly from MediaStreamTrack in worker
 * 
 * @param audioTrack - MediaStreamTrack transferred from main thread
 */
async function startAudioTrackProcessing(audioTrack: MediaStreamTrack): Promise<void> {
  try {
    console.log('Worker: 🚀 Creating Audio MediaStreamTrackProcessor in dedicated worker thread');
    
    // Create processor directly in worker for maximum performance
    const processor = new MediaStreamTrackProcessor({ track: audioTrack } as any);
    audioStreamReader = processor.readable.getReader();
    
    console.log('Worker: 🚀 Starting high-speed audio processing loop (dedicated thread)');
    
    let frameCount = 0;
    const startTime = performance.now();
    
    // 🚀 DEDICATED THREAD: High-speed audio processing loop
    while (true) {
      const { done, value: audioFrame } = await audioStreamReader.read();
      
      if (done) {
        console.log('Worker: 🚀 Audio track ended, stopping dedicated processing');
        break;
      }
      
      if (!audioFrame) {
        console.warn('Worker: Received null audio frame, skipping');
        continue;
      }
      
      frameCount++;
      
      // Apply timestamp normalization in worker
      if (firstAudioTimestamp === null) {
        firstAudioTimestamp = audioFrame.timestamp;
      }
      const normalizedTimestamp = audioFrame.timestamp - firstAudioTimestamp;
      
      // Create normalized audio frame
      const normalizedAudioFrame = new AudioData({
        format: audioFrame.format || 'f32-planar',
        sampleRate: audioFrame.sampleRate,
        numberOfFrames: audioFrame.numberOfFrames,
        numberOfChannels: audioFrame.numberOfChannels,
        timestamp: normalizedTimestamp,
        data: await copyAudioData(audioFrame)
      });
      
      // Close original frame immediately after copying
      audioFrame.close();
      
      // Process audio frame through existing pipeline
      if (audioEncoder) {
        let frameToEncode = normalizedAudioFrame;
        
        // Handle channel mismatch with upmixing
        if (needsUpmixing && normalizedAudioFrame.numberOfChannels === 1 && finalEncoderChannels === 2) {
          frameToEncode = upmixMonoToStereo(normalizedAudioFrame);
          normalizedAudioFrame.close();
        }
        
        // Handle format conversion if needed
        if (frameToEncode.format?.startsWith('f32') && 
            currentAudioConfig?.codec?.includes('aac')) {
          const convertedFrame = convertF32toS16(frameToEncode);
          if (frameToEncode !== normalizedAudioFrame) {
            frameToEncode.close();
          }
          frameToEncode = convertedFrame;
        }
        
        audioEncoder.encode(frameToEncode);
        frameToEncode.close();
        
        // Update drift detection
        if (ENABLE_DRIFT_DETECTION) {
          audioFramesProcessed++;
          const sampleRate = currentAudioConfig?.sampleRate || 44100;
          const frameDurationMs = (audioFrame.numberOfFrames / sampleRate) * 1000;
          totalAudioTimeProcessed += frameDurationMs;
        }
      }
    }
    
  } catch (error) {
    console.error('Worker: Error in dedicated audio track processing:', error);
    self.postMessage({ 
      type: 'error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
}

/**
 * Helper function to copy AudioData buffer
 */
async function copyAudioData(audioFrame: AudioData): Promise<ArrayBuffer> {
  let totalByteLength = 0;
  for (let i = 0; i < audioFrame.numberOfChannels; i++) {
    totalByteLength += audioFrame.allocationSize({ planeIndex: i });
  }
  const buffer = new ArrayBuffer(totalByteLength);
  const bufferView = new Uint8Array(buffer);

  let offset = 0;
  for (let i = 0; i < audioFrame.numberOfChannels; i++) {
    const planeSize = audioFrame.allocationSize({ planeIndex: i });
    const planeBuffer = new ArrayBuffer(planeSize);
    audioFrame.copyTo(planeBuffer, { planeIndex: i });
    bufferView.set(new Uint8Array(planeBuffer), offset);
    offset += planeSize;
  }
  
  return buffer;
}

/**
 * @deprecated Legacy stream-based processing - replaced by startVideoTrackProcessing
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
      
      // Safety check - ensure we have a valid frame
      if (!frame) {
        console.warn('Worker: Received null/undefined frame, skipping');
        continue;
      }
      
      // Note: Comprehensive encoder health is now logged in periodic sync updates
      
      const frameProcessedCount = videoFramesProcessed + 1;
      
      // 🎯 COORDINATED BACKPRESSURE: Unified frame drop logic with immediate main thread notification
      const currentQueueSize = videoEncoder?.encodeQueueSize || 0;
      
      if (currentQueueSize > HIGH_WATER_MARK) {
        // The queue is too long, so we need to drop this frame.
        videoFramesDropped++;
        console.warn(`Worker: 🚨 DROPPING FRAME due to encoder backpressure (queue: ${currentQueueSize}, threshold: ${HIGH_WATER_MARK}). Dropped: ${videoFramesDropped}`);
        
        // 🚀 IMMEDIATE BACKPRESSURE NOTIFICATION: Tell main thread immediately
        if (!isThrottled) {
          isThrottled = true;
          consecutiveHighPressureCount++;
          console.warn(`Worker: Sending IMMEDIATE backpressure HIGH signal from video loop (queue: ${currentQueueSize})`);
          self.postMessage({ 
            type: 'pressure', 
            status: 'high',
            videoQueueSize: currentQueueSize,
            audioQueueSize: audioEncoder?.encodeQueueSize || 0,
            encoderQueueSize: currentQueueSize,
            immediate: true,
            consecutiveCount: consecutiveHighPressureCount
          });
        }
        
        // 🎯 CRITICAL FIX: Close frame and continue immediately - do NOT process further
        frame.close();
        // Note: Frame drops are tracked in health check summaries
        needsKeyFrame = true; // Flag that we need a keyframe to recover.
        continue; // Skip to the next frame - frame is now closed and should not be processed
      }
      
      // 🎯 CHECK FOR RECOVERY: Send low pressure signal if queue has drained
      if (currentQueueSize <= LOW_WATER_MARK && isThrottled) {
        isThrottled = false;
        consecutiveHighPressureCount = 0;
        lastLowPressureTimestamp = performance.now();
        console.log(`Worker: Sending IMMEDIATE backpressure LOW signal from video loop (queue: ${currentQueueSize})`);
        self.postMessage({ 
          type: 'pressure', 
          status: 'low',
          videoQueueSize: currentQueueSize,
          audioQueueSize: audioEncoder?.encodeQueueSize || 0,
          encoderQueueSize: currentQueueSize,
          immediate: true
        });
      }

      // Encode the frame (with conditional downscaling)
      if (videoEncoder && frame) {
        let frameClosed = false;
        try {
          if (needsScaling) {
            // Downscaling path: process frame through OffscreenCanvas
            await processFrameWithDownscaling(frame);
            frameClosed = true; // processFrameWithDownscaling closes the original frame
          } else {
            // 🚀 DIRECT ENCODING PATH: No color space conversion - maximum performance
            const encodeStart = performance.now();
            
            // ⏱️ TIMESTAMP VERIFICATION: Periodic timestamp logging for sync verification  
            if (frameProcessedCount % 150 === 0) {
              console.log(`⏱️ Video Frame #${frameProcessedCount} timestamp: ${frame.timestamp}µs (${(frame.timestamp / 1000).toFixed(1)}ms)`);
            }
            
            // If we just dropped frames, the next one we send MUST be a keyframe.
            if (needsKeyFrame) {
              videoEncoder.encode(frame, { keyFrame: true });
              needsKeyFrame = false; // Reset the flag.
              console.log('Worker: 🚀 Forced keyframe in direct encoding path (no downscaling)');
            } else {
              videoEncoder.encode(frame);
            }
            
            const encodeTime = performance.now() - encodeStart;
            
            // Clean up the frame after encoding
            frame.close();
            frameClosed = true;
            
            // 📊 PERIODIC PERFORMANCE LOG: Log direct encoding performance every 150 frames
            if (frameProcessedCount % 150 === 0) {
              console.log(`📊 Direct encoding performance sample - Encode: ${encodeTime.toFixed(1)}ms (native format, no color conversion)`);
            }
            
            // Drift detection: increment video frame counter and track time
            if (ENABLE_DRIFT_DETECTION) {
              videoFramesProcessed++;
              // Add frame duration to total video time (in milliseconds)
              const frameDurationMs = (frame.duration || 33333) / 1000; // Convert microseconds to milliseconds
              totalVideoTimeProcessed += frameDurationMs;
              
              if (videoFramesProcessed % SYNC_UPDATE_FRAME_INTERVAL === 0) {
                sendSyncUpdate();
              }
            }
          }
        } catch (encodingError) {
          console.error('Worker: Error during video frame processing:', encodingError);
          // Clean up frame if not already closed
          if (!frameClosed) {
            frame.close();
          }
          // Re-throw to be caught by outer try-catch
          throw encodingError;
        }
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
      
      // 📊 AUDIO ENCODER BACKPRESSURE: Monitor for critical queue overload
      if (audioEncoder && audioEncoder.encodeQueueSize > 30) {
        console.warn(`⚠️ Audio encoder queue overloaded (${audioEncoder.encodeQueueSize}), waiting for drain...`);
        // Wait until the queue size drops to a reasonable level
        while (audioEncoder && audioEncoder.encodeQueueSize > 15) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        console.log(`✅ Audio encoder queue recovered (${audioEncoder?.encodeQueueSize})`);
      }
      
      // Encode the audio frame
      if (audioEncoder && audioFrame) {
        let frameToEncode = audioFrame;
        let needsCleanup = false;
        
        try {
          // Per-frame logging removed to reduce console noise
          
          // Handle channel mismatch with upmixing
          if (needsUpmixing && audioFrame.numberOfChannels === 1 && finalEncoderChannels === 2) {
            // Upmixing mono frame to stereo (logging reduced)
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
          
                  // ⏱️ AUDIO TIMESTAMP VERIFICATION: Periodic timestamp logging  
        if (audioFramesProcessed % 500 === 0) { // Log less frequently for audio (more frames)
          console.log(`⏱️ Audio Frame #${audioFramesProcessed} timestamp: ${finalFrameToEncode.timestamp}µs (${(finalFrameToEncode.timestamp / 1000).toFixed(1)}ms)`);
        }
        
        // Encode the frame (original, upmixed, or format-converted)
        audioEncoder.encode(finalFrameToEncode);
        
        // Drift detection: increment audio frame counter and track time
          if (ENABLE_DRIFT_DETECTION) {
            audioFramesProcessed++;
            // Calculate audio frame duration in milliseconds
            const sampleRate = currentAudioConfig?.sampleRate || 44100;
            const frameDurationMs = (audioFrame.numberOfFrames / sampleRate) * 1000;
            totalAudioTimeProcessed += frameDurationMs;
          }
          
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
    
    // Reset drift detection counters when stopping
    if (ENABLE_DRIFT_DETECTION) {
      videoFramesProcessed = 0;
      audioFramesProcessed = 0;
      totalVideoTimeProcessed = 0;
      totalAudioTimeProcessed = 0;
    }

    // Step 1: Wait for Stream Readers to finish naturally - they should terminate
    // when the main thread processing loops see the stop signal
    console.log('Worker: Waiting for streams to close naturally...');
    
    // Drain any remaining frames from video stream to prevent leaks
    if (streamReader) {
      console.log('Worker: Attempting to drain remaining video frames...');
      try {
        let frameCount = 0;
        let drainAttempts = 0;
        const maxDrainAttempts = 10; // Prevent infinite loop
        
        while (drainAttempts < maxDrainAttempts) {
          try {
            const result = await Promise.race([
              streamReader.read(),
              new Promise<ReadableStreamReadResult<VideoFrame>>((_, reject) => 
                setTimeout(() => reject(new Error('drain timeout')), 100)
              )
            ]);
            
            const { done, value: frame } = result;
            
            if (done) {
              console.log('Worker: Video stream drain completed - no more frames');
              break;
            }
            if (frame) {
              frame.close(); // Close any remaining frames
              frameCount++;
              console.log(`Worker: Drained and closed frame ${frameCount}`);
            }
          } catch (readError) {
            if (readError instanceof Error && readError.message === 'drain timeout') {
              console.log('Worker: Stream read timeout during drain, assuming empty');
              break;
            }
            throw readError;
          }
          drainAttempts++;
        }
        
        if (frameCount > 0) {
          console.log(`Worker: Drained and closed ${frameCount} remaining video frames`);
        } else {
          console.log('Worker: No remaining video frames to drain');
        }
      } catch (drainError) {
        console.warn('Worker: Error draining remaining video frames:', drainError);
      }
    } else {
      console.log('Worker: No video stream reader to drain');
    }
    
    // Drain any remaining frames from audio stream to prevent leaks
    if (audioStreamReader) {
      try {
        let frameCount = 0;
        let drainAttempts = 0;
        const maxDrainAttempts = 10;
        
        while (drainAttempts < maxDrainAttempts) {
          try {
            const result = await Promise.race([
              audioStreamReader.read(),
              new Promise<ReadableStreamReadResult<AudioData>>((_, reject) => 
                setTimeout(() => reject(new Error('drain timeout')), 100)
              )
            ]);
            
            const { done, value: frame } = result;
            
            if (done) break;
            if (frame) {
              frame.close(); // Close any remaining audio frames
              frameCount++;
            }
          } catch (readError) {
            if (readError instanceof Error && readError.message === 'drain timeout') {
              console.log('Worker: Audio stream read timeout during drain, assuming empty');
              break;
            }
            throw readError;
          }
          drainAttempts++;
        }
        
        if (frameCount > 0) {
          console.log(`Worker: Drained and closed ${frameCount} remaining audio frames`);
        }
      } catch (drainError) {
        console.warn('Worker: Error draining remaining audio frames:', drainError);
      }
    }
    
    // Give a moment for the main thread processing loops to terminate gracefully
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Clean up stream reader references (they should already be closed)
    if (streamReader) {
      streamReader = null;
      console.log('Worker: Video stream reader reference cleared');
    }

    if (audioStreamReader) {
      audioStreamReader = null;
      console.log('Worker: Audio stream reader reference cleared');
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

    // Step 6: Final cleanup - Force garbage collection to catch any remaining frames
    // This is a last resort to ensure no frames are left unclosed
    try {
      // @ts-ignore - gc() is available in Node.js with --expose-gc flag
      if (typeof gc !== 'undefined') {
        // @ts-ignore
        gc(); // Force garbage collection if available (dev environments)
      }
    } catch (gcError) {
      // gc() not available in production, ignore
    }
    
    // Step 7: Close Worker - Terminate this worker thread
    self.close();

  } catch (error) {
    console.error('Worker: Error in handleStopMessage:', error);
    self.postMessage({ 
      type: 'error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
}

