import type { ExportConfig, ExportProgress, ExportResult } from './types';
import { VideoFileDecoder } from './videoDecoder';
import { FrameRenderer } from './frameRenderer';
import { VideoMuxer } from './muxer';
import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } from 'mediabunny';
import type { ZoomRegion, CropRegion, TrimRegion, AnnotationRegion } from '@/components/video-editor/types';

interface VideoExporterConfig extends ExportConfig {
  videoUrl: string;
  wallpaper: string;
  zoomRegions: ZoomRegion[];
  trimRegions?: TrimRegion[];
  showShadow: boolean;
  shadowIntensity: number;
  showBlur: boolean;
  motionBlurEnabled?: boolean;
  borderRadius?: number;
  padding?: number;
  videoPadding?: number;
  cropRegion: CropRegion;
  annotationRegions?: AnnotationRegion[];
  previewWidth?: number;
  previewHeight?: number;
  onProgress?: (progress: ExportProgress) => void;
}

export class VideoExporter {
  private config: VideoExporterConfig;
  private decoder: VideoFileDecoder | null = null;
  private renderer: FrameRenderer | null = null;
  private encoder: VideoEncoder | null = null;
  private muxer: VideoMuxer | null = null;
  private cancelled = false;
  private encodeQueue = 0;
  private readonly MAX_ENCODE_QUEUE = 300;
  private videoDescription: Uint8Array | undefined;
  private videoColorSpace: VideoColorSpaceInit | undefined;
  private muxingPromises: Promise<void>[] = [];
  private chunkCount = 0;
  
  // Audio encoding
  private audioEncoder: AudioEncoder | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private hasAudio = false;
  private audioProcessingComplete = false;

  isAudioProcessingComplete(): boolean {
    return this.audioProcessingComplete;
  }

  constructor(config: VideoExporterConfig) {
    this.config = config;
  }

  // Calculate the total duration excluding trim regions (in seconds)
  private getEffectiveDuration(totalDuration: number): number {
    const trimRegions = this.config.trimRegions || [];
    const totalTrimDuration = trimRegions.reduce((sum, region) => {
      return sum + (region.endMs - region.startMs) / 1000;
    }, 0);
    return totalDuration - totalTrimDuration;
  }

  private mapEffectiveToSourceTime(effectiveTimeMs: number): number {
    const trimRegions = this.config.trimRegions || [];
    // Sort trim regions by start time
    const sortedTrims = [...trimRegions].sort((a, b) => a.startMs - b.startMs);

    let sourceTimeMs = effectiveTimeMs;

    for (const trim of sortedTrims) {
      // If the source time hasn't reached this trim region yet, we're done
      if (sourceTimeMs < trim.startMs) {
        break;
      }

      // Add the duration of this trim region to the source time
      const trimDuration = trim.endMs - trim.startMs;
      sourceTimeMs += trimDuration;
    }

    return sourceTimeMs;
  }

