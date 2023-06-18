import { Logger } from "@scrypted/sdk";
import { Logger as TsLogger } from "ts-log";

export class EufyLogger implements TsLogger {

    private readonly log: Logger;

    public constructor(log: Logger) {
        this.log = log;
    }

    private _getStack(): any {
        const _prepareStackTrace = Error.prepareStackTrace;
        Error.prepareStackTrace = (_, stack) => stack;
        const stack = new Error().stack?.slice(3);
        Error.prepareStackTrace = _prepareStackTrace;
        return stack;
    }

    private getMessage(message?: string, optionalParams?: any[]): string {
        const msg = message ? message : "";
        
        if (optionalParams && optionalParams.length > 0) {
            return `${msg} ${JSON.stringify(optionalParams)}`;
        }
        
        return msg;
    }

    public trace(message?: string, ...optionalParams: any[]): void {
        this.log.v(this.getMessage(message, optionalParams));
    }

    public debug(message?: string, ...optionalParams: any[]): void {
        this.log.d(this.getMessage(message, optionalParams));
    }

    public info(message?: string, ...optionalParams: any[]): void {
        this.log.i(this.getMessage(message, optionalParams));
    }

    public warn(message?: string, ...optionalParams: any[]): void {
        this.log.w(this.getMessage(message, optionalParams));
    }

    public error(message?: string, ...optionalParams: any[]): void {
        this.log.e(this.getMessage(message, optionalParams));
    }

    public alert(message?: string, ...optionalParams: any[]): void {
        this.log.a(this.getMessage(message, optionalParams));
    }

    public clearAlerts(): void {
        this.log.clearAlerts();
    }
}