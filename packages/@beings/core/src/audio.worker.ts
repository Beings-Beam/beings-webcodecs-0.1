/// <reference lib="webworker" />

/**
 * Audio Worker - Dedicated Audio Processing and Encoding
 * 
 * This worker handles ONLY audio processing in a dedicated thread,
 * eliminating interference with video processing. Optimized for
 * high-frequency audio data (48kHz = 1000+ frames/second).
 */

import type { AudioWorkerRequest, AudioWorkerResponse, AudioConfig } from './types';

// Audio processing state
let audioEncoder: AudioEncoder | null = null;
let streamReader: ReadableStreamDefaultReader<AudioData> | null = null;
let currentAudioConfig: AudioEncoderConfig | null = null;
let finalAudioCodec: 'opus' | 'aac' | 'mp3' | 'flac' | null = null;

// Audio upmixing state
let needsUpmixing = false;
let originalStreamChannels = 0;
let finalEncoderChannels = 0;

// Performance tracking
let audioFramesProcessed = 0;
let firstAudioTimestamp: number | null = null;

// Graceful shutdown control
let shouldStop = false;

/**
 * Check audio codec support with timeout
 */
async function checkAudioSupportWithTimeout(
  config: AudioEncoderConfig, 
  timeout = 2000
): Promise<AudioEncoderSupport> {
  return new Promise((resolve, reject) => {
    let timeoutId: number | null = null;
    let isResolved = false;
    
    timeoutId = self.setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        reject(new Error(`Audio codec support check timeout after ${timeout}ms`));
      }
    }, timeout);

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
 * Convert 32-bit float audio to 16-bit integer format for encoder compatibility
 */
function convertF32toS16(audioData: AudioData): AudioData {
  try {
    const sampleRate = audioData.sampleRate;
    const numberOfChannels = audioData.numberOfChannels;
    const numberOfFrames = audioData.numberOfFrames;
    const timestamp = audioData.timestamp;
    const duration = audioData.duration;
    
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
    
    return s16AudioData;
    
  } catch (error) {
    console.error('AudioWorker: Error in convertF32toS16:', error);
    throw error;
  }
}

/**
 * Upmix mono audio to stereo by duplicating the mono channel
 */
function upmixMonoToStereo(monoAudioData: AudioData): AudioData {
  try {
    if (monoAudioData.numberOfChannels !== 1) {
      throw new Error(`Expected mono audio (1 channel), got ${monoAudioData.numberOfChannels} channels`);
    }
    
    const sampleRate = monoAudioData.sampleRate;
    const numberOfFrames = monoAudioData.numberOfFrames;
    const timestamp = monoAudioData.timestamp;
    const duration = monoAudioData.duration;
    const originalFormat = monoAudioData.format;
    
    const is16Bit = originalFormat === 's16' || originalFormat === 's16-planar';
    
    if (is16Bit) {
      // Handle 16-bit integer format
      const stereoBufferSize = numberOfFrames * 2; // 2 channels
      const stereoBuffer = new Int16Array(stereoBufferSize);
      
      const inputFormat = monoAudioData.format;
      
      if (inputFormat && inputFormat.startsWith('f32')) {
        // Convert float32 to int16
        const monoBuffer = new Float32Array(numberOfFrames);
        monoAudioData.copyTo(monoBuffer, { planeIndex: 0 });
        
        for (let i = 0; i < numberOfFrames; i++) {
          const sample = Math.max(-1, Math.min(1, monoBuffer[i]));
          const intSample = Math.round(sample * 32767);
          stereoBuffer[i * 2] = intSample;     // Left channel
          stereoBuffer[i * 2 + 1] = intSample; // Right channel
        }
        
      } else if (inputFormat && inputFormat.startsWith('s16')) {
        // Direct copy for 16-bit integer
        const monoBuffer = new Int16Array(numberOfFrames);
        monoAudioData.copyTo(monoBuffer, { planeIndex: 0 });
        
        for (let i = 0; i < numberOfFrames; i++) {
          const sample = monoBuffer[i];
          stereoBuffer[i * 2] = sample;     // Left channel
          stereoBuffer[i * 2 + 1] = sample; // Right channel
        }
        
      } else {
        throw new Error(`Unsupported source audio format for upmixing: ${inputFormat}`);
      }
      
      return new AudioData({
        format: 's16',
        sampleRate: sampleRate,
        numberOfChannels: 2,
        numberOfFrames: numberOfFrames,
        timestamp: timestamp,
        data: stereoBuffer
      });
      
    } else {
      // Handle float formats
      const stereoBufferSize = numberOfFrames * 2;
      const stereoBuffer = new Float32Array(stereoBufferSize);
      
      const monoBuffer = new Float32Array(numberOfFrames);
      monoAudioData.copyTo(monoBuffer, { planeIndex: 0 });
      
      for (let i = 0; i < numberOfFrames; i++) {
        const sample = monoBuffer[i];
        stereoBuffer[i * 2] = sample;     // Left channel
        stereoBuffer[i * 2 + 1] = sample; // Right channel
      }
      
      return new AudioData({
        format: (originalFormat && originalFormat.includes('planar')) ? 'f32-planar' : 'f32',
        sampleRate: sampleRate,
        numberOfChannels: 2,
        numberOfFrames: numberOfFrames,
        timestamp: timestamp,
        data: stereoBuffer
      });
    }
    
  } catch (error) {
    console.error('AudioWorker: Error in upmixMonoToStereo:', error);
    throw error;
  }
}

