import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Key, Cpu, Network } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { InferenceModeSelector, SettingsRow } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import SelfHostedPanel from "../SelfHostedPanel";
import type { InferenceMode, MeetingAecStatusResult } from "../../types/electron";

export function MeetingSpeakerDetectionRow() {
  const { t } = useTranslation();
  const speakerDiarizationEnabled = useSettingsStore((s) => s.speakerDiarizationEnabled);
  const setSpeakerDiarizationEnabled = useSettingsStore((s) => s.setSpeakerDiarizationEnabled);

  return (
    <SettingsRow
      label={t("settings.meeting.speakerDetection.title")}
      description={t("settings.meeting.speakerDetection.description")}
    >
      <Toggle checked={speakerDiarizationEnabled} onChange={setSpeakerDiarizationEnabled} />
    </SettingsRow>
  );
}

export function MeetingRecordingPillRow() {
  const { t } = useTranslation();
  const showMeetingRecordingPill = useSettingsStore((s) => s.showMeetingRecordingPill);
  const setShowMeetingRecordingPill = useSettingsStore((s) => s.setShowMeetingRecordingPill);

  return (
    <SettingsRow
      label={t("settings.meeting.recordingPill.title")}
      description={t("settings.meeting.recordingPill.description")}
    >
      <Toggle checked={showMeetingRecordingPill} onChange={setShowMeetingRecordingPill} />
    </SettingsRow>
  );
}

const noop = () => {};

type EchoCancellationUiState =
  | "checking"
  | "ready"
  | "needsPermission"
  | "unavailable"
  | "unsupported";

