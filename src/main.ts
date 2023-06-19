import sdk, { Camera, Device, DeviceProvider, FFmpegInput, MediaObject, MotionSensor, OnOff, RequestMediaStreamOptions, RequestPictureOptions, ResponseMediaStreamOptions, ResponsePictureOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, SettingValue, Settings, VideoCamera } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { EufySecurity, Camera as EufyCamera, CaptchaOptions, Device as EufyDevice, P2PConnectionType, Station as EufyStation, EufySecurityConfig, Station } from 'eufy-security-client';
import { EufyLogger } from './logger';

const { deviceManager, mediaManager } = sdk;

class EufySecurityCamera extends ScryptedDeviceBase implements VideoCamera, Camera, OnOff, MotionSensor {
    private station: Station;

    constructor(nativeId: string, private client: EufySecurity, private device: EufyCamera) {
        super(nativeId);
        this.initialize();
    }

    private async initialize() {
        this.station = await this.client.getStation(this.device.getStationSerial());
        this.station.on('livestream start', (station, channel, metadata, videoStream, audioStream) => {
        });

        this.on = this.device.isEnabled() as boolean;

        this.setupMotionDetection();
    }

    setupMotionDetection() {
        const handle = (device: EufyDevice, state: boolean) => {
          this.motionDetected = state;
        };
        this.device.on('motion detected', handle);
        this.device.on('person detected', handle);
        this.device.on('pet detected', handle);
        this.device.on('vehicle detected', handle);
        this.device.on('dog detected', handle);
        this.device.on('radar motion detected', handle);
      }

    async turnOff(): Promise<void> {
        if (this.device.isEnabled() as boolean === true) {
            await this.station.enableDevice(this.device, false);
        }

        this.on = false;
    }

    async turnOn(): Promise<void> {
        if (this.device.isEnabled() as boolean === false) {
            await this.station.enableDevice(this.device, true);
        }

        this.on = true;
    }

    takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        const picture = this.device.getPropertyValue('picture');
        return mediaManager.createMediaObject((picture as any).data, 'image/jpeg');
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [
            {
                canResize: true,
                staleDuration: 10
            }
        ]
    }

    getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        let ffmpegInput: FFmpegInput;

        ffmpegInput = {
            // the input doesn't HAVE to be an url, but if it is, provide this hint.
            url: this.device.getPropertyValue('rtspStreamUrl').toString(),
            inputArguments: [
                '-re',
                '-stream_loop', '-1',
                '-i', this.device.getRawDevice().ip_addr + this.device.getPropertyValue('hidden-pictureUrl').toString(),
            ]
        };

        return mediaManager.createMediaObject(Buffer.from(JSON.stringify(ffmpegInput)), ScryptedMimeTypes.FFmpegInput);
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return [{
            id: 'stream',
            audio: null,
            video: {
                codec: 'h264',
            }
        }];
      }
}

class EufySecurityPlugin extends ScryptedDeviceBase implements DeviceProvider, Settings {
    logger: EufyLogger;

    client: EufySecurity;

    devices = new Map<string, any>();

    settingsStorage = new StorageSettings(this, {
        country: {
            title: 'Country',
            defaultValue: 'US',
        },
        email: {
            title: 'Email',
            onPut: async () => this.tryLogin(),
        },
        password: {
            title: 'Password',
            type: 'password',
            onPut: async () => this.tryLogin(),
        },
        trustedDeviceName: {
            title: 'Trusted device name',
        },
        twoFactorCode: {
            title: 'Two Factor Code',
            description: 'Optional: If 2FA is enabled on your account, enter the code sent to your email or phone number.',
            onPut: async (oldValue, newValue) => {
                await this.tryLogin(newValue);
            },
            noStore: true,
        },
        captcha: {
            title: 'Captcha',
            description: 'Optional: If a captcha request is recieved, enter the code in the image.',
            onPut: async (oldValue, newValue) => {
                await this.tryLogin(undefined, newValue);
            },
            noStore: true,
        },
        captchaId: {
            title: 'Captcha Id',
            hide: true,
        }
    });

    constructor() {
        super();
        this.logger = new EufyLogger(this.log);
        this.tryLogin();
    }

