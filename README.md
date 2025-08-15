# Beings WebCodecs 0.1 - EXPERIMENT ONLY

A framework-agnostic WebCodecs-based screen recording library with advanced video and audio encoding capabilities.

## Features

### Video Recording
- **High-Fidelity Recording**: WebCodecs-based encoding for superior quality
- **4K Resolution Support**: Record in up to 3840×2160 resolution
- **High Frame Rate Options**: Support for 30fps, 60fps recording
- **Multiple Codec Support**: AV1, HEVC, H.264, VP9 with automatic fallback
- **Hardware Acceleration**: Optimized for hardware encoders when available

### Audio Recording
- **High-Quality Audio**: Concurrent microphone capture with video recording
- **Smart Codec Selection**: Automatic codec selection (AAC for MP4, Opus for WebM)
- **Channel Upmixing**: Intelligent mono-to-stereo conversion for compatibility
- **Sample Rate Preservation**: Maintains original audio quality without resampling
- **Audio Codec Support**: Opus, AAC, FLAC with automatic container compatibility
- **Graceful Fallback**: Falls back to video-only if audio setup fails

### Core Features
- **Framework Agnostic**: Pure TypeScript core with zero dependencies
- **Worker-Based Processing**: Concurrent video and audio encoding for optimal performance
- **Intelligent Error Handling**: Robust fallback strategies for maximum compatibility

## Live Demo

🚀 **[Try the Live Demo](https://beings-beam.github.io/beings-webcodecs-0.1/)**

The demo includes:
- Real-time screen recording preview with audio
- 4K and high frame rate recording options
- Advanced video and audio codec selection
- Performance monitoring and stats
- Hardware acceleration detection
- Audio channel detection and upmixing visualization

## Quick Start

### Video-Only Recording
```typescript
import { SlowTrackRecorder } from '@beings/core';

const recorder = new SlowTrackRecorder({
  width: 1920,
  height: 1080,
  frameRate: 60,
  bitrate: 5000000,
  codecSelection: 'auto'
});

// Start recording
const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
await recorder.start(stream);

// Stop and get result
const videoBlob = await recorder.stop();
```

### Video + Audio Recording
```typescript
import { SlowTrackRecorder } from '@beings/core';

const recorder = new SlowTrackRecorder({
  width: 1920,
  height: 1080,
  frameRate: 60,
  bitrate: 5000000,
  codecSelection: 'auto',
  audio: {
    enabled: true,
    codec: 'auto', // Auto-selects AAC for MP4, Opus for WebM
    sampleRate: 48000,
    numberOfChannels: 2,
    bitrate: 128000
  }
});

// Start recording with audio
const stream = await navigator.mediaDevices.getDisplayMedia({ 
  video: true, 
  audio: true 
});
await recorder.start(stream);

// Stop and get result
const videoBlob = await recorder.stop();
```

## Browser Support

### Video Recording
- Chrome 94+ (WebCodecs VideoEncoder support required)
- Edge 94+
- Other Chromium-based browsers with WebCodecs support

### Audio Recording
- Chrome 94+ (WebCodecs AudioEncoder support required)
- Edge 94+
- Note: Audio support may be limited on some browsers/platforms

## Architecture

- **@beings/core**: Framework-agnostic recording engine
- **SlowTrackRecorder**: Main recording class with event system
- **Dual-Pipeline Processing**: Concurrent video and audio encoding in dedicated worker
- **Automatic Codec Detection**: Intelligent video and audio codec fallback chains
- **Channel Upmixing**: Automatic mono-to-stereo conversion for hardware compatibility
- **Sample Rate Preservation**: Maintains original audio quality without resampling

## Development

```bash
cd packages/@beings/core
npm install
npm test
npm run dev  # Start development server
```

## License

MIT License - See LICENSE file for details.
