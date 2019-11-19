import { Worker, parentPort } from "worker_threads";
import { Adapter } from "../headers";

export default <Adapter>{
    async fork(filename: string, options: {
        execArgv?: string[];
        workerData?: any;
        stdin?: boolean;
        stdout?: boolean;
        stderr?: boolean;
    }) {
        let { execArgv = process.execArgv, workerData, ...extra } = options;
        return new Worker(filename, {
            execArgv,
            workerData: {
                // HACK, pass `process.argv` to the worker thread.
                argv: process.argv.slice(2),
                workerData
            },
            ...extra
        });
    },
    async terminate(worker: Worker) {
        await worker.terminate();
    },
    send(msg: any) {
        if (parentPort)
            parentPort.postMessage(msg);
    }
};