export interface WebMAudioPacket {
  data: Uint8Array;
  timestamp: number;
  duration: number;
  isKeyframe: boolean;
}

export interface WebMTrackInfo {
  trackNumber: number;
  codec: string;
  sampleRate: number;
  channels: number;
  codecPrivate?: Uint8Array;
}

export interface WebMDemuxResult {
  audioTrack: WebMTrackInfo;
  audioPackets: WebMAudioPacket[];
}

class EBMLParser {
  public data: Uint8Array;
  public offset: number = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  readVarInt(): { value: number; size: number } | null {
    if (this.offset >= this.data.length) return null;
    
    const firstByte = this.data[this.offset];
    let size = 0;
    let value = 0;

    if ((firstByte & 0x80) !== 0) {
      size = 1;
      value = firstByte & 0x7f;
    } else if ((firstByte & 0x40) !== 0) {
      size = 2;
      value = firstByte & 0x3f;
    } else if ((firstByte & 0x20) !== 0) {
      size = 3;
      value = firstByte & 0x1f;
    } else if ((firstByte & 0x10) !== 0) {
      size = 4;
      value = firstByte & 0x0f;
    } else if ((firstByte & 0x08) !== 0) {
      size = 5;
      value = firstByte & 0x07;
    } else if ((firstByte & 0x04) !== 0) {
      size = 6;
      value = firstByte & 0x03;
    } else if ((firstByte & 0x02) !== 0) {
      size = 7;
      value = firstByte & 0x01;
    } else {
      size = 8;
      value = 0;
    }

    for (let i = 1; i < size; i++) {
      value = (value << 8) | this.data[this.offset + i];
    }

    this.offset += size;
    return { value, size };
  }

  readUInt32(): number {
    const value = 
      (this.data[this.offset] << 24) |
      (this.data[this.offset + 1] << 16) |
      (this.data[this.offset + 2] << 8) |
      this.data[this.offset + 3];
    this.offset += 4;
    return value >>> 0;
  }

  readElementId(): number {
    let id = 0;
    const firstByte = this.data[this.offset];
    if ((firstByte & 0x80) !== 0) {
      id = firstByte;
      this.offset += 1;
    } else if ((firstByte & 0x40) !== 0) {
      id = firstByte | (this.data[this.offset + 1] << 8);
      this.offset += 2;
    } else if ((firstByte & 0x20) !== 0) {
      id = firstByte | (this.data[this.offset + 1] << 8) | (this.data[this.offset + 2] << 16);
      this.offset += 3;
    } else {
      id = firstByte | (this.data[this.offset + 1] << 8) | (this.data[this.offset + 2] << 16) | (this.data[this.offset + 3] << 24);
      this.offset += 4;
    }
    return id;
  }

  readElementSize(): { size: number; unknownSize: boolean } {
    const firstByte = this.data[this.offset];
    let sizeBytes = 0;
    let size = 0;

    if ((firstByte & 0x80) !== 0) {
      sizeBytes = 1;
      size = firstByte & 0x7f;
    } else if ((firstByte & 0x40) !== 0) {
      sizeBytes = 2;
      size = firstByte & 0x3f;
    } else if ((firstByte & 0x20) !== 0) {
      sizeBytes = 3;
      size = firstByte & 0x1f;
    } else if ((firstByte & 0x10) !== 0) {
      sizeBytes = 4;
      size = firstByte & 0x0f;
    } else if ((firstByte & 0x08) !== 0) {
      sizeBytes = 5;
      size = firstByte & 0x07;
    } else if ((firstByte & 0x04) !== 0) {
      sizeBytes = 6;
      size = firstByte & 0x03;
    } else if ((firstByte & 0x02) !== 0) {
      sizeBytes = 7;
      size = firstByte & 0x01;
    } else if ((firstByte & 0x01) !== 0) {
      sizeBytes = 8;
      size = 0;
    } else {
      return { size: 0, unknownSize: true };
    }

    for (let i = 1; i < sizeBytes; i++) {
      size = (size << 8) | this.data[this.offset + i];
    }
    this.offset += sizeBytes;

    return { size, unknownSize: false };
  }

  peekElement(): { id: number; size: number; unknownSize: boolean } | null {
    if (this.offset >= this.data.length - 4) return null;
    const savedOffset = this.offset;
    const id = this.readElementId();
    const { size, unknownSize } = this.readElementSize();
    this.offset = savedOffset;
    return { id, size, unknownSize };
  }

  skipElement(size: number): void {
    this.offset += size;
  }

  readBytes(size: number): Uint8Array {
    const bytes = this.data.slice(this.offset, this.offset + size);
    this.offset += size;
    return bytes;
  }

  get remaining(): number {
    return this.data.length - this.offset;
  }
}

