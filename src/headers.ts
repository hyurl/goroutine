import { ChildProcess } from "child_process";
import { Worker as ThreadWorker, WorkerOptions } from "worker_threads";

export type Worker = ChildProcess | ThreadWorker;

export interface Adapter {
    fork(filename: string, options: Omit<WorkerOptions, "eval">): Promise<Worker>;
    terminate(worker: Worker): Promise<void>;
    send(msg: any): void;
}