/**
 * Setup and configure the AudioEncoder
 */
async function setupAudioEncoder(audioConfig: AudioConfig & { codec: 'auto' | 'opus' | 'aac' | 'mp3' | 'flac' }, containerType: 'mp4' | 'webm', originalSampleRate: number): Promise<void> {
  try {
    console.log('AudioWorker: Setting up audio encoder with config:', audioConfig, 'container:', containerType);
    
    // Handle auto-selection of audio codec based on container type
    let finalAudioConfig = audioConfig;
    if (audioConfig.codec === 'auto') {
      if (containerType === 'mp4') {
        finalAudioConfig = { ...audioConfig, codec: 'aac' };
        console.log('AudioWorker: Auto-selected AAC audio codec for MP4 container');
      } else if (containerType === 'webm') {
        finalAudioConfig = { ...audioConfig, codec: 'opus' };
        console.log('AudioWorker: Auto-selected Opus audio codec for WebM container');
      } else {
        finalAudioConfig = { ...audioConfig, codec: 'aac' };
        console.log('AudioWorker: Auto-selected AAC audio codec (fallback)');
      }
    }
    
    // Map audio codec to WebCodecs format
    let webCodecsCodec: string;
    
    switch (finalAudioConfig.codec) {
      case 'opus':
        if (containerType !== 'webm') {
          console.log('AudioWorker: Auto-converting OPUS to AAC for MP4 container compatibility');
          webCodecsCodec = 'mp4a.40.2'; // AAC-LC profile
          finalAudioCodec = 'aac';
        } else {
          webCodecsCodec = 'opus';
          finalAudioCodec = 'opus';
        }
        break;
        
      case 'aac':
        if (containerType !== 'mp4') {
          throw new Error('AAC codec is only supported in MP4 containers');
        }
        webCodecsCodec = 'mp4a.40.2'; // AAC-LC profile
        finalAudioCodec = 'aac';
        break;
        
      case 'mp3':
        if (containerType !== 'mp4') {
          throw new Error('MP3 codec is only supported in MP4 containers');
        }
        webCodecsCodec = 'mp3';
        finalAudioCodec = 'mp3';
        break;
        
      case 'flac':
        if (containerType !== 'webm') {
          throw new Error('FLAC codec is only supported in WebM containers');
        }
        webCodecsCodec = 'flac';
        finalAudioCodec = 'flac';
        break;
        
      default:
        throw new Error(`Unsupported audio codec: ${finalAudioConfig.codec}`);
    }
    
    // Use original stream sample rate
    let sampleRate = originalSampleRate;
    let numberOfChannels = finalAudioConfig.numberOfChannels;
    
    console.log(`AudioWorker: Using original stream sample rate: ${sampleRate}Hz`);
    
    let audioEncoderConfig: AudioEncoderConfig = {
      codec: webCodecsCodec,
      sampleRate: sampleRate,
      numberOfChannels: numberOfChannels,
      bitrate: finalAudioConfig.bitrate
    };
    
    console.log('AudioWorker: Testing audio encoder configuration:', audioEncoderConfig);
    
    // Validate configuration with fallbacks
    let configSupport = await checkAudioSupportWithTimeout(audioEncoderConfig, 2000);
    console.log('AudioWorker: Audio encoder support result:', {
      supported: configSupport.supported,
      config: configSupport.config
    });
    
    if (!configSupport.supported) {
      console.log('AudioWorker: Initial config not supported, trying fallbacks...');
      
      // Fallback configurations
      const fallbackConfigs = [];
      
      if (finalAudioConfig.codec === 'aac') {
        fallbackConfigs.push(
          { ...audioEncoderConfig, bitrate: 192000 },
          { ...audioEncoderConfig, bitrate: 128000 },
          { ...audioEncoderConfig, bitrate: 96000 },
          { ...audioEncoderConfig, numberOfChannels: 2, bitrate: 128000 }
        );
      } else if (finalAudioConfig.codec === 'opus') {
        fallbackConfigs.push(
          { ...audioEncoderConfig, bitrate: 128000 },
          { ...audioEncoderConfig, bitrate: 96000 },
          { ...audioEncoderConfig, numberOfChannels: 2, bitrate: 128000 }
        );
      }
      
      let fallbackWorked = false;
      for (let i = 0; i < fallbackConfigs.length; i++) {
        const fallbackConfig = fallbackConfigs[i];
        console.log(`AudioWorker: Trying fallback ${i + 1}:`, fallbackConfig);
        
        try {
          const fallbackSupport = await checkAudioSupportWithTimeout(fallbackConfig, 2000);
          if (fallbackSupport.supported) {
            console.log(`AudioWorker: ✅ Fallback ${i + 1} succeeded`);
            audioEncoderConfig = fallbackConfig;
            configSupport = fallbackSupport;
            fallbackWorked = true;
            break;
          }
        } catch (error) {
          console.log(`AudioWorker: ❌ Fallback ${i + 1} failed:`, error instanceof Error ? error.message : String(error));
        }
      }
      
      if (!fallbackWorked) {
        throw new Error(`No supported audio encoder configuration found. Browser may not support this sample rate (${originalSampleRate}Hz)`);
      }
    }
    
    // Create AudioEncoder
    audioEncoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => {
        try {
          // Send audio chunk to main thread
          self.postMessage({
            type: 'audio-chunk',
            chunk: chunk,
            metadata: metadata || {}
          });
        } catch (error) {
          console.error('AudioWorker: Error sending audio chunk:', error);
          self.postMessage({ 
            type: 'error', 
            error: error instanceof Error ? error.message : String(error) 
          });
        }
      },
      error: (error: Error) => {
        console.error('AudioWorker: AudioEncoder error:', error);
        self.postMessage({ type: 'error', error: error.message });
      }
    });
    
    // Store final configuration
    currentAudioConfig = configSupport.config || audioEncoderConfig;
    
    // Configure encoder
    console.log(`📊 AudioWorker: Configuring AudioEncoder - Pre-config state: ${audioEncoder.state}`);
    audioEncoder.configure(currentAudioConfig);
    console.log(`📊 AudioWorker: AudioEncoder configured - Post-config state: ${audioEncoder.state}`);
    
    // Detect channel mismatch for upmixing
    originalStreamChannels = finalAudioConfig.numberOfChannels;
    finalEncoderChannels = currentAudioConfig.numberOfChannels;
    
    if (originalStreamChannels === 1 && finalEncoderChannels === 2) {
      needsUpmixing = true;
      console.log('AudioWorker: 🎵 Enabling mono-to-stereo upmixing');
    } else if (originalStreamChannels !== finalEncoderChannels) {
      console.warn(`AudioWorker: ⚠️ Unsupported channel mismatch - Stream: ${originalStreamChannels}, Encoder: ${finalEncoderChannels}`);
    } else {
      needsUpmixing = false;
      console.log(`AudioWorker: ✅ Channel configuration matches - ${originalStreamChannels} channels`);
    }
    
    console.log('AudioWorker: Audio encoder successfully configured');
    
  } catch (error) {
    console.error('AudioWorker: Error setting up audio encoder:', error);
    throw error;
  }
}

