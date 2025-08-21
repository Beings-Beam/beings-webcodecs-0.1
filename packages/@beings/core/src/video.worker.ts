/// <reference lib="webworker" />

/**
 * Video Worker - Dedicated Video Processing and Encoding
 * 
 * This worker handles ONLY video processing in a dedicated thread,
 * eliminating interference from high-frequency audio processing.
 * Part of the dual-worker architecture for maximum performance.
 */

import type { VideoWorkerRequest, VideoWorkerResponse } from './types';

// Video processing state
let videoEncoder: VideoEncoder | null = null;
let streamReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let currentConfig: any = null;
let finalCodec: 'av1' | 'hevc' | 'h264' | 'vp9' | null = null;
let needsKeyFrame = false;

// Downscaling state
let needsScaling = false;
let scaledWidth = 0;
let scaledHeight = 0;
let offscreenCanvas: OffscreenCanvas | null = null;
let canvasContext: OffscreenCanvasRenderingContext2D | null = null;

// Performance tracking
let videoFramesProcessed = 0;
let videoFramesDropped = 0;
let firstVideoTimestamp: number | null = null;

// Graceful shutdown control
let shouldStop = false;

// Backpressure management 
const HIGH_WATER_MARK = 8;
const LOW_WATER_MARK = 3;
let isThrottled = false;
let lastLowPressureTimestamp = 0;
let consecutiveHighPressureCount = 0;
const HYSTERESIS_COOLDOWN_MS = 500;

/**
 * Calculate scaled dimensions that fit within hardware limits while preserving aspect ratio
 */
function calculateScaledDimensions(
  originalWidth: number, 
  originalHeight: number, 
  maxWidth = 1920, 
  maxHeight = 1080
) {
  if (originalWidth <= maxWidth && originalHeight <= maxHeight) {
    return { width: originalWidth, height: originalHeight, needsScaling: false };
  }
  
  const widthRatio = maxWidth / originalWidth;
  const heightRatio = maxHeight / originalHeight;
  const scalingFactor = Math.min(widthRatio, heightRatio);
  
  const scaledWidth = Math.floor(originalWidth * scalingFactor / 2) * 2;
  const scaledHeight = Math.floor(originalHeight * scalingFactor / 2) * 2;
  
  let finalWidth = Math.floor(scaledWidth / 16) * 16;
  let finalHeight = Math.floor(scaledHeight / 16) * 16;
  
  if (finalWidth < 640) finalWidth = 640;
  if (finalHeight < 360) finalHeight = 360;
  if (finalWidth > 1920) finalWidth = 1920;
  if (finalHeight > 1080) finalHeight = 1080;
  
  return { width: finalWidth, height: finalHeight, needsScaling: true };
}

/**
 * Determine target resolution based on user selection
 */
function determineTargetResolution(
  originalWidth: number,
  originalHeight: number,
  resolutionTarget: string
) {
  switch (resolutionTarget) {
    case 'auto':
      const scaled = calculateScaledDimensions(originalWidth, originalHeight, 1920, 1080);
      
      if (scaled.width >= 1600) {
        const targetWidth = 1920;
        const targetHeight = 1080;
        
        const widthDifference = Math.abs(originalWidth - targetWidth) / originalWidth;
        const heightDifference = Math.abs(originalHeight - targetHeight) / originalHeight;
        
        if (widthDifference > 0.02 || heightDifference > 0.02 || targetWidth < originalWidth || targetHeight < originalHeight) {
          return { width: targetWidth, height: targetHeight, needsScaling: true };
        } else {
          return { width: originalWidth, height: originalHeight, needsScaling: false };
        }
      } else if (scaled.width >= 1200) {
        return { width: 1280, height: 720, needsScaling: true };
      } else if (scaled.width >= 800) {
        return { width: 960, height: 540, needsScaling: true };
      } else {
        return { width: 640, height: 360, needsScaling: true };
      }
    
    case '4k':
      return { width: 3840, height: 2160, needsScaling: true };
    
    case '1080p':
      const width1080Diff = Math.abs(originalWidth - 1920) / originalWidth;
      const height1080Diff = Math.abs(originalHeight - 1080) / originalHeight;
      if (width1080Diff <= 0.02 && height1080Diff <= 0.02 && originalWidth <= 1920 && originalHeight <= 1080) {
        return { width: originalWidth, height: originalHeight, needsScaling: false };
      }
      return { width: 1920, height: 1080, needsScaling: true };
    
    case '720p':
      const width720Diff = Math.abs(originalWidth - 1280) / originalWidth;
      const height720Diff = Math.abs(originalHeight - 720) / originalHeight;
      if (width720Diff <= 0.02 && height720Diff <= 0.02 && originalWidth <= 1280 && originalHeight <= 720) {
        return { width: originalWidth, height: originalHeight, needsScaling: false };
      }
      return { width: 1280, height: 720, needsScaling: true };
    
    case '540p':
      const width540Diff = Math.abs(originalWidth - 960) / originalWidth;
      const height540Diff = Math.abs(originalHeight - 540) / originalHeight;
      if (width540Diff <= 0.02 && height540Diff <= 0.02 && originalWidth <= 960 && originalHeight <= 540) {
        return { width: originalWidth, height: originalHeight, needsScaling: false };
      }
      return { width: 960, height: 540, needsScaling: true };
    
    default:
      console.warn('VideoWorker: Unknown resolution target, falling back to 720p:', resolutionTarget);
      return { width: 1280, height: 720, needsScaling: true };
  }
}