const TRACKS_ID = 0x1654ae6b;
const TRACK_ENTRY_ID = 0xae;
const TRACK_NUMBER_ID = 0xd7;
const TRACK_TYPE_ID = 0x83;
const TRACK_CODEC_ID = 0x86;
const TRACK_AUDIO_ID = 0xe1;
const AUDIO_SAMPLING_FREQ_ID = 0xb5;
const AUDIO_CHANNELS_ID = 0x9f;
const TRACK_CODEC_PRIVATE_ID = 0x63a2;
const CLUSTER_ID = 0x1f43b675;
const SIMPLE_BLOCK_ID = 0xa3;
const BLOCK_GROUP_ID = 0xa0;
const BLOCK_ID = 0xa1;
const BLOCK_DURATION_ID = 0x9b;
const TIMECODE_ID = 0x2f7;

export async function demuxWebM(arrayBuffer: ArrayBuffer): Promise<WebMDemuxResult> {
  const data = new Uint8Array(arrayBuffer);
  const parser = new EBMLParser(data);

  let audioTrack: WebMTrackInfo | null = null;
  const audioPackets: WebMAudioPacket[] = [];

  const tracksOffset = findTracksOffset(parser);
  if (tracksOffset !== null) {
    parser.offset = tracksOffset;
    audioTrack = parseTrackEntries(parser);
  }

  if (!audioTrack) {
    throw new Error('No audio track found in WebM');
  }

  parser.offset = 0;
  findAndParseClusters(parser, audioTrack.trackNumber, audioPackets);

  return { audioTrack, audioPackets };
}

function findTracksOffset(parser: EBMLParser): number | null {
  while (parser.remaining > 8) {
    const element = parser.peekElement();
    if (!element) break;

    if (element.id === TRACKS_ID) {
      return parser.offset;
    }

    parser.readElementId();
    const { size } = parser.readElementSize();
    parser.skipElement(size);
  }
  return null;
}

function parseTrackEntries(parser: EBMLParser): WebMTrackInfo | null {
  while (parser.remaining > 8) {
    const element = parser.peekElement();
    if (!element) break;

    if (element.id !== TRACK_ENTRY_ID) {
      parser.readElementId();
      const { size } = parser.readElementSize();
      parser.skipElement(size);
      continue;
    }

    parser.readElementId();
    parser.readElementSize();

    let trackNumber = 0;
    let trackType = 0;
    let codec = '';
    let sampleRate = 48000;
    let channels = 2;
    let codecPrivate: Uint8Array | undefined;

    const trackEntryEnd = parser.offset + element.size;

    while (parser.offset < trackEntryEnd && parser.remaining > 4) {
      const innerElement = parser.peekElement();
      if (!innerElement) break;

      if (innerElement.id === TRACK_NUMBER_ID) {
        parser.readElementId();
        parser.readElementSize();
        const varint = parser.readVarInt();
        if (varint) trackNumber = varint.value;
      } else if (innerElement.id === TRACK_TYPE_ID) {
        parser.readElementId();
        parser.readElementSize();
        trackType = parser.readUInt32();
      } else if (innerElement.id === TRACK_CODEC_ID) {
        parser.readElementId();
        const { size } = parser.readElementSize();
        const codecBytes = parser.readBytes(size);
        codec = new TextDecoder().decode(codecBytes);
      } else if (innerElement.id === TRACK_AUDIO_ID) {
        parser.readElementId();
        const { size } = parser.readElementSize();
        const audioEnd = parser.offset + size;

        while (parser.offset < audioEnd && parser.remaining > 4) {
          const audioElement = parser.peekElement();
          if (!audioElement) break;

          if (audioElement.id === AUDIO_SAMPLING_FREQ_ID) {
            parser.readElementId();
            parser.readElementSize();
            const freqData = parser.readBytes(audioElement.size);
            const freqStr = new TextDecoder().decode(freqData);
            sampleRate = parseFloat(freqStr);
            if (isNaN(sampleRate)) sampleRate = 48000;
          } else if (audioElement.id === AUDIO_CHANNELS_ID) {
            parser.readElementId();
            parser.readElementSize();
            const channelsVarint = parser.readVarInt();
            if (channelsVarint) channels = channelsVarint.value;
          } else {
            parser.readElementId();
            const { size: sz } = parser.readElementSize();
            parser.skipElement(sz);
          }
        }
      } else if (innerElement.id === TRACK_CODEC_PRIVATE_ID) {
        parser.readElementId();
        const { size } = parser.readElementSize();
        codecPrivate = parser.readBytes(size);
      } else {
        parser.readElementId();
        const { size } = parser.readElementSize();
        parser.skipElement(size);
      }
    }

    if (trackType === 2 && (codec === 'A_OPUS' || codec === 'opus')) {
      return {
        trackNumber,
        codec: 'opus',
        sampleRate,
        channels,
        codecPrivate,
      };
    }
  }

  return null;
}

