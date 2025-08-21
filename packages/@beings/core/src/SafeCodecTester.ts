/**
 * Safe Codec Configuration Tester
 * 
 * Provides the most widely supported, "safest" codec combination for baseline testing
 * as recommended in the "Perfect Architecture" debugging checklist.
 */

import type { SlowTrackRecorderConfig } from './SlowTrackRecorder';

/**
 * Get the safest, most widely supported codec configuration for baseline testing
 * 
 * This configuration is designed to work on virtually all systems that support WebCodecs:
 * - H.264 (avc1.42001f): Most widely supported video codec
 * - AAC (mp4a.40.2): Most widely supported audio codec
 * - Low resolution and bitrate to minimize performance issues
 * - Conservative frame rate
 */
export function getSafeBaselineConfig(): SlowTrackRecorderConfig {
  return {
    // Video: Conservative 640x480 resolution at 15fps
    width: 640,
    height: 480,
    frameRate: 15,
    bitrate: 500000, // 500 kbps - very conservative
    
    // Force specific H.264 codec (most compatible)
    codec: 'avc1.42001f', // H.264 Baseline Profile, Level 3.1
    codecSelection: 'h264',
    
    // Conservative keyframe interval
    keyframeIntervalSeconds: 2,
    
    // Prefer hardware but don't require it
    hardwareAcceleration: 'no-preference',
    
    // Audio: Conservative mono AAC
    audio: {
      enabled: true,
      codec: 'aac', // Force AAC (most compatible with H.264/MP4)
      sampleRate: 44100, // Standard CD quality
      numberOfChannels: 1, // Mono to avoid channel mismatch issues
      bitrate: 64000 // 64 kbps - very conservative
    }
  };
}

/**
 * Get an even more conservative video-only configuration
 * Use this if the baseline config with audio fails
 */
export function getVideoOnlyBaselineConfig(): SlowTrackRecorderConfig {
  const config = getSafeBaselineConfig();
  return {
    ...config,
    audio: {
      enabled: false,
      codec: 'aac',
      sampleRate: 44100,
      numberOfChannels: 1,
      bitrate: 64000
    }
  };
}

/**
 * Get a high-quality test configuration to identify performance bottlenecks
 * Use this after baseline works to find performance limits
 */
export function getHighQualityTestConfig(): SlowTrackRecorderConfig {
  return {
    width: 1920,
    height: 1080,
    frameRate: 30,
    bitrate: 2000000, // 2 Mbps
    codecSelection: 'auto', // Let system choose best codec
    keyframeIntervalSeconds: 2,
    hardwareAcceleration: 'prefer-hardware',
    audio: {
      enabled: true,
      codec: 'auto',
      sampleRate: 48000, // High quality
      numberOfChannels: 2, // Stereo
      bitrate: 128000 // 128 kbps
    }
  };
}

/**
 * Test configurations in order of safety/compatibility
 * Start with the most conservative and work up
 */
export const TEST_CONFIGURATIONS = [
  {
    name: 'Video-Only Baseline (Most Conservative)',
    config: getVideoOnlyBaselineConfig(),
    description: 'H.264 640x480@15fps, no audio - should work on all systems'
  },
  {
    name: 'Audio+Video Baseline (Conservative)', 
    config: getSafeBaselineConfig(),
    description: 'H.264 + AAC mono, low quality - tests basic A/V sync'
  },
  {
    name: 'High Quality Test (Performance)',
    config: getHighQualityTestConfig(), 
    description: 'Auto codec selection, 1080p@30fps + stereo - tests performance limits'
  }
] as const;

/**
 * Diagnostic function to test configurations in sequence
 * Returns the first configuration that works, or null if all fail
 */
export async function findWorkingConfiguration(
  testFunction: (config: SlowTrackRecorderConfig) => Promise<boolean>
): Promise<{ name: string; config: SlowTrackRecorderConfig } | null> {
  
  console.log('🧪 SafeCodecTester: Starting configuration compatibility test...');
  
  for (const testConfig of TEST_CONFIGURATIONS) {
    console.log(`🧪 Testing: ${testConfig.name}`);
    console.log(`   ${testConfig.description}`);
    
    try {
      const works = await testFunction(testConfig.config);
      if (works) {
        console.log(`✅ SUCCESS: ${testConfig.name} works!`);
        return {
          name: testConfig.name,
          config: testConfig.config
        };
      } else {
        console.log(`❌ FAILED: ${testConfig.name} did not work`);
      }
    } catch (error) {
      console.log(`❌ ERROR: ${testConfig.name} threw error:`, error);
    }
  }
  
  console.log('🚨 All test configurations failed - this indicates a fundamental system issue');
  return null;
}
