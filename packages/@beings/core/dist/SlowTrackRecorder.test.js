import { describe, test, expect, vi, beforeEach } from 'vitest';
import { SlowTrackRecorder } from './SlowTrackRecorder';
// Mock browser APIs
const mockWorker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
};
const mockVideoStreamTrack = {
    kind: 'video',
    id: 'mock-video-track',
    label: 'Mock Video Track',
    enabled: true,
    muted: false,
    readyState: 'live',
    getSettings: vi.fn(() => ({ width: 1920, height: 1080, frameRate: 30 })),
    stop: vi.fn(),
    clone: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
};
const mockAudioStreamTrack = {
    kind: 'audio',
    id: 'mock-audio-track',
    label: 'Mock Audio Track',
    enabled: true,
    muted: false,
    readyState: 'live',
    getSettings: vi.fn(() => ({ sampleRate: 48000, channelCount: 2 })),
    stop: vi.fn(),
    clone: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
};
// Mock VideoFrame for testing
const createMockVideoFrame = (timestamp = 0) => ({
    timestamp,
    duration: 33333, // ~30fps
    displayWidth: 1920,
    displayHeight: 1080,
    close: vi.fn(),
    clone: vi.fn(),
    copyTo: vi.fn(),
    allocationSize: vi.fn(() => 1920 * 1080 * 4),
});
// Mock ReadableStreamDefaultReader for video frame simulation
const createMockReader = () => {
    let frameCount = 0;
    const maxFrames = 4; // Simulate 4 frames for testing
    return {
        read: vi.fn().mockImplementation(() => {
            if (frameCount < maxFrames) {
                const frame = createMockVideoFrame(frameCount * 33333);
                frameCount++;
                return Promise.resolve({ done: false, value: frame });
            }
            else {
                return Promise.resolve({ done: true, value: undefined });
            }
        }),
        cancel: vi.fn().mockResolvedValue(undefined),
        closed: Promise.resolve(undefined),
        releaseLock: vi.fn(),
    };
};
const mockReadableStream = {
    getReader: vi.fn(() => createMockReader()),
    cancel: vi.fn(),
    locked: false,
    pipeTo: vi.fn(),
    pipeThrough: vi.fn(),
    tee: vi.fn(),
};
const mockMediaStream = {
    id: 'mock-stream',
    active: true,
    getVideoTracks: vi.fn(() => [mockVideoStreamTrack]),
    getAudioTracks: vi.fn(() => []),
    getTracks: vi.fn(() => [mockVideoStreamTrack]),
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    clone: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
};
const mockMediaStreamWithAudio = {
    id: 'mock-stream-with-audio',
    active: true,
    getVideoTracks: vi.fn(() => [mockVideoStreamTrack]),
    getAudioTracks: vi.fn(() => [mockAudioStreamTrack]),
    getTracks: vi.fn(() => [mockVideoStreamTrack, mockAudioStreamTrack]),
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
    clone: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
};
// Mock global APIs
vi.stubGlobal('Worker', vi.fn(() => mockWorker));
vi.stubGlobal('MediaStreamTrackProcessor', vi.fn(() => ({
    readable: mockReadableStream
})));
vi.stubGlobal('AudioEncoder', vi.fn(() => ({})));
vi.stubGlobal('VideoEncoder', vi.fn(() => ({})));
describe('SlowTrackRecorder', () => {
    let recorder;
    beforeEach(() => {
        // Reset all mocks before each test
        vi.clearAllMocks();
        // Reset worker mock state
        mockWorker.postMessage = vi.fn();
        mockWorker.terminate = vi.fn();
        mockWorker.onmessage = null;
        // Reset stream mock state
        mockReadableStream.getReader = vi.fn(() => createMockReader());
        // Ensure global mocks are properly set up
        vi.stubGlobal('Worker', vi.fn(() => mockWorker));
        vi.stubGlobal('MediaStreamTrackProcessor', vi.fn(() => ({
            readable: mockReadableStream
        })));
        vi.stubGlobal('AudioEncoder', vi.fn(() => ({})));
        vi.stubGlobal('VideoEncoder', vi.fn(() => ({})));
        // Create recorder instance with test configuration
        recorder = new SlowTrackRecorder({
            width: 1920,
            height: 1080,
            frameRate: 30,
            bitrate: 2000000,
            codec: 'vp8'
        });
    });
    test('start() should successfully initialize and receive a "ready" message from the worker', async () => {
        // Arrange: Set up promise to track worker communication
        const workerReadyPromise = new Promise((resolve) => {
            // Mock the worker to simulate receiving a message and responding
            const originalPostMessage = mockWorker.postMessage;
            mockWorker.postMessage = vi.fn((message, transferable) => {
                // Call the original mock to track the call
                originalPostMessage(message, transferable);
                // Simulate the worker responding with 'ready' message
                setTimeout(() => {
                    if (mockWorker.onmessage) {
                        const responseEvent = {
                            data: { type: 'ready' }
                        };
                        mockWorker.onmessage(responseEvent);
                        resolve();
                    }
                }, 0);
            });
        });
        // Act: Start recording
        await recorder.start(mockMediaStream);
        // Assert: Verify the communication completed successfully
        await expect(workerReadyPromise).resolves.toBeUndefined();
        // Verify worker was created and received correct message
        expect(Worker).toHaveBeenCalledWith(expect.objectContaining({
            href: expect.stringContaining('recorder.worker.ts')
        }), { type: 'module' });
        expect(mockWorker.postMessage).toHaveBeenCalledWith({
            type: 'start',
            config: {
                width: 1920,
                height: 1080,
                frameRate: 30,
                bitrate: 2000000,
                codec: 'vp8'
            },
            stream: mockReadableStream
        }, [mockReadableStream]);
        // Verify MediaStreamTrackProcessor was created with the video track
        expect(globalThis.MediaStreamTrackProcessor).toHaveBeenCalledWith({
            track: mockVideoStreamTrack
        });
    });
    test('start() and stop() should produce a valid video Blob', async () => {
        // Arrange: Simple direct approach with promise tracking
        let workerInstance = null;
        // Mock Worker constructor to capture the instance
        vi.stubGlobal('Worker', vi.fn((url, options) => {
            workerInstance = {
                postMessage: vi.fn(),
                terminate: vi.fn(),
                onmessage: null,
            };
            // Set up immediate responses for testing
            workerInstance.postMessage = vi.fn((message) => {
                if (message.type === 'start') {
                    // Immediately respond with ready
                    setTimeout(() => {
                        if (workerInstance.onmessage) {
                            workerInstance.onmessage({ data: { type: 'ready' } });
                        }
                    }, 0);
                }
                else if (message.type === 'stop') {
                    // Immediately respond with file
                    setTimeout(() => {
                        if (workerInstance.onmessage) {
                            const blob = new Blob(['test video data'], { type: 'video/mp4' });
                            workerInstance.onmessage({ data: { type: 'file', blob } });
                        }
                    }, 0);
                }
            });
            return workerInstance;
        }));
        // Create recorder and test the full lifecycle
        const testRecorder = new SlowTrackRecorder({
            width: 1920,
            height: 1080,
            frameRate: 30,
            bitrate: 2000000,
        });
        // Act: Start and immediately stop
        await testRecorder.start(mockMediaStream);
        const blob = await testRecorder.stop();
        // Assert: Verify we got a valid blob
        expect(blob).toBeInstanceOf(Blob);
        expect(blob.size).toBeGreaterThan(0);
        expect(blob.type).toBe('video/mp4');
    });
    test('isSupported() should check for both video and audio support', () => {
        // Test with both video and audio support
        expect(SlowTrackRecorder.isSupported()).toBe(true);
        // Test without AudioEncoder (should still return true)
        vi.stubGlobal('AudioEncoder', undefined);
        expect(SlowTrackRecorder.isSupported()).toBe(true);
        // Test without VideoEncoder (should return false)
        vi.stubGlobal('VideoEncoder', undefined);
        expect(SlowTrackRecorder.isSupported()).toBe(false);
        // Restore mocks
        vi.stubGlobal('AudioEncoder', vi.fn(() => ({})));
        vi.stubGlobal('VideoEncoder', vi.fn(() => ({})));
    });
    test('should handle audio configuration validation', () => {
        // Test with valid audio config
        const recorderWithAudio = new SlowTrackRecorder({
            width: 1920,
            height: 1080,
            frameRate: 30,
            bitrate: 2000000,
            audio: {
                enabled: true,
                codec: 'opus',
                sampleRate: 48000,
                numberOfChannels: 2,
                bitrate: 128000
            }
        });
        expect(recorderWithAudio).toBeInstanceOf(SlowTrackRecorder);
        // Test with invalid bitrate (should be corrected)
        const recorderWithInvalidBitrate = new SlowTrackRecorder({
            width: 1920,
            height: 1080,
            frameRate: 30,
            bitrate: 2000000,
            audio: {
                enabled: true,
                codec: 'opus',
                sampleRate: 48000,
                numberOfChannels: 2,
                bitrate: 1000000 // Too high, should be corrected
            }
        });
        expect(recorderWithInvalidBitrate).toBeInstanceOf(SlowTrackRecorder);
    });
    test('start() should handle streams with both video and audio tracks', async () => {
        // Arrange: Set up recorder with audio config
        const recorderWithAudio = new SlowTrackRecorder({
            width: 1920,
            height: 1080,
            frameRate: 30,
            bitrate: 2000000,
            audio: {
                enabled: true,
                codec: 'opus',
                sampleRate: 48000,
                numberOfChannels: 2,
                bitrate: 128000
            }
        });
        // Set up worker mock to respond immediately
        const originalPostMessage = mockWorker.postMessage;
        mockWorker.postMessage = vi.fn((message, transferable) => {
            // Call original to track the call
            originalPostMessage(message, transferable);
            // Respond immediately with ready message
            if (message.type === 'start') {
                setTimeout(() => {
                    if (mockWorker.onmessage) {
                        const responseEvent = {
                            data: { type: 'ready' }
                        };
                        mockWorker.onmessage(responseEvent);
                    }
                }, 0);
            }
        });
        // Act: Start recording with audio stream
        await recorderWithAudio.start(mockMediaStreamWithAudio);
        // Assert: Verify worker received message with both streams
        expect(mockWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'start',
            stream: mockReadableStream,
            audioStream: mockReadableStream
        }), expect.arrayContaining([mockReadableStream, mockReadableStream]));
    });
    test('start() should gracefully handle missing audio tracks when audio enabled', async () => {
        // Arrange: Recorder with audio enabled but stream without audio
        const recorderWithAudio = new SlowTrackRecorder({
            width: 1920,
            height: 1080,
            frameRate: 30,
            bitrate: 2000000,
            audio: {
                enabled: true,
                codec: 'opus',
                sampleRate: 48000,
                numberOfChannels: 2,
                bitrate: 128000
            }
        });
        // Set up worker mock to respond immediately
        const originalPostMessage = mockWorker.postMessage;
        mockWorker.postMessage = vi.fn((message, transferable) => {
            // Call original to track the call
            originalPostMessage(message, transferable);
            // Respond immediately with ready message
            if (message.type === 'start') {
                setTimeout(() => {
                    if (mockWorker.onmessage) {
                        const responseEvent = {
                            data: { type: 'ready' }
                        };
                        mockWorker.onmessage(responseEvent);
                    }
                }, 0);
            }
        });
        // Act: Start recording with video-only stream
        await recorderWithAudio.start(mockMediaStream);
        // Assert: Verify worker received message with only video stream
        expect(mockWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'start',
            stream: mockReadableStream,
            audioStream: undefined
        }), [mockReadableStream]);
    });
});
//# sourceMappingURL=SlowTrackRecorder.test.js.map