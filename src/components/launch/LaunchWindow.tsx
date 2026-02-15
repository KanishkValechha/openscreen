import { useState, useEffect, useRef } from "react";
import styles from "./LaunchWindow.module.css";
import { useScreenRecorder } from "../../hooks/useScreenRecorder";
import { Button } from "../ui/button";
import { BsRecordCircle, BsFillSpeakerFill, BsFillVolumeMuteFill } from "react-icons/bs";
import { FaRegStopCircle } from "react-icons/fa";
import { MdMonitor } from "react-icons/md";
import { RxDragHandleDots2 } from "react-icons/rx";
import { FaFolderMinus } from "react-icons/fa6";
import { FiMinus, FiX } from "react-icons/fi";
import { ContentClamp } from "../ui/content-clamp";
import { BiMicrophone, BiMicrophoneOff } from "react-icons/bi";

export function LaunchWindow() {
  const { recording, toggleRecording } = useScreenRecorder();
  const [recordingStart, setRecordingStart] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [screenAudio, setScreenAudio] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string>("");
  const [micLevel, setMicLevel] = useState(0);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    if (recording) {
      if (!recordingStart) setRecordingStart(Date.now());
      timer = setInterval(() => {
        if (recordingStart) {
          setElapsed(Math.floor((Date.now() - recordingStart) / 1000));
        }
      }, 1000);
    } else {
      setRecordingStart(null);
      setElapsed(0);
      if (timer) clearInterval(timer);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [recording, recordingStart]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };
  const [selectedSource, setSelectedSource] = useState("Screen");
  const [hasSelectedSource, setHasSelectedSource] = useState(false);

  useEffect(() => {
    const checkSelectedSource = async () => {
      if (window.electronAPI) {
        const source = await window.electronAPI.getSelectedSource();
        if (source) {
          setSelectedSource(source.name);
          setHasSelectedSource(true);
        } else {
          setSelectedSource("Screen");
          setHasSelectedSource(false);
        }
      }
    };

    checkSelectedSource();
    
    const interval = setInterval(checkSelectedSource, 500);
    return () => clearInterval(interval);
  }, []);

  // Enumerate mic devices
  useEffect(() => {
    async function getMicDevices() {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput');
        setMicDevices(mics);
        if (mics.length > 0) {
          setSelectedMicId(mics[0].deviceId);
        }
      } catch (e) {
        console.warn('Failed to get mic devices:', e);
      }
    }
    getMicDevices();
  }, []);

  // Audio visualizer
  useEffect(() => {
    if (micEnabled && !recording) {
      startMicVisualizer();
    } else {
      stopMicVisualizer();
    }
    
    return () => stopMicVisualizer();
  }, [micEnabled, recording, selectedMicId]);

  async function startMicVisualizer() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true 
      });
      micStreamRef.current = stream;
      
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      
      source.connect(analyser);
      
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      
      function updateLevel() {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        setMicLevel(Math.min(100, average * 1.5));
        animationRef.current = requestAnimationFrame(updateLevel);
      }
      
      updateLevel();
    } catch (e) {
      console.warn('Failed to start mic visualizer:', e);
    }
  }

  function stopMicVisualizer() {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setMicLevel(0);
  }

  // Save audio preferences
  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.saveAudioPreferences({
        screenAudio,
        micEnabled,
        micDeviceId: selectedMicId
      });
    }
  }, [screenAudio, micEnabled, selectedMicId]);

  const openSourceSelector = () => {
    if (window.electronAPI) {
      window.electronAPI.openSourceSelector();
    }
  };

  const openVideoFile = async () => {
    const result = await window.electronAPI.openVideoFilePicker();
    if (result.cancelled) return;
    if (result.success && result.path) {
      await window.electronAPI.setCurrentVideoPath(result.path);
      await window.electronAPI.switchToEditor();
    }
  };

  const sendHudOverlayHide = () => {
    if (window.electronAPI?.hudOverlayHide) {
      window.electronAPI.hudOverlayHide();
    }
  };
  const sendHudOverlayClose = () => {
    if (window.electronAPI?.hudOverlayClose) {
      window.electronAPI.hudOverlayClose();
    }
  };

  return (
    <div className="w-full h-full flex items-center bg-transparent">
      <div
        className={`w-full max-w-[600px] mx-auto flex items-center justify-between px-3 py-2 ${styles.electronDrag}`}
        style={{
          borderRadius: 16,
          background: 'linear-gradient(135deg, rgba(30,30,40,0.92) 0%, rgba(20,20,30,0.85) 100%)',
          backdropFilter: 'blur(32px) saturate(180%)',
          WebkitBackdropFilter: 'blur(32px) saturate(180%)',
          boxShadow: '0 4px 24px 0 rgba(0,0,0,0.28), 0 1px 3px 0 rgba(0,0,0,0.14) inset',
          border: '1px solid rgba(80,80,120,0.22)',
          minHeight: 44,
        }}
      >
        <div className={`flex items-center gap-1 ${styles.electronDrag}`}> 
          <RxDragHandleDots2 size={18} className="text-white/40" /> 
        </div>

        <Button
          variant="link"
          size="sm"
          className={`gap-1 text-white bg-transparent hover:bg-transparent px-0 flex-1 text-left text-xs ${styles.electronNoDrag}`}
          onClick={openSourceSelector}
          disabled={recording}
        >
          <MdMonitor size={14} className="text-white" />
          <ContentClamp truncateLength={6}>{selectedSource}</ContentClamp>
        </Button>

        <div className="w-px h-6 bg-white/30" />

        <Button
          variant="link"
          size="icon"
          className={`${styles.electronNoDrag}`}
          onClick={() => setScreenAudio(!screenAudio)}
          disabled={recording}
          title={screenAudio ? "System Audio On" : "System Audio Off"}
        >
          {screenAudio ? (
            <BsFillSpeakerFill size={14} className="text-green-400" />
          ) : (
            <BsFillVolumeMuteFill size={14} className="text-white/50" />
          )}
        </Button>

        <Button
          variant="link"
          size="icon"
          className={`${styles.electronNoDrag}`}
          onClick={() => setMicEnabled(!micEnabled)}
          disabled={recording || micDevices.length === 0}
          title={micEnabled ? "Microphone On" : "Microphone Off"}
        >
          {micEnabled ? (
            <BiMicrophone size={14} className="text-green-400" />
          ) : (
            <BiMicrophoneOff size={14} className="text-white/50" />
          )}
        </Button>

        {micEnabled && !recording && (
          <div className="flex items-center gap-0.5 h-6">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="w-1 bg-green-400 rounded-full transition-all duration-75"
                style={{
                  height: `${Math.max(4, (micLevel / 100) * 20 * (i + 1) / 2)}px`,
                  opacity: micLevel > i * 15 ? 1 : 0.3
                }}
              />
            ))}
          </div>
        )}

        {/* Mic dropdown - cleaner UI with arrow */}
        <div className="relative">
          {micEnabled && micDevices.length > 0 && (
            <div className="flex items-center">
              <select
                value={selectedMicId}
                onChange={(e) => setSelectedMicId(e.target.value)}
                disabled={recording}
                className="appearance-none bg-zinc-800/80 text-xs text-zinc-200 border border-zinc-700 rounded-l px-2 py-1 pr-6 max-w-[120px] cursor-pointer hover:bg-zinc-700 focus:outline-none focus:border-green-500"
                style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
                  backgroundRepeat: 'no-repeat',
                  backgroundPosition: 'right 6px center',
                }}
              >
                {micDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Mic ${device.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="w-px h-6 bg-white/30" />

        <Button
          variant="link"
          size="sm"
          onClick={hasSelectedSource ? toggleRecording : openSourceSelector}
          disabled={!hasSelectedSource && !recording}
          className={`gap-1 text-white bg-transparent hover:bg-transparent px-0 flex-1 text-center text-xs ${styles.electronNoDrag}`}
        >
          {recording ? (
            <>
              <FaRegStopCircle size={14} className="text-red-400" />
              <span className="text-red-400">{formatTime(elapsed)}</span>
            </>
          ) : (
            <>
              <BsRecordCircle size={14} className={hasSelectedSource ? "text-white" : "text-white/50"} />
              <span className={hasSelectedSource ? "text-white" : "text-white/50"}>Record</span>
            </>
          )}
        </Button>

        <div className="w-px h-6 bg-white/30" />

        <Button
          variant="link"
          size="sm"
          onClick={openVideoFile}
          className={`gap-1 text-white bg-transparent hover:bg-transparent px-0 flex-1 text-right text-xs ${styles.electronNoDrag} ${styles.folderButton}`}
          disabled={recording}
        >
          <FaFolderMinus size={14} className="text-white" />
          <span className={styles.folderText}>Open</span>
        </Button>

        <div className="w-px h-6 bg-white/30 mx-2" />
        <Button
          variant="link"
          size="icon"
          className={`ml-2 ${styles.electronNoDrag} hudOverlayButton`}
          title="Hide HUD"
          onClick={sendHudOverlayHide}
        >
          <FiMinus size={18} style={{ color: '#fff', opacity: 0.7 }} />
        </Button>

        <Button
          variant="link"
          size="icon"
          className={`ml-1 ${styles.electronNoDrag} hudOverlayButton`}
          title="Close App"
          onClick={sendHudOverlayClose}
        >
          <FiX size={18} style={{ color: '#fff', opacity: 0.7 }} />
        </Button>
      </div>
    </div>
  );
}
