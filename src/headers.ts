import { ChildProcess } from "child_process";
import { Worker as ThreadWorker } from "worker_threads";

export type Request = [number, number | string, any[]];
export type Response = [number, Error, any];
export type Worker = ChildProcess | ThreadWorker;

export interface Adapter {
    readonly isMainThread: boolean;
    fork(filename: string): Worker;
    terminate(worker: Worker): Promise<void>;
    send(msg: any): void;
}