/**
 * Check video codec support with timeout
 */
async function checkVideoSupportWithTimeout(
  config: VideoEncoderConfig, 
  timeout = 2000
): Promise<VideoEncoderSupport> {
  console.log(`VideoWorker: 🔍 Starting codec support check with ${timeout}ms timeout for:`, config.codec);
  return new Promise((resolve, reject) => {
    let timeoutId: number | null = null;
    let isResolved = false;
    
    timeoutId = self.setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        console.log(`VideoWorker: ⏱️ TIMEOUT TRIGGERED for codec ${config.codec} after ${timeout}ms`);
        reject(new Error(`Codec support check timeout after ${timeout}ms`));
      }
    }, timeout);

    VideoEncoder.isConfigSupported(config)
      .then((result) => {
        if (!isResolved) {
          isResolved = true;
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          console.log(`VideoWorker: ✅ Codec support check completed for ${config.codec}:`, result);
          resolve(result);
        }
      })
      .catch((error) => {
        if (!isResolved) {
          isResolved = true;
          if (timeoutId !== null) {
            clearTimeout(timeoutId);
          }
          console.log(`VideoWorker: ❌ Codec support check failed for ${config.codec}:`, error.message);
          reject(error);
        }
      });
  });
}

/**
 * Process a video frame through downscaling using OffscreenCanvas
 */
