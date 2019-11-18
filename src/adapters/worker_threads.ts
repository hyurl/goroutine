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
        let { execArgv = process.execArgv, ...extra } = options;
        return new Worker(filename, {
            execArgv,
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