# Audio Capture & Processing

## Overview

The Beings WebCodecs audio capture system provides high-fidelity audio recording capabilities that work seamlessly alongside video recording. The system implements intelligent codec selection, channel upmixing, and sample rate preservation to ensure maximum compatibility across different hardware configurations.

## Architecture

### Dual-Pipeline Design

The audio system operates in parallel with video processing using a dual-pipeline architecture:

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Main Thread   │    │      Worker      │    │     Output      │
│                 │    │                  │    │                 │
│ ┌─────────────┐ │    │ ┌──────────────┐ │    │ ┌─────────────┐ │
│ │ Video Track │─┼────┼▶│ VideoEncoder │ │    │ │             │ │
│ └─────────────┘ │    │ └──────────────┘ │    │ │             │ │
│                 │    │        │         │    │ │   MP4/WebM  │ │
│ ┌─────────────┐ │    │        ▼         │    │ │    Muxer    │ │
│ │ Audio Track │─┼────┼▶┌──────────────┐ │    │ │             │ │
│ └─────────────┘ │    │ │ AudioEncoder │─┼────┼▶│             │ │
│                 │    │ │  + Upmixing  │ │    │ └─────────────┘ │
│                 │    │ └──────────────┘ │    └─────────────────┘
└─────────────────┘    └──────────────────┘
```

### Core Components

1. **AudioConfig Interface**: Defines audio recording parameters
2. **Smart Codec Selection**: Automatic codec selection based on video container
3. **Channel Upmixing**: Mono-to-stereo conversion for hardware compatibility
4. **Sample Rate Preservation**: Maintains original audio quality
5. **Fallback Strategies**: Graceful degradation for unsupported configurations

## Implementation Details

### AudioConfig Interface

```typescript
interface AudioConfig {
  enabled: boolean;
  codec: 'auto' | 'opus' | 'aac' | 'mp3' | 'flac';
  sampleRate: 48000 | 44100 | 32000 | 16000;
  numberOfChannels: 1 | 2;
  bitrate: number;
}
```

### Codec Selection Logic

The system automatically selects the appropriate audio codec based on the video container format:

| Video Codec | Container | Audio Codec | Reasoning |
|-------------|-----------|-------------|-----------|
| AV1 | WebM | Opus | Native WebM audio format |
| VP9 | WebM | Opus | Native WebM audio format |
| HEVC | MP4 | AAC | Native MP4 audio format |
| H.264 | MP4 | AAC | Native MP4 audio format |
| Auto | Both | Auto | Determined by final video codec |

### Channel Upmixing System

#### Problem
Many microphones capture mono audio (1 channel), but browser hardware encoders often only support stereo configurations (2 channels), leading to encoding failures.

#### Solution
The system implements intelligent channel upmixing:

```typescript
function upmixMonoToStereo(monoAudioData: AudioData): AudioData {
  // Extract mono samples
  const monoBuffer = new Float32Array(numberOfFrames);
  monoAudioData.copyTo(monoBuffer, { planeIndex: 0 });
  
  // Create stereo buffer with duplicated samples
  const stereoBuffer = new Float32Array(numberOfFrames * 2);
  for (let i = 0; i < numberOfFrames; i++) {
    const sample = monoBuffer[i];
    stereoBuffer[i * 2] = sample;     // Left channel
    stereoBuffer[i * 2 + 1] = sample; // Right channel
  }
  
  // Create new stereo AudioData frame
  return new AudioData({
    format: 'f32-planar',
    sampleRate: sampleRate,
    numberOfChannels: 2,
    numberOfFrames: numberOfFrames,
    timestamp: timestamp,
    data: stereoBuffer
  });
}
```

#### Detection Logic
```typescript
// Detect channel mismatch during encoder setup
if (originalStreamChannels === 1 && finalEncoderChannels === 2) {
  needsUpmixing = true;
  console.log('Worker: 🎵 Channel mismatch detected - enabling mono-to-stereo upmixing');
}
```

### Sample Rate Preservation

#### Problem
Browser fallback systems might select audio encoder configurations with different sample rates than the original stream, causing data format mismatches.

#### Solution
The fallback system is constrained to only try configurations that match the original stream's sample rate:

```typescript
// Fallback configurations only use original sample rate
const fallbackConfigs = [
  { ...audioEncoderConfig, numberOfChannels: 2, bitrate: 128000 },
  { ...audioEncoderConfig, numberOfChannels: 2, bitrate: 96000 },
  { codec: 'mp4a.40.2', sampleRate: originalSampleRate, numberOfChannels: 2, bitrate: 128000 }
];
```

### Error Handling & Fallback Strategy

The system implements a multi-level fallback strategy:

1. **Primary**: Try original stream configuration
2. **Fallback Level 1**: Try stereo with different bitrates at original sample rate
3. **Fallback Level 2**: Try mono with different bitrates at original sample rate
4. **Final Fallback**: Disable audio and continue with video-only recording

```typescript
try {
  await setupAudioEncoder(audioConfig, containerType, originalSampleRate);
} catch (audioError) {
  console.warn('Worker: ⚠️ Audio setup failed, proceeding with video-only recording');
  audioEnabled = false; // Graceful degradation
}
```

## Audio Processing Pipeline

### 1. Stream Capture
```typescript
// Main thread: Request audio along with video
const stream = await navigator.mediaDevices.getDisplayMedia({ 
  video: true, 
  audio: true 
});