/**
 * Start audio processing from ReadableStream
 */
async function startAudioProcessing(audioStream: ReadableStream<AudioData>): Promise<void> {
  try {
    console.log('AudioWorker: 🚀 Starting dedicated audio processing');
    
    // Use the stream provided by main thread
    streamReader = audioStream.getReader();
    
    // Reset state
    audioFramesProcessed = 0;
    firstAudioTimestamp = null;
    
    console.log('AudioWorker: 🚀 Audio processing loop starting');
    
    // Main processing loop
    while (true) {
      // 🎯 GRACEFUL SHUTDOWN: Check stop flag at start of each iteration
      if (shouldStop) {
        console.log('🚀 AudioWorker: Terminating processing loop gracefully');
        break;
      }
      
      const { done, value: audioFrame } = await streamReader.read();
      
      if (done) {
        console.log('AudioWorker: 🚀 Audio stream ended');
        break;
      }
      
      if (!audioFrame) {
        console.warn('AudioWorker: Received null audio frame, skipping');
        continue;
      }
      
      // Monitor encoder backpressure
      if (audioEncoder && audioEncoder.encodeQueueSize > 30) {
        console.warn(`⚠️ AudioWorker: Encoder queue overloaded (${audioEncoder.encodeQueueSize}), waiting...`);
        while (audioEncoder && audioEncoder.encodeQueueSize > 15) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        console.log(`✅ AudioWorker: Encoder queue recovered (${audioEncoder?.encodeQueueSize})`);
      }
      
      // Apply timestamp normalization
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
      
      // Close original frame
      audioFrame.close();
      
      // Process audio frame
      if (audioEncoder) {
        let frameToEncode = normalizedAudioFrame;
        let needsCleanup = false;
        
        try {
          // Handle channel mismatch with upmixing
          if (needsUpmixing && normalizedAudioFrame.numberOfChannels === 1 && finalEncoderChannels === 2) {
            frameToEncode = upmixMonoToStereo(normalizedAudioFrame);
            needsCleanup = true;
          } else if (currentAudioConfig && normalizedAudioFrame.numberOfChannels !== currentAudioConfig.numberOfChannels) {
            console.warn(`AudioWorker: ⚠️ Channel mismatch - Frame: ${normalizedAudioFrame.numberOfChannels}, Encoder: ${currentAudioConfig.numberOfChannels}`);
            normalizedAudioFrame.close();
            continue;
          }
          
          // Check sample rate mismatch
          if (currentAudioConfig && normalizedAudioFrame.sampleRate !== currentAudioConfig.sampleRate) {
            console.warn(`AudioWorker: Sample rate mismatch - Frame: ${normalizedAudioFrame.sampleRate}Hz, Encoder: ${currentAudioConfig.sampleRate}Hz`);
            normalizedAudioFrame.close();
            if (needsCleanup && frameToEncode !== normalizedAudioFrame) {
              frameToEncode.close();
            }
            continue;
          }
          
          // Handle format conversion for AAC
          let finalFrameToEncode = frameToEncode;
          let formatConversionNeeded = false;
          
          if (frameToEncode.format && frameToEncode.format.startsWith('f32') && 
              currentAudioConfig && currentAudioConfig.codec && currentAudioConfig.codec.includes('aac')) {
            finalFrameToEncode = convertF32toS16(frameToEncode);
            formatConversionNeeded = true;
          }
          
          // Encode the frame
          audioEncoder.encode(finalFrameToEncode);
          
          audioFramesProcessed++;
          
          // Periodic performance logging
          if (audioFramesProcessed % 1000 === 0) {
            console.log(`📊 AudioWorker: Processed ${audioFramesProcessed} audio frames`);
          }
          
          // Clean up frames
          if (formatConversionNeeded && finalFrameToEncode !== frameToEncode) {
            finalFrameToEncode.close();
          }
          
        } catch (error) {
          console.error('AudioWorker: Error processing audio frame:', error);
          if (needsCleanup && frameToEncode !== normalizedAudioFrame) {
            frameToEncode.close();
          }
          throw error;
        }
        
        // Clean up
        normalizedAudioFrame.close();
        if (needsCleanup && frameToEncode !== normalizedAudioFrame) {
          frameToEncode.close();
        }
      }
    }
    
  } catch (error) {
    console.error('AudioWorker: Error in audio processing:', error);
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
        console.log('AudioWorker: Stream reader released');
      } catch (releaseError) {
        console.warn('AudioWorker: Reader already released');
      }
    }
    
    // Flush and close encoder
    if (audioEncoder) {
      try {
        console.log('AudioWorker: Flushing AudioEncoder...');
        await audioEncoder.flush();
        audioEncoder.close();
        audioEncoder = null;
        console.log('AudioWorker: AudioEncoder closed');
      } catch (encoderError) {
        console.warn('AudioWorker: Error closing encoder:', encoderError);
      }
    }
    
    console.log('AudioWorker: Processing complete, sending completion signal');
    self.postMessage({ type: 'complete' });
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
 * Handle incoming messages from main thread
 */
