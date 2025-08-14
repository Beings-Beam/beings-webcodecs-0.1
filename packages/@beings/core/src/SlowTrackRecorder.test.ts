import { describe, test, expect, vi, beforeEach } from 'vitest';
import { SlowTrackRecorder } from './SlowTrackRecorder';
import type { RecorderWorkerResponse } from './types';

// Mock browser APIs
const mockWorker = {
  postMessage: vi.fn(),
  terminate: vi.fn(),
  onmessage: null as ((event: MessageEvent<RecorderWorkerResponse>) => void) | null,
};

const mockMediaStreamTrack = {
  kind: 'video',
  id: 'mock-video-track',
  label: 'Mock Video Track',
  enabled: true,
  muted: false,
  readyState: 'live' as MediaStreamTrackState,
  getSettings: vi.fn(() => ({ width: 1920, height: 1080, frameRate: 30 })),
  stop: vi.fn(),
  clone: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
};

// Mock VideoFrame for testing
const createMockVideoFrame = (timestamp: number = 0) => ({
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
      } else {
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
  getVideoTracks: vi.fn(() => [mockMediaStreamTrack]),
  getAudioTracks: vi.fn(() => []),
  getTracks: vi.fn(() => [mockMediaStreamTrack]),
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

describe('SlowTrackRecorder', () => {
  let recorder: SlowTrackRecorder;

  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
    
    // Reset worker mock state
    mockWorker.postMessage = vi.fn();
    mockWorker.terminate = vi.fn();
    mockWorker.onmessage = null;
    
    // Reset stream mock state
    mockReadableStream.getReader = vi.fn(() => createMockReader());
    
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
    const workerReadyPromise = new Promise<void>((resolve) => {
      // Mock the worker to simulate receiving a message and responding
      const originalPostMessage = mockWorker.postMessage;
      mockWorker.postMessage = vi.fn((message, transferable) => {
        // Call the original mock to track the call
        originalPostMessage(message, transferable);
        
        // Simulate the worker responding with 'ready' message
        setTimeout(() => {
          if (mockWorker.onmessage) {
            const responseEvent = {
              data: { type: 'ready' } as RecorderWorkerResponse
            } as MessageEvent<RecorderWorkerResponse>;
            mockWorker.onmessage(responseEvent);
            resolve();
          }
        }, 0);
      });
    });

    // Act: Start recording
    await recorder.start(mockMediaStream as unknown as MediaStream);

    // Assert: Verify the communication completed successfully
    await expect(workerReadyPromise).resolves.toBeUndefined();

    // Verify worker was created and received correct message
    expect(Worker).toHaveBeenCalledWith(
      expect.objectContaining({
        href: expect.stringContaining('recorder.worker.ts')
      }),
      { type: 'module' }
    );

    expect(mockWorker.postMessage).toHaveBeenCalledWith(
      {
        type: 'start',
        config: {
          width: 1920,
          height: 1080,
          frameRate: 30,
          bitrate: 2000000,
          codec: 'vp8'
        },
        stream: mockReadableStream
      },
      [mockReadableStream]
    );

    // Verify MediaStreamTrackProcessor was created with the video track
    expect((globalThis as any).MediaStreamTrackProcessor).toHaveBeenCalledWith({
      track: mockMediaStreamTrack
    });
  });

  test('start() and stop() should produce a valid video Blob', async () => {
    // Arrange: Simple direct approach with promise tracking
    let workerInstance: any = null;
    
    // Mock Worker constructor to capture the instance
    vi.stubGlobal('Worker', vi.fn((url, options) => {
      workerInstance = {
        postMessage: vi.fn(),
        terminate: vi.fn(),
        onmessage: null,
      };
      
      // Set up immediate responses for testing
      workerInstance.postMessage = vi.fn((message: any) => {
        if (message.type === 'start') {
          // Immediately respond with ready
          setTimeout(() => {
            if (workerInstance.onmessage) {
              workerInstance.onmessage({ data: { type: 'ready' } });
            }
          }, 0);
        } else if (message.type === 'stop') {
          // Immediately respond with file
          setTimeout(() => {
            if (workerInstance.onmessage) {
              const buffer = new ArrayBuffer(123);
              workerInstance.onmessage({ data: { type: 'file', buffer } });
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
    await testRecorder.start(mockMediaStream as unknown as MediaStream);
    const blob = await testRecorder.stop();

    // Assert: Verify we got a valid blob
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe('video/mp4');
  });
});