  async export(): Promise<ExportResult> {
    try {
      this.cleanup();
      this.cancelled = false;

      // Initialize decoder and load video
      this.decoder = new VideoFileDecoder();
      const videoInfo = await this.decoder.loadVideo(this.config.videoUrl);

      // Initialize frame renderer
      this.renderer = new FrameRenderer({
        width: this.config.width,
        height: this.config.height,
        wallpaper: this.config.wallpaper,
        zoomRegions: this.config.zoomRegions,
        showShadow: this.config.showShadow,
        shadowIntensity: this.config.shadowIntensity,
        showBlur: this.config.showBlur,
        motionBlurEnabled: this.config.motionBlurEnabled,
        borderRadius: this.config.borderRadius,
        padding: this.config.padding,
        cropRegion: this.config.cropRegion,
        videoWidth: videoInfo.width,
        videoHeight: videoInfo.height,
        annotationRegions: this.config.annotationRegions,
        previewWidth: this.config.previewWidth,
        previewHeight: this.config.previewHeight,
      });
      await this.renderer.initialize();

      // Initialize video encoder
      await this.initializeEncoder();

      // Initialize muxer - pass hasAudio from videoInfo
      this.hasAudio = videoInfo.hasAudio;
      this.muxer = new VideoMuxer(this.config, this.hasAudio);
      await this.muxer.initialize();

      // Get the video element for frame extraction
      const videoElement = this.decoder.getVideoElement();
      if (!videoElement) {
        throw new Error('Video element not available');
      }

      // Try to initialize audio - even if hasAudio is false, try demuxing as fallback
      // This handles cases where audio detection might fail
      const audioInitResult = await this.initializeAudioEncoderWithFallback();
      
      // Start audio processing promise - will run in parallel with video
      let audioProcessingPromise: Promise<void> | null = null;
      
      // Update hasAudio based on whether we successfully initialized audio
      if (audioInitResult && this.muxer) {
        this.hasAudio = true;
        // Re-initialize muxer with audio if it wasn't already
        this.muxer = new VideoMuxer(this.config, true);
        await this.muxer.initialize();
        
        // Demux and decode audio in parallel with video encoding
        audioProcessingPromise = this.processAudioDemuxDecode();
      }

      // Calculate effective duration and frame count (excluding trim regions)
      const effectiveDuration = this.getEffectiveDuration(videoInfo.duration);
      const totalFrames = Math.ceil(effectiveDuration * this.config.frameRate);
      
      console.log('[VideoExporter] Original duration:', videoInfo.duration, 's');
      console.log('[VideoExporter] Effective duration:', effectiveDuration, 's');
      console.log('[VideoExporter] Total frames to export:', totalFrames);

      // Optimized pipeline: seek, render, encode in parallel using workers
      const frameDuration = 1_000_000 / this.config.frameRate; // in microseconds
      let frameIndex = 0;
      const timeStep = 1 / this.config.frameRate;

      // Pipeline stages
      let currentSeekTime = 0;
      let isSeeking = false;

      // Process frames with overlapped I/O
      while (frameIndex < totalFrames && !this.cancelled) {
        const i = frameIndex;
        const timestamp = i * frameDuration;
        const effectiveTimeMs = (i * timeStep) * 1000;
        const sourceTimeMs = this.mapEffectiveToSourceTime(effectiveTimeMs);
        const videoTime = sourceTimeMs / 1000;

        // Start seeking to next frame while current frame is being encoded
        if (!isSeeking && currentSeekTime !== videoTime) {
          isSeeking = true;
          videoElement.currentTime = videoTime;
          currentSeekTime = videoTime;
        }

        // Wait for seek to complete and video to be ready
        if (isSeeking) {
          await new Promise<void>(resolve => {
            const onSeeked = () => {
              isSeeking = false;
              resolve();
            };
            videoElement.addEventListener('seeked', onSeeked, { once: true });
          });
          
          // Additional wait for video to be ready
          await new Promise(resolve => setTimeout(resolve, 10));
        }

        try {
          // Create a VideoFrame from the video element
          const videoFrame = new VideoFrame(videoElement, { timestamp });

          // Render the frame with all effects using source timestamp
          const sourceTimestamp = sourceTimeMs * 1000;
          await this.renderer!.renderFrame(videoFrame, sourceTimestamp);
          videoFrame.close();
        } catch (vfError) {
          console.error('[VideoExporter] VideoFrame creation error:', vfError);
          // Skip this frame if VideoFrame fails
          frameIndex++;
          continue;
        }

        const canvas = this.renderer!.getCanvas();

        // Create VideoFrame from raw pixel data (most reliable approach)
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Failed to get 2D context from canvas');
        }
        
        const width = canvas.width;
        const height = canvas.height;
        const imageData = ctx.getImageData(0, 0, width, height);
        
        // Create VideoFrame from RGBA data
        const data = new Uint8Array(imageData.data.buffer);
        const init: VideoFrameBufferInit = {
          format: 'RGBA',
          timestamp,
          duration: frameDuration,
          codedWidth: width,
          codedHeight: height,
          layout: [{ offset: 0, stride: width * 4 }]
        };
        
        let exportFrame: VideoFrame;
        try {
          exportFrame = new VideoFrame(data, init);
        } catch (frameError) {
          console.error('[VideoExporter] Export frame error:', frameError);
          frameIndex++;
          continue;
        }

        // Wait for encoder queue to have space
        while (this.encodeQueue >= this.MAX_ENCODE_QUEUE && !this.cancelled) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Encode the frame
        if (this.encoder && this.encoder.state === 'configured') {
          this.encodeQueue++;
          this.encoder.encode(exportFrame, { keyFrame: i % 150 === 0 });
        }

        exportFrame.close();
        frameIndex++;

        // Update progress
        if (this.config.onProgress) {
          this.config.onProgress({
            currentFrame: frameIndex,
            totalFrames,
            percentage: (frameIndex / totalFrames) * 100,
            estimatedTimeRemaining: 0,
          });
        }
      }

      if (this.cancelled) {
        return { success: false, error: 'Export cancelled' };
      }

      // Finalize encoding
      if (this.encoder && this.encoder.state === 'configured') {
        await this.encoder.flush();
      }

      // Wait for audio processing to complete if it's still running
      if (audioProcessingPromise) {
        await audioProcessingPromise;
      }

      // Finalize audio encoding
      if (this.audioEncoder) {
        await this.audioEncoder.flush();
      }
      this.audioProcessingComplete = true;

      // Wait for all muxing operations to complete
      await Promise.all(this.muxingPromises);

      // Finalize muxer and get output blob
      const blob = await this.muxer!.finalize();

      return { success: true, blob };
    } catch (error) {
      console.error('Export error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.cleanup();
    }
  }

