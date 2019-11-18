import { Worker, parentPort } from "worker_threads";
import { Adapter } from "../headers";

export default <Adapter>{
    async fork(filename: string, options?: {
        execArgv?: string[];
        workerData?: any;
    }) {
        let { execArgv = [], workerData } = options;
        return new Worker(filename, {
            execArgv: [...process.execArgv, ...execArgv],
            workerData
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