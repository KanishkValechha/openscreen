import { useState, useRef, useEffect } from "react";
import { fixWebmDuration } from "@fix-webm-duration/fix";

type UseScreenRecorderReturn = {
  recording: boolean;
  toggleRecording: () => void;
};

export function useScreenRecorder(): UseScreenRecorderReturn {
  const [recording, setRecording] = useState(false);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startTime = useRef<number>(0);
  const audioPreferences = useRef<{ screenAudio: boolean; micEnabled: boolean; micDeviceId: string }>({
    screenAudio: false,
    micEnabled: false,
    micDeviceId: ""
  });

  // Target visually lossless 4K @ 60fps; fall back gracefully when hardware cannot keep up
  const TARGET_FRAME_RATE = 60;
  const TARGET_WIDTH = 3840;
  const TARGET_HEIGHT = 2160;
  const FOUR_K_PIXELS = TARGET_WIDTH * TARGET_HEIGHT;
  const selectMimeType = () => {
    const preferred = [
      "video/webm;codecs=av1",
      "video/webm;codecs=h264",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm"
    ];

    return preferred.find(type => MediaRecorder.isTypeSupported(type)) ?? "video/webm";
  };

  const computeBitrate = (width: number, height: number) => {
    const pixels = width * height;
    const highFrameRateBoost = TARGET_FRAME_RATE >= 60 ? 1.7 : 1;

    if (pixels >= FOUR_K_PIXELS) {
      return Math.round(45_000_000 * highFrameRateBoost);
    }

    if (pixels >= 2560 * 1440) {
      return Math.round(28_000_000 * highFrameRateBoost);
    }

    return Math.round(18_000_000 * highFrameRateBoost);
  };

  const stopRecording = useRef(() => {
    if (mediaRecorder.current?.state === "recording") {
      if (stream.current) {
        stream.current.getTracks().forEach(track => track.stop());
      }
      mediaRecorder.current.stop();
      setRecording(false);

      window.electronAPI?.setRecordingState(false);
    }
  });

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    
    if (window.electronAPI?.onStopRecordingFromTray) {
      cleanup = window.electronAPI.onStopRecordingFromTray(() => {
        stopRecording.current();
      });
    }

    return () => {
      if (cleanup) cleanup();
      
      if (mediaRecorder.current?.state === "recording") {
        mediaRecorder.current.stop();
      }
      if (stream.current) {
        stream.current.getTracks().forEach(track => track.stop());
        stream.current = null;
      }
    };
  }, []);

  const startRecording = async () => {
    try {
      const selectedSource = await window.electronAPI.getSelectedSource();
      if (!selectedSource) {
        alert("Please select a source to record");
        return;
      }

      const audioPrefs = await window.electronAPI.getAudioPreferences();
      console.log('[useScreenRecorder] Audio prefs:', audioPrefs);

      // Build combined constraints for video + system audio
      const constraints: any = {
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: selectedSource.id,
            maxWidth: TARGET_WIDTH,
            maxHeight: TARGET_HEIGHT,
            maxFrameRate: TARGET_FRAME_RATE,
            minFrameRate: 30,
          },
        },
      };

      // Add system audio to the same request if enabled
      if (audioPrefs.screenAudio) {
        constraints.audio = {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: selectedSource.id,
          },
        };
      }

      console.log('[useScreenRecorder] Getting screen with audio');
      let mediaStream = await (navigator.mediaDevices as any).getUserMedia(constraints);

      // Log initial tracks
      console.log('[useScreenRecorder] Initial stream tracks:');
      mediaStream.getTracks().forEach((track: MediaStreamTrack, i: number) => {
        console.log(`  Track ${i}: ${track.kind} - "${track.label}"`);
      });

      // Add mic separately if enabled
      if (audioPrefs.micEnabled) {
        try {
          const micConstraints: MediaStreamConstraints = audioPrefs.micDeviceId ? 
            { audio: { deviceId: { exact: audioPrefs.micDeviceId } } } : 
            { audio: true };
          
          console.log('[useScreenRecorder] Getting mic audio');
          const micStream = await navigator.mediaDevices.getUserMedia(micConstraints);
          micStream.getAudioTracks().forEach((track: MediaStreamTrack) => {
            console.log('[useScreenRecorder] Adding mic track:', track.label, track.getSettings());
            mediaStream.addTrack(track);
          });
        } catch (micError) {
          console.error('[useScreenRecorder] Failed to add microphone:', micError);
        }
      }

      // Log final stream - all tracks
      console.log('[useScreenRecorder] Final stream tracks:');
      const audioTracks = mediaStream.getAudioTracks();
      console.log(`  Total audio tracks: ${audioTracks.length}`);
      mediaStream.getTracks().forEach((track: MediaStreamTrack, i: number) => {
        const settings = track.getSettings();
        console.log(`  Track ${i}: ${track.kind} - "${track.label}" (enabled: ${track.enabled}, settings: ${JSON.stringify(settings)})`);
      });

      // Get video track and apply constraints first
      stream.current = mediaStream;
      if (!stream.current) {
        throw new Error("Media stream is not available.");
      }
      const videoTrack = stream.current.getVideoTracks()[0];
      try {
        await videoTrack.applyConstraints({
          frameRate: { ideal: TARGET_FRAME_RATE, max: TARGET_FRAME_RATE },
          width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
          height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
        });
      } catch (error) {
        console.warn("Unable to lock 4K/60fps constraints, using best available track settings.", error);
      }

      // If we have both system audio and mic, we need to mix them using Web Audio API
      // because MediaRecorder often only captures the first audio track
      let recordingStream = mediaStream;
      
      if (audioPrefs.screenAudio && audioPrefs.micEnabled && audioTracks.length >= 2) {
        console.log('[useScreenRecorder] Mixing audio tracks using Web Audio API');
        try {
          const audioContext = new AudioContext();
          const destination = audioContext.createMediaStreamDestination();
          
          // Connect all audio tracks to the destination
          for (const track of audioTracks) {
            const source = audioContext.createMediaStreamSource(new MediaStream([track]));
            source.connect(destination);
          }
          
          // Create new stream with video + mixed audio
          recordingStream = new MediaStream([videoTrack, ...destination.stream.getAudioTracks()]);
          
          console.log('[useScreenRecorder] Mixed audio stream tracks:', recordingStream.getAudioTracks().length);
        } catch (mixError) {
          console.error('[useScreenRecorder] Failed to mix audio:', mixError);
          recordingStream = mediaStream;
        }
      }

      let { width = 1920, height = 1080, frameRate = TARGET_FRAME_RATE } = videoTrack.getSettings();
      
      // Ensure dimensions are divisible by 2 for VP9/AV1 codec compatibility
      width = Math.floor(width / 2) * 2;
      height = Math.floor(height / 2) * 2;
      
      const videoBitsPerSecond = computeBitrate(width, height);
      const mimeType = selectMimeType();

      console.log(
        `Recording at ${width}x${height} @ ${frameRate ?? TARGET_FRAME_RATE}fps using ${mimeType} / ${Math.round(
          videoBitsPerSecond / 1_000_000
        )} Mbps`
      );
      
      // Use the recordingStream (which may have mixed audio)
      stream.current = recordingStream;
      
      chunks.current = [];
      const recorder = new MediaRecorder(recordingStream, {
        mimeType,
        videoBitsPerSecond,
      });
      mediaRecorder.current = recorder;
      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) chunks.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.current = null;
        if (chunks.current.length === 0) return;
        const duration = Date.now() - startTime.current;
        const recordedChunks = chunks.current;
        const buggyBlob = new Blob(recordedChunks, { type: mimeType });
        // Clear chunks early to free memory immediately after blob creation
        chunks.current = [];
        const timestamp = Date.now();
        const videoFileName = `recording-${timestamp}.webm`;

        try {
          const videoBlob = await fixWebmDuration(buggyBlob, duration);
          const arrayBuffer = await videoBlob.arrayBuffer();
          const videoResult = await window.electronAPI.storeRecordedVideo(arrayBuffer, videoFileName);
          if (!videoResult.success) {
            console.error('Failed to store video:', videoResult.message);
            return;
          }

          if (videoResult.path) {
            await window.electronAPI.setCurrentVideoPath(videoResult.path);
          }

          await window.electronAPI.switchToEditor();
        } catch (error) {
          console.error('Error saving recording:', error);
        }
      };
      recorder.onerror = () => setRecording(false);
      recorder.start(1000);
      startTime.current = Date.now();
      setRecording(true);
      window.electronAPI?.setRecordingState(true);
    } catch (error) {
      console.error('Failed to start recording:', error);
      setRecording(false);
      if (stream.current) {
        stream.current.getTracks().forEach(track => track.stop());
        stream.current = null;
      }
    }
  };

  const toggleRecording = () => {
    recording ? stopRecording.current() : startRecording();
  };

  return { recording, toggleRecording };
}
