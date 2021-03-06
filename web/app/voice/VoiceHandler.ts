import * as log from "tc-shared/log";
import {LogCategory, logDebug, logInfo, logWarn} from "tc-shared/log";
import * as aplayer from "../audio/player";
import {ServerConnection} from "../connection/ServerConnection";
import {RecorderProfile} from "tc-shared/voice/RecorderProfile";
import {VoiceClientController} from "./VoiceClient";
import {settings, ValuedSettingsKey} from "tc-shared/settings";
import {tr} from "tc-shared/i18n/localize";
import {
    AbstractVoiceConnection,
    VoiceClient,
    VoiceConnectionStatus,
    WhisperSessionInitializer
} from "tc-shared/connection/VoiceConnection";
import {createErrorModal} from "tc-shared/ui/elements/Modal";
import {ServerConnectionEvents} from "tc-shared/connection/ConnectionBase";
import {ConnectionState} from "tc-shared/ConnectionHandler";
import {VoiceBridge, VoicePacket, VoiceWhisperPacket} from "./bridge/VoiceBridge";
import {NativeWebRTCVoiceBridge} from "./bridge/NativeWebRTCVoiceBridge";
import {EventType} from "tc-shared/ui/frames/log/Definitions";
import {kUnknownWhisperClientUniqueId, WhisperSession} from "tc-shared/voice/Whisper";

export enum VoiceEncodeType {
    JS_ENCODE,
    NATIVE_ENCODE
}

const KEY_VOICE_CONNECTION_TYPE: ValuedSettingsKey<number> = {
    key: "voice_connection_type",
    valueType: "number",
    defaultValue: VoiceEncodeType.NATIVE_ENCODE
};

export class VoiceConnection extends AbstractVoiceConnection {
    readonly connection: ServerConnection;

    private readonly serverConnectionStateListener;
    private connectionType: VoiceEncodeType = VoiceEncodeType.NATIVE_ENCODE;
    private connectionState: VoiceConnectionStatus;

    private localAudioStarted = false;
    private connectionLostModalOpen = false;

    private connectAttemptCounter = 0;
    private awaitingAudioInitialize = false;

    private currentAudioSource: RecorderProfile;
    private voiceClients: VoiceClientController[] = [];

    private whisperSessionInitializer: WhisperSessionInitializer;
    private whisperSessions: {[key: number]: WhisperSession} = {};

    private voiceBridge: VoiceBridge;

    private encoderCodec: number = 5;

    constructor(connection: ServerConnection) {
        super(connection);

        this.setWhisperSessionInitializer(undefined);

        this.connectionState = VoiceConnectionStatus.Disconnected;

        this.connection = connection;
        this.connectionType = settings.static_global(KEY_VOICE_CONNECTION_TYPE, this.connectionType);

        this.connection.events.on("notify_connection_state_changed",
            this.serverConnectionStateListener = this.handleServerConnectionStateChanged.bind(this));
    }

    getConnectionState(): VoiceConnectionStatus {
        return this.connectionState;
    }

    destroy() {
        this.connection.events.off(this.serverConnectionStateListener);
        this.dropVoiceBridge();
        this.acquireVoiceRecorder(undefined, true).catch(error => {
            log.warn(LogCategory.VOICE, tr("Failed to release voice recorder: %o"), error);
        }).then(() => {
            for(const client of this.voiceClients)  {
                client.abort_replay();
                client.callback_playback = undefined;
                client.callback_state_changed = undefined;
                client.callback_stopped = undefined;
            }
            this.voiceClients = undefined;
            this.currentAudioSource = undefined;
        });
        this.events.destroy();
    }

    async acquireVoiceRecorder(recorder: RecorderProfile | undefined, enforce?: boolean) {
        if(this.currentAudioSource === recorder && !enforce)
            return;

        if(this.currentAudioSource) {
            await this.voiceBridge?.setInput(undefined);
            this.currentAudioSource.callback_unmount = undefined;
            await this.currentAudioSource.unmount();
        }

        /* unmount our target recorder */
        await recorder?.unmount();

        this.handleRecorderStop();
        this.currentAudioSource = recorder;

        if(recorder) {
            recorder.current_handler = this.connection.client;

            recorder.callback_unmount = this.handleRecorderUnmount.bind(this);
            recorder.callback_start = this.handleRecorderStart.bind(this);
            recorder.callback_stop = this.handleRecorderStop.bind(this);

            recorder.callback_input_initialized = async input => {
                if(!this.voiceBridge)
                    return;

                await this.voiceBridge.setInput(input);
            };

            if(recorder.input && this.voiceBridge) {
                await this.voiceBridge.setInput(recorder.input);
            }

            if(!recorder.input || recorder.input.isFiltered()) {
                this.handleRecorderStop();
            } else {
                this.handleRecorderStart();
            }
        } else {
            await this.voiceBridge.setInput(undefined);
        }

        this.events.fire("notify_recorder_changed");
    }