async function processFrameWithDownscaling(originalFrame: VideoFrame): Promise<void> {
  if (!canvasContext || !offscreenCanvas || !videoEncoder) {
    throw new Error('Downscaling components not initialized');
  }

  let scaledFrame: VideoFrame | null = null;
  let bitmap: ImageBitmap | null = null;

  try {
    const startTime = performance.now();
    
    bitmap = await createImageBitmap(originalFrame);
    const bitmapTime = performance.now() - startTime;

    const drawStart = performance.now();
    canvasContext.drawImage(bitmap, 0, 0, scaledWidth, scaledHeight);
    const drawTime = performance.now() - drawStart;

    const frameCreateStart = performance.now();
    scaledFrame = new VideoFrame(offscreenCanvas, {
      timestamp: originalFrame.timestamp,
      duration: originalFrame.duration || undefined
    });
    const frameCreateTime = performance.now() - frameCreateStart;

    // Check backpressure before encoding
    const currentQueueSize = videoEncoder.encodeQueueSize;
    
    if (currentQueueSize > HIGH_WATER_MARK) {
      console.warn(`VideoWorker: Frame dropped due to encoder backpressure (queue: ${currentQueueSize})`);
      needsKeyFrame = true;
      videoFramesDropped++;
      
      if (!isThrottled) {
        isThrottled = true;
        consecutiveHighPressureCount++;
        self.postMessage({ 
          type: 'pressure', 
          status: 'high',
          queueSize: currentQueueSize,
          immediate: true,
          consecutiveCount: consecutiveHighPressureCount
        });
      }
      
      if (scaledFrame) scaledFrame.close();
      originalFrame.close();
      return;
    }
    
    // Check for recovery
    if (currentQueueSize <= LOW_WATER_MARK && isThrottled) {
      isThrottled = false;
      consecutiveHighPressureCount = 0;
      lastLowPressureTimestamp = performance.now();
      self.postMessage({ 
        type: 'pressure', 
        status: 'low',
        queueSize: currentQueueSize,
        immediate: true
      });
    }

    // Encode the scaled frame
    const encodeStart = performance.now();
    
    if (needsKeyFrame) {
      videoEncoder.encode(scaledFrame, { keyFrame: true });
      needsKeyFrame = false;
      console.log('VideoWorker: Forced keyframe in downscaling path');
    } else {
      videoEncoder.encode(scaledFrame);
    }
    const encodeTime = performance.now() - encodeStart;
    
    scaledFrame.close();
    originalFrame.close();

    // Performance logging every 150 frames
    if (videoFramesProcessed % 150 === 0) {
      const totalTime = bitmapTime + drawTime + frameCreateTime + encodeTime;
      console.log(`📊 VideoWorker downscaling performance - Total: ${totalTime.toFixed(1)}ms`);
    }

    videoFramesProcessed++;

  } catch (error) {
    console.error('VideoWorker: Error in processFrameWithDownscaling:', error);
    if (bitmap) bitmap.close();
    if (scaledFrame) scaledFrame.close();
    originalFrame.close();
    throw error;
  } finally {
    if (bitmap) bitmap.close();
  }
}

/**
 * Setup video encoder with codec negotiation
 */
