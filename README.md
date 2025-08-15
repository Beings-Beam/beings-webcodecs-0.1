# Beings WebCodecs 0.1 - EXPERIMENT ONLY

A framework-agnostic WebCodecs-based screen recording library with advanced video encoding capabilities.

## Features

- **High-Fidelity Recording**: WebCodecs-based encoding for superior quality
- **4K Resolution Support**: Record in up to 3840×2160 resolution
- **High Frame Rate Options**: Support for 30fps, 60fps recording
- **Multiple Codec Support**: AV1, HEVC, H.264, VP9 with automatic fallback
- **Hardware Acceleration**: Optimized for hardware encoders when available
- **Framework Agnostic**: Pure TypeScript core with zero dependencies

## Live Demo

🚀 **[Try the Live Demo](https://beings-beam.github.io/beings-webcodecs-0.1/manual-test.html)**

The demo includes:
- Real-time screen recording preview
- 4K and high frame rate recording options
- Advanced codec selection
- Performance monitoring and stats
- Hardware acceleration detection

## Quick Start

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

## Browser Support

- Chrome 94+ (WebCodecs support required)
- Edge 94+
- Other Chromium-based browsers with WebCodecs

## Architecture

- **@beings/core**: Framework-agnostic recording engine
- **SlowTrackRecorder**: Main recording class with event system
- **Worker-based Processing**: Offloaded encoding for better performance
- **Automatic Codec Detection**: Intelligent fallback chain

## Development

```bash
cd packages/@beings/core
npm install
npm test
npm run dev  # Start development server
```

## License

MIT License - See LICENSE file for details.