    private startVoiceBridge() {
        if(!aplayer.initialized()) {
            logDebug(LogCategory.VOICE, tr("Audio player isn't initialized yet. Waiting for it to initialize."));
            if(!this.awaitingAudioInitialize) {
                this.awaitingAudioInitialize = true;
                aplayer.on_ready(() => this.startVoiceBridge());
            }
            return;
        }

        if(this.connection.getConnectionState() !== ConnectionState.CONNECTED)
            return;

        this.connectAttemptCounter++;
        if(this.voiceBridge) {
            this.voiceBridge.callback_disconnect = undefined;
            this.voiceBridge.disconnect();
        }

        this.voiceBridge = new NativeWebRTCVoiceBridge();
        this.voiceBridge.callback_incoming_voice = packet => this.handleVoicePacket(packet);
        this.voiceBridge.callback_incoming_whisper = packet => this.handleWhisperPacket(packet);
        this.voiceBridge.callback_send_control_data = (request, payload) => {
            this.connection.sendData(JSON.stringify(Object.assign({
                type: "WebRTC",
                request: request
            }, payload)))
        };
        this.voiceBridge.callback_disconnect = () => {
            this.connection.client.log.log(EventType.CONNECTION_VOICE_DROPPED, { });
            if(!this.connectionLostModalOpen) {
                this.connectionLostModalOpen = true;
                const modal =  createErrorModal(tr("Voice connection lost"), tr("Lost voice connection to the target server. Trying to reconnect..."));
                modal.close_listener.push(() => this.connectionLostModalOpen = false);
                modal.open();
            }
            logInfo(LogCategory.WEBRTC, tr("Lost voice connection to target server. Trying to reconnect."));
            this.startVoiceBridge();
        }

        this.connection.client.log.log(EventType.CONNECTION_VOICE_CONNECT, { attemptCount: this.connectAttemptCounter });
        this.setConnectionState(VoiceConnectionStatus.Connecting);
        this.voiceBridge.connect().then(result => {
            if(result.type === "success") {
                this.connectAttemptCounter = 0;

                this.connection.client.log.log(EventType.CONNECTION_VOICE_CONNECT_SUCCEEDED, { });
                const currentInput = this.voiceRecorder()?.input;
                if(currentInput) {
                    this.voiceBridge.setInput(currentInput).catch(error => {
                        createErrorModal(tr("Input recorder attechment failed"), tr("Failed to apply the current microphone recorder to the voice sender.")).open();
                        logWarn(LogCategory.VOICE, tr("Failed to apply the input to the voice bridge: %o"), error);
                        this.handleRecorderUnmount();
                    });
                }

                this.setConnectionState(VoiceConnectionStatus.Connected);
            } else if(result.type === "canceled") {
                /* we've to do nothing here */
            } else if(result.type === "failed") {
                logWarn(LogCategory.VOICE, tr("Failed to setup voice bridge: %s. Reconnect: %o"), result.message, result.allowReconnect);

                this.connection.client.log.log(EventType.CONNECTION_VOICE_CONNECT_FAILED, {
                    reason: result.message,
                    reconnect_delay: result.allowReconnect ? 1 : 0
                });

                if(result.allowReconnect) {
                    this.startVoiceBridge();
                }
            }
        });
    }

    private dropVoiceBridge() {
        if(this.voiceBridge) {
            this.voiceBridge.callback_disconnect = undefined;
            this.voiceBridge.disconnect();
            this.voiceBridge = undefined;
        }
        this.setConnectionState(VoiceConnectionStatus.Disconnected);
    }

    handleControlPacket(json) {
        this.voiceBridge.handleControlData(json["request"], json);
        return;
    }

    protected handleVoicePacket(packet: VoicePacket) {
        const chandler = this.connection.client;
        if(chandler.isSpeakerMuted() || chandler.isSpeakerDisabled()) /* we dont need to do anything with sound playback when we're not listening to it */
            return;

        let client = this.find_client(packet.clientId);
        if(!client) {
            log.error(LogCategory.VOICE, tr("Having voice from unknown audio client? (ClientID: %o)"), packet.clientId);
            return;
        }

        client.enqueuePacket(packet);
    }