async function setupVideoEncoder(config: any): Promise<void> {
  console.log('VideoWorker: Setting up video encoder with config:', config);

  // Determine target resolution
  const originalWidth = config.width;
  const originalHeight = config.height;
  const resolutionTarget = config.resolutionTarget || 'auto';
  const targetDimensions = determineTargetResolution(originalWidth, originalHeight, resolutionTarget);
  
  needsScaling = targetDimensions.needsScaling;
  scaledWidth = targetDimensions.width;
  scaledHeight = targetDimensions.height;
  
  console.log('VideoWorker: Resolution determination:', {
    original: { width: originalWidth, height: originalHeight },
    target: resolutionTarget,
    final: { width: scaledWidth, height: scaledHeight },
    needsScaling
  });
  
  // Create OffscreenCanvas if scaling needed
  if (needsScaling) {
    offscreenCanvas = new OffscreenCanvas(scaledWidth, scaledHeight);
    canvasContext = offscreenCanvas.getContext('2d', { 
      alpha: false,
      desynchronized: true,
      willReadFrequently: false
    });
    if (!canvasContext) {
      throw new Error('Failed to create optimized 2D context for downscaling canvas');
    }
    
    canvasContext.imageSmoothingEnabled = false;
    canvasContext.imageSmoothingQuality = 'low';
    
    console.log('VideoWorker: 🎨 OffscreenCanvas scaling enabled');
  } else {
    console.log('VideoWorker: 🚀 Direct encoding path enabled - maximum performance');
  }

  // Codec selection logic
  const validatedFrameRate = Math.max(1, Math.min(120, config.frameRate || 30));
  const keyframeIntervalFrames = config.keyframeIntervalSeconds 
    ? Math.round(config.keyframeIntervalSeconds * validatedFrameRate)
    : Math.round(2 * validatedFrameRate);

  const baseEncoderConfig = {
    width: scaledWidth,
    height: scaledHeight,  
    bitrate: config.bitrate,
    framerate: validatedFrameRate,
    keyframeInterval: keyframeIntervalFrames,
    latencyMode: 'realtime' as LatencyMode,
    hardwareAcceleration: config.hardwareAcceleration || 'prefer-hardware'
  };

  let encoderConfig: any = null;

  // Codec strategies in priority order
  const codecStrategies = [
    {
      name: 'av1',
      codecs: ['av01.0.04M.08'],
      muxerType: 'webm'
    },
    {
      name: 'hevc',
      codecs: [
        'hvc1.1.6.L93.B0',
        'hev1.1.6.L93.B0',
        'hvc1.1.6.L120.B0',
        'hev1.1.6.L120.B0'
      ],
      muxerType: 'mp4'
    },
    {
      name: 'h264',
      codecs: [
        'avc1.42001f',
        'avc1.42E01E', 
        'avc1.4D401E',
        'avc1.640028'
      ],
      muxerType: 'mp4'
    },
    {
      name: 'vp9',
      codecs: ['vp09.00.10.08'],
      muxerType: 'webm'
    }
  ];

  // Try each strategy
  for (const strategy of codecStrategies) {
    console.log(`VideoWorker: Attempting ${strategy.name.toUpperCase()} codec configuration...`);
    
    for (const codec of strategy.codecs) {
      try {
        const testConfig = { ...baseEncoderConfig, codec };
        const configSupport = await checkVideoSupportWithTimeout(testConfig, 2000);
        
        if (configSupport.supported) {
          encoderConfig = testConfig;
          finalCodec = strategy.name as 'av1' | 'hevc' | 'h264' | 'vp9';
          console.log(`VideoWorker: ✅ Selected codec: ${finalCodec} (${codec})`);
          break;
        }
      } catch (error) {
        console.warn(`VideoWorker: ${strategy.name.toUpperCase()} codec ${codec} failed:`, error instanceof Error ? error.message : String(error));
      }
    }
    
    if (encoderConfig) break;
  }

  if (!encoderConfig || !finalCodec) {
    throw new Error('No supported video codec found');
  }

  currentConfig = encoderConfig;
  
  // Create VideoEncoder
  videoEncoder = new VideoEncoder({
    output: (chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) => {
      try {
        // Send video chunk to main thread
        self.postMessage({
          type: 'video-chunk',
          chunk: chunk,
          metadata: metadata || {}
        });
      } catch (error) {
        console.error('VideoWorker: Error sending video chunk:', error);
        self.postMessage({ 
          type: 'error', 
          error: error instanceof Error ? error.message : String(error) 
        });
      }
    },
    error: (error: Error) => {
      console.error('VideoWorker: VideoEncoder error:', error);
      self.postMessage({ type: 'error', error: error.message });
    }
  });

  // Configure encoder
  console.log(`📊 VideoWorker: Configuring VideoEncoder - Pre-config state: ${videoEncoder.state}`);
  videoEncoder.configure(encoderConfig);
  console.log(`📊 VideoWorker: VideoEncoder configured - Post-config state: ${videoEncoder.state}`);
}

/**
 * Start video processing from ReadableStream
 */
