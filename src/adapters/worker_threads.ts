import { Worker, parentPort, isMainThread } from "worker_threads";
import { Adapter } from "../headers";

export default <Adapter>{
    isMainThread,
    fork(filename: string) {
        return new Worker(filename);
    },
    async terminate(worker: Worker) {
        await worker.terminate();
    },
    send(msg: any) {
        if (parentPort)
            parentPort.postMessage(msg);
    }
};