  private async initializeEncoder(): Promise<void> {
    this.encodeQueue = 0;
    this.muxingPromises = [];
    this.chunkCount = 0;
    let videoDescription: Uint8Array | undefined;

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        // Capture decoder config metadata from encoder output
        if (meta?.decoderConfig?.description && !videoDescription) {
          const desc = meta.decoderConfig.description;
          videoDescription = new Uint8Array(desc instanceof ArrayBuffer ? desc : (desc as any));
          this.videoDescription = videoDescription;
        }
        // Capture colorSpace from encoder metadata if provided
        if (meta?.decoderConfig?.colorSpace && !this.videoColorSpace) {
          this.videoColorSpace = meta.decoderConfig.colorSpace;
        }

        // Stream chunk to muxer immediately (parallel processing)
        const isFirstChunk = this.chunkCount === 0;
        this.chunkCount++;

        const muxingPromise = (async () => {
          try {
            if (isFirstChunk && this.videoDescription) {
              // Add decoder config for the first chunk
              const colorSpace = this.videoColorSpace || {
                primaries: 'bt709',
                transfer: 'iec61966-2-1',
                matrix: 'rgb',
                fullRange: true,
              };

              const metadata: EncodedVideoChunkMetadata = {
                decoderConfig: {
                  codec: this.config.codec || 'avc1.640033',
                  codedWidth: this.config.width,
                  codedHeight: this.config.height,
                  description: this.videoDescription,
                  colorSpace,
                },
              };

              await this.muxer!.addVideoChunk(chunk, metadata);
            } else {
              await this.muxer!.addVideoChunk(chunk, meta);
            }
          } catch (error) {
            console.error('Muxing error:', error);
          }
        })();

        this.muxingPromises.push(muxingPromise);
        this.encodeQueue--;
      },
      error: (error) => {
        console.error('[VideoExporter] Encoder error:', error);
        // Stop export encoding failed
        this.cancelled = true;
      },
    });

    const codec = this.config.codec || 'avc1.640033';
    
    const encoderConfig: VideoEncoderConfig = {
      codec,
      width: this.config.width,
      height: this.config.height,
      bitrate: this.config.bitrate,
      framerate: this.config.frameRate,
      latencyMode: 'realtime',
      bitrateMode: 'variable',
      hardwareAcceleration: 'prefer-hardware',
    };

    // Check hardware support first
    const hardwareSupport = await VideoEncoder.isConfigSupported(encoderConfig);

    if (hardwareSupport.supported) {
      // Use hardware encoding
      console.log('[VideoExporter] Using hardware acceleration');
      this.encoder.configure(encoderConfig);
    } else {
      // Fall back to software encoding
      console.log('[VideoExporter] Hardware not supported, using software encoding');
      encoderConfig.hardwareAcceleration = 'prefer-software';
      
      const softwareSupport = await VideoEncoder.isConfigSupported(encoderConfig);
      if (!softwareSupport.supported) {
        throw new Error('Video encoding not supported on this system');
      }
      
      this.encoder.configure(encoderConfig);
    }
  }

  private async initializeAudioEncoderWithFallback(): Promise<boolean> {
    const SAMPLE_RATE = 48000;
    const CHANNELS = 2;

    this.audioEncoder = new AudioEncoder({
      output: async (chunk, meta) => {
        if (!this.muxer) return;
        try {
          await this.muxer.addAudioChunk(chunk, meta);
        } catch (e) {
          console.error('[VideoExporter] Audio muxing error:', e);
        }
      },
      error: (e) => console.error('[VideoExporter] Audio encoder error:', e),
    });

    const audioConfig: AudioEncoderConfig = {
      codec: 'mp4a.40.2',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: CHANNELS,
      bitrate: 128000,
    };

    const support = await AudioEncoder.isConfigSupported(audioConfig);
    if (!support.supported) {
      console.warn('[VideoExporter] AAC not supported, disabling audio');
      this.audioEncoder.close();
      this.audioEncoder = null;
      return false;
    }

    this.audioEncoder.configure(audioConfig);
    console.log('[VideoExporter] Audio encoder initialized for AAC');
    return true;
  }

  private async processAudioDemuxDecode(): Promise<void> {
    if (!this.audioEncoder || !this.muxer) return;

    try {
      console.log('[VideoExporter] Starting audio demuxing with mediabunny...');

      const response = await fetch(this.config.videoUrl);
      const arrayBuffer = await response.arrayBuffer();
      const blob = new Blob([arrayBuffer], { type: 'video/webm' });

      console.log('[VideoExporter] Loading WebM with mediabunny...');
      const input = new Input({
        formats: ALL_FORMATS,
        source: new BlobSource(blob)
      });

      const audioTrack = await input.getPrimaryAudioTrack();
      if (!audioTrack) {
        console.warn('[VideoExporter] No audio track found in WebM');
        this.hasAudio = false;
        return;
      }

      const audioInfo = await audioTrack.getDecoderConfig();
      if (!audioInfo) {
        console.warn('[VideoExporter] No audio decoder config found');
        this.hasAudio = false;
        return;
      }
      console.log('[VideoExporter] Audio track info:', audioInfo);

      const sink = new EncodedPacketSink(audioTrack);
      
      const opusSupport = await AudioDecoder.isConfigSupported({
        codec: 'opus',
        sampleRate: audioInfo.sampleRate,
        numberOfChannels: audioInfo.numberOfChannels,
        description: audioInfo.description
      });

      if (!opusSupport.supported) {
        console.warn('[VideoExporter] Opus decode not supported, disabling audio');
        this.hasAudio = false;
        return;
      }

      this.audioDecoder = new AudioDecoder({
        output: (audioData) => {
          if (this.audioEncoder && this.audioEncoder.state === 'configured') {
            this.audioEncoder.encode(audioData);
          }
          audioData.close();
        },
        error: (e) => console.error('[VideoExporter] Audio decoder error:', e),
      });

      await this.audioDecoder.configure({
        codec: 'opus',
        sampleRate: audioInfo.sampleRate,
        numberOfChannels: audioInfo.numberOfChannels,
        description: audioInfo.description
      });
      console.log('[VideoExporter] Audio decoder configured');

      let packetCount = 0;
      for await (const packet of sink.packets()) {
        if (this.cancelled) break;

        const chunk = new EncodedAudioChunk({
          type: 'delta',
          timestamp: packet.timestamp * 1000000,
          duration: packet.duration ? packet.duration * 1000000 : 0,
          data: packet.data
        });

        this.audioDecoder.decode(chunk);
        packetCount++;
      }

      console.log(`[VideoExporter] Decoded ${packetCount} audio packets, flushing...`);
      await this.audioDecoder.flush();
      
      this.audioProcessingComplete = true;
      console.log('[VideoExporter] Audio processing complete');
    } catch (e) {
      console.error('[VideoExporter] Audio demux/decode error:', e);
      this.hasAudio = false;
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.cleanup();
  }

  private cleanup(): void {
    if (this.encoder) {
      try {
        if (this.encoder.state === 'configured') {
          this.encoder.close();
        }
      } catch (e) {
        console.warn('Error closing encoder:', e);
      }
      this.encoder = null;
    }

    if (this.audioEncoder) {
      try {
        if (this.audioEncoder.state === 'configured') {
          this.audioEncoder.close();
        }
      } catch (e) {
        console.warn('Error closing audio encoder:', e);
      }
      this.audioEncoder = null;
    }

    if (this.audioDecoder) {
      try {
        if (this.audioDecoder.state === 'configured') {
          this.audioDecoder.close();
        }
      } catch (e) {
        console.warn('Error closing audio decoder:', e);
      }
      this.audioDecoder = null;
    }

    this.audioProcessingComplete = false;

    if (this.decoder) {
      try {
        this.decoder.destroy();
      } catch (e) {
        console.warn('Error destroying decoder:', e);
      }
      this.decoder = null;
    }

    if (this.renderer) {
      try {
        this.renderer.destroy();
      } catch (e) {
        console.warn('Error destroying renderer:', e);
      }
      this.renderer = null;
    }

    this.muxer = null;
    this.encodeQueue = 0;
    this.muxingPromises = [];
    this.chunkCount = 0;
    this.videoDescription = undefined;
    this.videoColorSpace = undefined;
  }
}