async function startVideoProcessing(videoStream: ReadableStream<VideoFrame>): Promise<void> {
  try {
    console.log('VideoWorker: 🚀 Starting dedicated video processing');
    
    // Use the stream provided by main thread
    streamReader = videoStream.getReader();
    
    // Reset state
    videoFramesProcessed = 0;
    videoFramesDropped = 0;
    firstVideoTimestamp = null;
    
    console.log('VideoWorker: 🚀 Video processing loop starting');
    
    // Main processing loop
    while (true) {
      // 🎯 GRACEFUL SHUTDOWN: Check stop flag at start of each iteration
      if (shouldStop) {
        console.log('🚀 VideoWorker: Terminating processing loop gracefully');
        break;
      }
      
      const { done, value: frame } = await streamReader.read();
      
      if (done) {
        console.log('VideoWorker: 🚀 Video stream ended');
        break;
      }
      
      if (!frame) {
        console.warn('VideoWorker: Received null frame, skipping');
        continue;
      }
      
      // Apply timestamp normalization
      if (firstVideoTimestamp === null) {
        firstVideoTimestamp = frame.timestamp;
      }
      const normalizedTimestamp = frame.timestamp - firstVideoTimestamp;
      
      // Create normalized frame for encoding
      const normalizedFrame = new VideoFrame(frame, {
        timestamp: normalizedTimestamp,
        duration: frame.duration ?? undefined
      });
      
      // Close original frame
      frame.close();
      
      // Process frame
      if (needsScaling) {
        await processFrameWithDownscaling(normalizedFrame);
      } else {
        // Direct encoding path
        if (videoEncoder) {
          const currentQueueSize = videoEncoder.encodeQueueSize;
          
          // Backpressure check
          if (currentQueueSize > HIGH_WATER_MARK) {
            console.warn(`VideoWorker: Dropping frame due to backpressure (queue: ${currentQueueSize})`);
            videoFramesDropped++;
            needsKeyFrame = true;
            
            if (!isThrottled) {
              isThrottled = true;
              consecutiveHighPressureCount++;
              self.postMessage({ 
                type: 'pressure', 
                status: 'high',
                queueSize: currentQueueSize,
                immediate: true
              });
            }
            
            normalizedFrame.close();
            continue;
          }
          
          // Recovery check
          if (currentQueueSize <= LOW_WATER_MARK && isThrottled) {
            isThrottled = false;
            consecutiveHighPressureCount = 0;
            self.postMessage({ 
              type: 'pressure', 
              status: 'low',
              queueSize: currentQueueSize,
              immediate: true
            });
          }
          
          // Encode frame
          if (needsKeyFrame) {
            videoEncoder.encode(normalizedFrame, { keyFrame: true });
            needsKeyFrame = false;
            console.log('VideoWorker: 🚀 Forced keyframe in direct encoding path');
          } else {
            videoEncoder.encode(normalizedFrame);
          }
          
          normalizedFrame.close();
          videoFramesProcessed++;
          
          // Periodic performance logging
          if (videoFramesProcessed % 150 === 0) {
            console.log(`📊 VideoWorker: Processed ${videoFramesProcessed} frames (direct encoding)`);
          }
        }
      }
    }
    
  } catch (error) {
    console.error('VideoWorker: Error in video processing:', error);
    self.postMessage({ 
      type: 'error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  } finally {
    // 🎯 GRACEFUL SHUTDOWN: Cleanup happens here after loop exits
    if (streamReader) {
      try {
        streamReader.releaseLock();
        streamReader = null;
        console.log('VideoWorker: Stream reader released');
      } catch (releaseError) {
        console.warn('VideoWorker: Reader already released');
      }
    }
    
    // Flush and close encoder
    if (videoEncoder) {
      try {
        console.log('VideoWorker: Flushing VideoEncoder...');
        await videoEncoder.flush();
        videoEncoder.close();
        videoEncoder = null;
        console.log('VideoWorker: VideoEncoder closed');
      } catch (encoderError) {
        console.warn('VideoWorker: Error closing encoder:', encoderError);
      }
    }
    
    console.log('VideoWorker: Processing complete, sending completion signal');
    self.postMessage({ type: 'complete' });
  }
}

/**
 * Handle incoming messages from main thread
 */
self.onmessage = async (event: MessageEvent<VideoWorkerRequest>) => {
  console.log('🔔 VideoWorker: Received message:', event.data.type);
  try {
    const { data } = event;
    
    switch (data.type) {
      case 'start':
        console.log('🎬 VideoWorker: Processing start message...');
        
        if (!data.config) {
          throw new Error('No configuration provided');
        }
        
        if (!data.videoStream) {
          throw new Error('No video stream provided');
        }
        
        // Reset shutdown flag for new recording
        shouldStop = false;
        
        // Setup video encoder
        await setupVideoEncoder(data.config);
        
        // Send ready signal with codec info
        self.postMessage({
          type: 'ready',
          finalCodec: finalCodec
        });
        
        // Start video processing (will handle its own cleanup via finally block)
        await startVideoProcessing(data.videoStream);
        
        // After processing completes, terminate worker
        self.close();
        break;
      
      case 'stop':
        console.log('🛑 VideoWorker: Stop signal received, setting graceful shutdown flag');
        shouldStop = true;
        // Note: All cleanup will happen in startVideoProcessing's finally block
        break;
      
      default:
        console.warn('VideoWorker: Unknown message type:', data.type);
    }
  } catch (error) {
    console.error('VideoWorker: Error handling message:', error);
    self.postMessage({ 
      type: 'error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
};

console.log('✅ VideoWorker: Dedicated video processing worker ready');