function findAndParseClusters(
  parser: EBMLParser,
  audioTrackNumber: number,
  audioPackets: WebMAudioPacket[]
): void {
  while (parser.remaining > 16) {
    const element = parser.peekElement();
    if (!element) break;

    if (element.id === CLUSTER_ID) {
      const clusterStart = parser.offset;
      parser.readElementId();
      const { size: clusterSize } = parser.readElementSize();

      let timecode = 0;
      const clusterEnd = clusterStart + 4 + (clusterSize < 0x1f ? 1 : Math.ceil(Math.log2(clusterSize + 1))) + clusterSize;

      while (parser.offset < clusterEnd && parser.remaining > 8) {
        const blockElement = parser.peekElement();
        if (!blockElement) break;

        if (blockElement.id === TIMECODE_ID) {
          parser.readElementId();
          parser.readElementSize();
          timecode = parser.readUInt32();
        } else if (blockElement.id === SIMPLE_BLOCK_ID) {
          const blockStart = parser.offset;
          parser.readElementId();
          const { size: blockSize } = parser.readElementSize();

          const trackNumberVarint = parser.readVarInt();
          if (!trackNumberVarint) {
            parser.skipElement(blockSize - (parser.offset - blockStart));
            continue;
          }

          const blockTrackNumber = trackNumberVarint.value;
          const timecodeOffset = (parser.data[parser.offset] << 8) | parser.data[parser.offset + 1];
          parser.offset += 2;

          const flags = parser.data[parser.offset];
          parser.offset += 1;

          const dataSize = blockSize - (parser.offset - blockStart);
          const blockData = parser.readBytes(dataSize);

          if (blockTrackNumber === audioTrackNumber) {
            const isKeyframe = (flags & 0x80) !== 0;
            const duration = 1000 / 48;

            audioPackets.push({
              data: blockData,
              timestamp: timecode + timecodeOffset,
              duration,
              isKeyframe,
            });
          }
        } else if (blockElement.id === BLOCK_GROUP_ID) {
          const groupStart = parser.offset;
          parser.readElementId();
          const { size: groupSize } = parser.readElementSize();

          let blockDuration = 0;
          let blockData: Uint8Array | null = null;
          let blockTrackNum = 0;
          let blockTimecode = 0;
          let isKeyframe = false;

          const groupEnd = groupStart + 4 + (groupSize < 0x1f ? 1 : Math.ceil(Math.log2(groupSize + 1))) + groupSize;

          while (parser.offset < groupEnd && parser.remaining > 8) {
            const groupElement = parser.peekElement();
            if (!groupElement) break;

            if (groupElement.id === BLOCK_DURATION_ID) {
              parser.readElementId();
              parser.readElementSize();
              const durationVarint = parser.readVarInt();
              if (durationVarint) blockDuration = durationVarint.value;
            } else if (groupElement.id === BLOCK_ID) {
              const blockStart = parser.offset;
              parser.readElementId();
              const { size: blockSize } = parser.readElementSize();

              const trackNumVarint = parser.readVarInt();
              if (trackNumVarint) blockTrackNum = trackNumVarint.value;

              const tc = (parser.data[parser.offset] << 8) | parser.data[parser.offset + 1];
              blockTimecode = tc;
              parser.offset += 2;

              const fl = parser.data[parser.offset];
              isKeyframe = (fl & 0x80) !== 0;
              parser.offset += 1;

              const dataLen = blockSize - (parser.offset - blockStart);
              blockData = parser.readBytes(dataLen);
            } else {
              parser.readElementId();
              const { size } = parser.readElementSize();
              parser.skipElement(size);
            }
          }

          if (blockData && blockTrackNum === audioTrackNumber) {
            audioPackets.push({
              data: blockData,
              timestamp: timecode + blockTimecode,
              duration: blockDuration / 1000000,
              isKeyframe,
            });
          }
        } else {
          parser.readElementId();
          const { size } = parser.readElementSize();
          parser.skipElement(size);
        }
      }
    } else {
      parser.readElementId();
      const { size } = parser.readElementSize();
      parser.skipElement(size);
    }
  }
}

export function createOpusDecoderConfig(
  trackInfo: WebMTrackInfo
): AudioDecoderConfig {
  const config: AudioDecoderConfig = {
    codec: 'opus',
    sampleRate: trackInfo.sampleRate,
    numberOfChannels: trackInfo.channels,
    description: trackInfo.codecPrivate || undefined,
  };

  return config;
}