export function MeetingEchoCancellationRow() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MeetingAecStatusResult | null>(null);
  const [isGranting, setIsGranting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await window.electronAPI?.getMeetingAecStatus?.();
      if (next) setStatus(next);
    } catch {
      // Keep the previous status if the probe fails.
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Permissions are granted in System Settings, so re-probe on focus.
    const handleFocus = () => void refresh();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh]);

  const handleGrant = async () => {
    if (isGranting) return;
    setIsGranting(true);
    try {
      const result = await window.electronAPI?.requestSystemAudioAccess?.();
      if (result && !result.granted) {
        await window.electronAPI?.openSystemAudioSettings?.();
      }
      await refresh();
    } finally {
      setIsGranting(false);
    }
  };

  const state: EchoCancellationUiState = !status
    ? "checking"
    : !status.helperSupported
      ? "unsupported"
      : !status.helperAvailable
        ? "unavailable"
        : status.systemAudio?.granted
          ? "ready"
          : "needsPermission";

  const statusLabel = {
    checking: t("settings.meeting.echoCancellation.checking"),
    ready: t("settings.meeting.echoCancellation.ready"),
    needsPermission: t("settings.meeting.echoCancellation.needsPermission"),
    unavailable: t("settings.meeting.echoCancellation.unavailable"),
    unsupported: t("settings.meeting.echoCancellation.unsupported"),
  }[state];

  const badgeClass =
    state === "ready"
      ? "bg-success/10 text-success"
      : state === "needsPermission"
        ? "bg-warning/10 text-warning"
        : "bg-muted text-muted-foreground";

  return (
    <SettingsRow
      label={t("settings.meeting.echoCancellation.title")}
      description={t("settings.meeting.echoCancellation.description")}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex h-6 items-center whitespace-nowrap rounded-md px-2 text-[11px] font-medium ${badgeClass}`}
        >
          {statusLabel}
        </span>
        {state === "needsPermission" && (
          <button
            type="button"
            onClick={handleGrant}
            disabled={isGranting}
            className="h-7 whitespace-nowrap rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            {t("settings.meeting.echoCancellation.grant")}
          </button>
        )}
      </div>
    </SettingsRow>
  );
}

export function MeetingTranscriptionPanel() {
  const { t } = useTranslation();

  const {
    meetingTranscriptionMode,
    setMeetingTranscriptionMode,
    setMeetingUseLocalWhisper,
    meetingWhisperModel,
    setMeetingWhisperModel,
    meetingLocalTranscriptionProvider,
    setMeetingLocalTranscriptionProvider,
    meetingParakeetModel,
    setMeetingParakeetModel,
    meetingFunasrModel,
    setMeetingFunasrModel,
    meetingCloudTranscriptionProvider,
    setMeetingCloudTranscriptionProvider,
    meetingCloudTranscriptionModel,
    setMeetingCloudTranscriptionModel,
    meetingCloudTranscriptionBaseUrl,
    setMeetingCloudTranscriptionBaseUrl,
    setMeetingCloudTranscriptionMode,
    meetingRemoteTranscriptionUrl,
    setMeetingRemoteTranscriptionUrl,
  } = useSettingsStore();

  const transcriptionModes: InferenceModeOption[] = [
    {
      id: "providers",
      label: t("settingsPage.transcription.modes.providers"),
      description: t("settingsPage.transcription.modes.providersDesc"),
      icon: <Key className="w-4 h-4" />,
    },
    {
      id: "local",
      label: t("settingsPage.transcription.modes.local"),
      description: t("settingsPage.transcription.modes.localDesc"),
      icon: <Cpu className="w-4 h-4" />,
    },
    {
      id: "self-hosted",
      label: t("settingsPage.transcription.modes.selfHosted"),
      description: t("settingsPage.transcription.modes.selfHostedDesc"),
      icon: <Network className="w-4 h-4" />,
    },
  ];

  const handleTranscriptionModeSelect = (mode: InferenceMode) => {
    if (mode === meetingTranscriptionMode) return;
    setMeetingTranscriptionMode(mode);
    setMeetingUseLocalWhisper(mode === "local");
    setMeetingCloudTranscriptionMode("byok");
  };

  const handleLocalTranscriptionModelSelect = useCallback(
    (modelId: string) => {
      // The picker switches provider before forwarding the selection, so the
      // captured prop can be stale — read the live store value instead.
      const activeProvider = useSettingsStore.getState().meetingLocalTranscriptionProvider;
      if (activeProvider === "nvidia") {
        setMeetingParakeetModel(modelId);
      } else if (activeProvider === "funasr") {
        setMeetingFunasrModel(modelId);
      } else {
        setMeetingWhisperModel(modelId);
      }
    },
    [setMeetingParakeetModel, setMeetingFunasrModel, setMeetingWhisperModel]
  );

  const renderTranscriptionPicker = (mode: "cloud" | "local") => (
    <TranscriptionModelPicker
      streamingOnly
      selectedCloudProvider={meetingCloudTranscriptionProvider}
      onCloudProviderSelect={setMeetingCloudTranscriptionProvider}
      selectedCloudModel={meetingCloudTranscriptionModel}
      onCloudModelSelect={setMeetingCloudTranscriptionModel}
      selectedLocalModel={
        meetingLocalTranscriptionProvider === "nvidia"
          ? meetingParakeetModel
          : meetingLocalTranscriptionProvider === "funasr"
            ? meetingFunasrModel
            : meetingWhisperModel
      }
      onLocalModelSelect={handleLocalTranscriptionModelSelect}
      selectedLocalProvider={meetingLocalTranscriptionProvider}
      onLocalProviderSelect={setMeetingLocalTranscriptionProvider}
      useLocalWhisper={mode === "local"}
      onModeChange={noop}
      mode={mode}
      cloudTranscriptionBaseUrl={meetingCloudTranscriptionBaseUrl}
      setCloudTranscriptionBaseUrl={setMeetingCloudTranscriptionBaseUrl}
      variant="settings"
    />
  );

  return (
    <div className="space-y-3">
      <InferenceModeSelector
        modes={transcriptionModes}
        activeMode={meetingTranscriptionMode}
        onSelect={handleTranscriptionModeSelect}
      />

      {meetingTranscriptionMode === "providers" && renderTranscriptionPicker("cloud")}
      {meetingTranscriptionMode === "local" && renderTranscriptionPicker("local")}
      {meetingTranscriptionMode === "self-hosted" && (
        <>
          <SelfHostedPanel
            service="transcription"
            url={meetingRemoteTranscriptionUrl}
            onUrlChange={setMeetingRemoteTranscriptionUrl}
          />
          <p className="text-xs text-muted-foreground/80 px-1">
            {t("settingsPage.speechToText.selfHostedStreamingNote")}
          </p>
        </>
      )}
      <MeetingSpeakerDetectionRow />
      <MeetingRecordingPillRow />
      <MeetingEchoCancellationRow />
    </div>
  );
}

export function MeetingAudioQualityPanel() {
  const { t } = useTranslation();
  const meetingAudioQuality = useSettingsStore((s) => s.meetingAudioQuality);
  const meetingAudioMix = useSettingsStore((s) => s.meetingAudioMix);
  const setMeetingAudioQuality = useSettingsStore((s) => s.setMeetingAudioQuality);
  const setMeetingAudioMix = useSettingsStore((s) => s.setMeetingAudioMix);

  const selectClass =
    "h-7 rounded border border-border/70 bg-surface-1/80 px-2.5 text-xs font-medium text-foreground shadow-sm hover:border-border-hover hover:bg-surface-2/70 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:ring-offset-1 transition-colors duration-200 max-w-[220px]";

  return (
    <div className="space-y-3">
      <SettingsRow
        label={t("notes.audioQuality.qualityLabel")}
        description={t("notes.audioQuality.qualityDescription")}
      >
        <select
          value={meetingAudioQuality}
          onChange={(e) => setMeetingAudioQuality(e.target.value as "standard" | "high" | "lossless")}
          className={selectClass}
        >
          <option value="standard">{t("notes.audioQuality.standard")}</option>
          <option value="high">{t("notes.audioQuality.high")}</option>
          <option value="lossless">{t("notes.audioQuality.lossless")}</option>
        </select>
      </SettingsRow>
      <SettingsRow
        label={t("notes.audioQuality.mixLabel")}
        description={t("notes.audioQuality.mixDescription")}
      >
        <select
          value={meetingAudioMix}
          onChange={(e) =>
            setMeetingAudioMix(e.target.value as "stereo" | "mix" | "system-priority")
          }
          className={selectClass}
        >
          <option value="stereo">{t("notes.audioQuality.mixStereo")}</option>
          <option value="mix">{t("notes.audioQuality.mixMono")}</option>
          <option value="system-priority">{t("notes.audioQuality.mixSystemPriority")}</option>
        </select>
      </SettingsRow>
      <p className="text-xs text-muted-foreground/80 px-1">
        {t("notes.audioQuality.newRecordingsOnly")}
      </p>
    </div>
  );
}
