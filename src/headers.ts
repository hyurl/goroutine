import { ChildProcess } from "child_process";
import { Worker as ThreadWorker } from "worker_threads";

export type Worker = ChildProcess | ThreadWorker;

export interface Adapter {
    fork(filename: string, options: {
        execArgv?: string[];
        workerData?: any;
        stdin?: boolean;
        stdout?: boolean;
        stderr?: boolean;
    }): Promise<Worker>;
    terminate(worker: Worker): Promise<void>;
    send(msg: any): void;
}