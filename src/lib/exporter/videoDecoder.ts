export interface DecodedVideoInfo {
  width: number;
  height: number;
  duration: number; // in seconds
  frameRate: number;
  codec: string;
  hasAudio?: boolean;
}

export class VideoFileDecoder {
  private info: DecodedVideoInfo | null = null;
  private videoElement: HTMLVideoElement | null = null;

  async loadVideo(videoUrl: string): Promise<DecodedVideoInfo> {
    this.videoElement = document.createElement('video');
    this.videoElement.src = videoUrl;
    this.videoElement.preload = 'metadata';

    return new Promise((resolve, reject) => {
      this.videoElement!.addEventListener('loadedmetadata', async () => {
        const video = this.videoElement!;
        
        // Check if video has audio
        let hasAudio = false;
        try {
          // Try multiple methods to detect audio
          hasAudio = (video as any).mozHasAudio || 
                     (video as any).webkitAudioDecodedByteCount > 0 ||
                     (video as any).audioTracks?.length > 0;
        } catch (e) {
          // If detection fails, assume no audio
          hasAudio = false;
        }

        this.info = {
          width: video.videoWidth,
          height: video.videoHeight,
          duration: video.duration,
          frameRate: 60,
          codec: 'avc1.640033',
          hasAudio,
        };

        resolve(this.info);
      });

      this.videoElement!.addEventListener('error', (e) => {
        reject(new Error(`Failed to load video: ${e}`));
      });
    });
  }

  /**
   * Get video element for seeking
   */
  getVideoElement(): HTMLVideoElement | null {
    return this.videoElement;
  }

  getInfo(): DecodedVideoInfo | null {
    return this.info;
  }

  destroy(): void {
    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.src = '';
      this.videoElement = null;
    }
  }
}