    private handleRecorderStop() {
        const chandler = this.connection.client;
        const ch = chandler.getClient();
        if(ch) ch.speaking = false;

        if(!chandler.connected)
            return false;

        if(chandler.isMicrophoneMuted())
            return false;

        log.info(LogCategory.VOICE, tr("Local voice ended"));
        this.localAudioStarted = false;

        this.voiceBridge?.sendStopSignal(this.encoderCodec);
    }

    private handleRecorderStart() {
        const chandler = this.connection.client;
        if(chandler.isMicrophoneMuted()) {
            log.warn(LogCategory.VOICE, tr("Received local voice started event, even thou we're muted!"));
            return;
        }

        this.localAudioStarted = true;
        log.info(LogCategory.VOICE, tr("Local voice started"));

        const ch = chandler.getClient();
        if(ch) ch.speaking = true;
    }

    private handleRecorderUnmount() {
        log.info(LogCategory.VOICE, "Lost recorder!");
        this.currentAudioSource = undefined;
        this.acquireVoiceRecorder(undefined, true); /* we can ignore the promise because we should finish this directly */
    }

    private setConnectionState(state: VoiceConnectionStatus) {
        if(this.connectionState === state)
            return;

        const oldState = this.connectionState;
        this.connectionState = state;
        this.events.fire("notify_connection_status_changed", { newStatus: state, oldStatus: oldState });
    }

    private handleServerConnectionStateChanged(event: ServerConnectionEvents["notify_connection_state_changed"]) {
        if(event.newState === ConnectionState.CONNECTED) {
            this.startVoiceBridge();
        } else {
            this.dropVoiceBridge();
        }
    }

    voiceRecorder(): RecorderProfile {
        return this.currentAudioSource;
    }

    availableClients(): VoiceClient[] {
        return this.voiceClients;
    }

    find_client(client_id: number) : VoiceClientController | undefined {
        for(const client of this.voiceClients)
            if(client.client_id === client_id)
                return client;
        return undefined;
    }

    unregister_client(client: VoiceClient): Promise<void> {
        if(!(client instanceof VoiceClientController))
            throw "Invalid client type";

        client.destroy();
        this.voiceClients.remove(client);
        return Promise.resolve();
    }

    registerClient(client_id: number): VoiceClient {
        const client = new VoiceClientController(client_id);
        this.voiceClients.push(client);
        return client;
    }

    decodingSupported(codec: number): boolean {
        return codec >= 4 && codec <= 5;
    }

    encodingSupported(codec: number): boolean {
        return codec >= 4 && codec <= 5;
    }

    getEncoderCodec(): number {
        return this.encoderCodec;
    }

    setEncoderCodec(codec: number) {
        this.encoderCodec = codec;
    }

    protected handleWhisperPacket(packet: VoiceWhisperPacket) {
        console.error("Received voice whisper packet: %o", packet);
    }

    getWhisperSessions(): WhisperSession[] {
        return Object.values(this.whisperSessions);
    }

    dropWhisperSession(session: WhisperSession) {
        throw "this is currently not supported";
    }

    setWhisperSessionInitializer(initializer: WhisperSessionInitializer | undefined) {
        this.whisperSessionInitializer = initializer;
        if(!this.whisperSessionInitializer) {
            this.whisperSessionInitializer = async session => {
                logWarn(LogCategory.VOICE, tr("Missing whisper session initializer. Blocking whisper from %d (%s)"), session.getClientId(), session.getClientUniqueId());
                return {
                    clientName: session.getClientName() || tr("Unknown client"),
                    clientUniqueId: session.getClientUniqueId() || kUnknownWhisperClientUniqueId,

                    blocked: true,
                    volume: 1,

                    sessionTimeout: 60 * 1000
                }
            }
        }
    }

    getWhisperSessionInitializer(): WhisperSessionInitializer | undefined {
        return this.whisperSessionInitializer;
    }
}

/* funny fact that typescript dosn't find this */
declare global {
    interface RTCPeerConnection {
        addStream(stream: MediaStream): void;
        getLocalStreams(): MediaStream[];
        getStreamById(streamId: string): MediaStream | null;
        removeStream(stream: MediaStream): void;
    }
}