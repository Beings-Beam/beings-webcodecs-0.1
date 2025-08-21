# Beings WebCodecs Examples

This directory contains example implementations and test files for the Beings WebCodecs library.

## Files

### `manual-test.html`
A comprehensive test page for the SlowTrackRecorder functionality, featuring:

- **Real-time Screen Recording**: Live preview with audio support
- **Codec Testing**: Test all supported video and audio codecs
- **Performance Monitoring**: Real-time stats and diagnostics
- **Hardware Detection**: Automatic hardware acceleration detection
- **Resolution Options**: 4K, 1080p, 720p, and automatic scaling
- **Audio Configuration**: Channel detection, sample rate validation
- **Download Integration**: Automatic file saving with proper extensions

**Usage:**
```bash
# Serve the file locally
python -m http.server 3000
# Or use any static file server
# Then open http://localhost:3000/examples/manual-test.html
```

**Features Demonstrated:**
- Dual-worker architecture performance
- A/V synchronization validation
- Error handling and graceful degradation
- Real-time chunk collection monitoring
- Hardware acceleration utilization

## Development Notes

These examples are maintained for:
- Manual testing during development
- Demonstration of library capabilities  
- Performance validation and benchmarking
- Integration testing across different scenarios

For production usage, refer to the main documentation in the root README.md file.