self.onmessage = async (event: MessageEvent<AudioWorkerRequest>) => {
  console.log('🔔 AudioWorker: Received message:', event.data.type);
  try {
    const { data } = event;
    
    switch (data.type) {
      case 'start':
        console.log('🎬 AudioWorker: Processing start message...');
        
        if (!data.config || !data.config.audio) {
          throw new Error('No audio configuration provided');
        }
        
        if (!data.audioStream) {
          throw new Error('No audio stream provided');
        }
        
        // Reset shutdown flag for new recording
        shouldStop = false;
        
        // Determine container type from video codec (passed in config)
        const containerType: 'mp4' | 'webm' = (data.config.codecSelection === 'av1' || data.config.codecSelection === 'vp9') ? 'webm' : 'mp4';
        
        // Extract original sample rate
        const originalSampleRate = data.config.audio.sampleRate;
        
        // Setup audio encoder
        await setupAudioEncoder(data.config.audio, containerType, originalSampleRate);
        
        // Send ready signal
        self.postMessage({
          type: 'ready',
          finalCodec: finalAudioCodec
        });
        
        // Start audio processing (will handle its own cleanup via finally block)
        await startAudioProcessing(data.audioStream);
        
        // After processing completes, terminate worker
        self.close();
        break;
      
      case 'stop':
        console.log('🛑 AudioWorker: Stop signal received, setting graceful shutdown flag');
        shouldStop = true;
        // Note: All cleanup will happen in startAudioProcessing's finally block
        break;
      
      default:
        console.warn('AudioWorker: Unknown message type:', data.type);
    }
  } catch (error) {
    console.error('AudioWorker: Error handling message:', error);
    self.postMessage({ 
      type: 'error', 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
};

console.log('✅ AudioWorker: Dedicated audio processing worker ready');