    getSettings(): Promise<Setting[]> {
        return this.settingsStorage.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.settingsStorage.putSetting(key, value);
    }

    async tryLogin(twoFactorCode?: string, captchaCode?: string) {
        this.logger.clearAlerts();

        if (!this.settingsStorage.values.email || !this.settingsStorage.values.email) {
            this.logger.alert('Enter your Eufy email and password to complete setup.');
            throw new Error('Eufy email and password are missing.');
        }

        await this.initializeClient();

        var captchaOptions: CaptchaOptions | undefined = undefined
        if (captchaCode) {
            captchaOptions = {
                captchaCode: captchaCode,
                captchaId: this.settingsStorage.values.captchaId,
            }

        }

        this.logger.debug('connect client');
        await this.client.connect({ verifyCode: twoFactorCode, captcha: captchaOptions, force: false });
    }

    private async initializeClient() {
        const config: EufySecurityConfig = {
            username: this.settingsStorage.values.email,
            password: this.settingsStorage.values.password,
            country: this.settingsStorage.values.country,
            trustedDeviceName: this.settingsStorage.values.trustedDeviceName,
            p2pConnectionSetup: P2PConnectionType.QUICKEST,
            pollingIntervalMinutes: 10,
            eventDurationSeconds: 10,
        };

        this.client = await EufySecurity.initialize(config, new EufyLogger(this.log));
        this.client.on('device added', this.deviceAdded.bind(this));
        this.client.on('station added', this.stationAdded.bind(this));
        this.client.on('tfa request', () => {
            this.logger.alert('Login failed: 2FA is enabled, check your email or texts for your code, then enter it into the Two Factor Code setting to conplete login.');
        });
        this.client.on('captcha request', (id, captcha) => {
            this.logger.alert(`Login failed: Captcha was requested, fill out the Captcha setting to conplete login. </br> <img src="${captcha}" />`);
            this.settingsStorage.putSetting('captchaId', id);
        });
        this.client.on('connect', () => {
            this.logger.debug(`[${this.name}] (${new Date().toLocaleString()}) Client connected.`);
            this.logger.clearAlerts();
        });
        this.client.on('push connect', () => {
            this.logger.debug(`[${this.name}] (${new Date().toLocaleString()}) Push Connected.`);
        });
        this.client.on('push close', () => {
            this.logger.debug(`[${this.name}] (${new Date().toLocaleString()}) Push Closed.`);
        });
    }

    private async deviceAdded(eufyDevice: EufyDevice) {
        if (!eufyDevice.isCamera) {
            this.logger.info(`[${this.name}] (${new Date().toLocaleString()}) Ignoring unsupported discovered device: `, eufyDevice.getName(), eufyDevice.getModel());
            return;
        }
        this.logger.info(`[${this.name}] (${new Date().toLocaleString()}) Device discovered: `, eufyDevice.getName(), eufyDevice.getModel());

        const nativeId = eufyDevice.getSerial();

        const interfaces = [
            ScryptedInterface.VideoCamera,
            ScryptedInterface.Camera,
            ScryptedInterface.OnOff
        ];
        
        const device: Device = {
            info: {
                model: eufyDevice.getModel(),
                manufacturer: 'Eufy',
                firmware: eufyDevice.getSoftwareVersion(),
                serialNumber: nativeId
            },
            nativeId,
            name: eufyDevice.getName(),
            type: ScryptedDeviceType.Camera,
            interfaces,
        };

        this.devices.set(nativeId, new EufySecurityCamera(nativeId, this.client, eufyDevice as EufyCamera))
        await deviceManager.onDeviceDiscovered(device);
    }

    private async stationAdded(station: EufyStation) {
        this.logger.info(`[${this.name}] (${new Date().toLocaleString()}) Station discovered: `, station.getName(), station.getModel(), `but stations are not currently supported.`);
    }

    async getDevice(nativeId: string): Promise<any> {
        return this.devices.get(nativeId);
    }

    async releaseDevice(id: string, nativeId: string) {
        this.logger.info(`[${this.name}] (${new Date().toLocaleString()}) Device with id '${nativeId}' was removed.`);
    }
}

export default EufySecurityPlugin;
