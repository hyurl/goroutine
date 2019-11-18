import { Worker, parentPort } from "worker_threads";
import { Adapter } from "../headers";

export default <Adapter>{
    async fork(filename: string, options?: { execArgv?: string[] }) {
        let { execArgv = [] } = options;
        return new Worker(filename, {
            execArgv: [...process.execArgv, ...execArgv]
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