// Extract audio track
const audioTrack = stream.getAudioTracks()[0];
const audioSettings = audioTrack.getSettings();
```

### 2. Stream Processing
```typescript
// Create audio processor
const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
const audioStream = audioProcessor.readable;

// Transfer to worker
worker.postMessage({ 
  type: 'start', 
  config: recorderConfig, 
  audioStream: audioStream 
}, [audioStream]);
```

### 3. Worker Processing
```typescript
async function startAudioProcessing(stream: ReadableStream<AudioData>) {
  const audioStreamReader = stream.getReader();
  
  while (true) {
    const { done, value: audioFrame } = await audioStreamReader.read();
    if (done) break;
    
    let frameToEncode = audioFrame;
    
    // Apply upmixing if needed
    if (needsUpmixing && audioFrame.numberOfChannels === 1) {
      frameToEncode = upmixMonoToStereo(audioFrame);
    }
    
    // Encode frame
    audioEncoder.encode(frameToEncode);
    
    // Cleanup
    audioFrame.close();
    if (frameToEncode !== audioFrame) {
      frameToEncode.close();
    }
  }
}
```

### 4. Encoding & Muxing
```typescript
const audioEncoder = new AudioEncoder({
  output: (chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) => {
    // Pass to muxer for container creation
    muxer.addAudioChunk(chunk, metadata || {});
  },
  error: (error: Error) => {
    console.error('Worker: AudioEncoder error:', error);
  }
});
```

## Configuration Examples

### Basic Audio Recording
```typescript
const recorder = new SlowTrackRecorder({
  width: 1920,
  height: 1080,
  frameRate: 30,
  bitrate: 5000000,
  audio: {
    enabled: true,
    codec: 'auto',
    sampleRate: 48000,
    numberOfChannels: 2,
    bitrate: 128000
  }
});
```

### High-Quality Audio Recording
```typescript
const recorder = new SlowTrackRecorder({
  width: 1920,
  height: 1080,
  frameRate: 60,
  bitrate: 8000000,
  codecSelection: 'hevc',
  audio: {
    enabled: true,
    codec: 'aac',
    sampleRate: 48000,
    numberOfChannels: 2,
    bitrate: 256000
  }
});
```

### Opus/WebM Recording
```typescript
const recorder = new SlowTrackRecorder({
  width: 1920,
  height: 1080,
  frameRate: 30,
  bitrate: 5000000,
  codecSelection: 'vp9',
  audio: {
    enabled: true,
    codec: 'opus',
    sampleRate: 48000,
    numberOfChannels: 2,
    bitrate: 128000
  }
});
```

## Browser Compatibility

### Supported Browsers
- **Chrome 94+**: Full support for VideoEncoder and AudioEncoder
- **Edge 94+**: Full support for VideoEncoder and AudioEncoder
- **Other Chromium browsers**: Support varies by version

### Known Limitations
- **Safari**: No WebCodecs support (VideoEncoder/AudioEncoder not available)
- **Firefox**: No WebCodecs support (VideoEncoder/AudioEncoder not available)
- **Mobile browsers**: Limited or no WebCodecs support

### Feature Detection
```typescript
// Check audio recording support
const hasAudioSupport = typeof window.AudioEncoder !== 'undefined';

if (!hasAudioSupport) {
  console.warn('Audio recording not supported in this browser');
  // Fall back to video-only recording
}
```

## Performance Considerations

### Memory Management
- **Frame Cleanup**: All AudioData frames are properly closed after processing
- **Buffer Reuse**: Efficient buffer allocation for upmixing operations
- **Worker Isolation**: Audio processing isolated in worker thread

### CPU Usage
- **Concurrent Processing**: Audio and video processing run in parallel
- **Minimal Overhead**: Upmixing only applied when necessary
- **Hardware Acceleration**: Leverages hardware audio encoders when available

### Quality vs Performance Trade-offs
| Configuration | Quality | CPU Usage | File Size |
|---------------|---------|-----------|-----------|
| 48kHz Stereo 256kbps | Excellent | High | Large |
| 48kHz Stereo 128kbps | Very Good | Medium | Medium |
| 44.1kHz Stereo 128kbps | Good | Medium | Medium |
| 48kHz Mono 64kbps | Fair | Low | Small |

## Testing & Validation

### Automated Tests
- Channel upmixing functionality
- Sample rate preservation
- Codec selection logic
- Error handling scenarios

### Manual Testing Scenarios
1. **Mono Microphone**: Test with mono audio input
2. **Stereo Microphone**: Test with stereo audio input
3. **Different Sample Rates**: Test with 44.1kHz, 48kHz inputs
4. **Codec Compatibility**: Test all codec combinations
5. **Error Scenarios**: Test with unsupported configurations

### Debugging Tools
- Comprehensive console logging for audio pipeline
- Frame-level processing statistics
- Codec selection decision logging
- Error reporting with detailed context

## Future Enhancements

### Planned Features
- **Real-time Audio Resampling**: Support for sample rate conversion
- **Audio Filters**: Noise reduction, gain control
- **Multi-track Audio**: Support for multiple audio sources
- **Audio Visualization**: Real-time waveform display

### Technical Debt
- Investigate WebAssembly-based audio processing for better performance
- Add support for additional audio codecs (Vorbis, etc.)
- Implement audio level monitoring and automatic gain control

---

*This document reflects the current implementation as of the latest release. For the most up-to-date information, refer to the source code and test suite.*