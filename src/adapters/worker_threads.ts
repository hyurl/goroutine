import { Worker, parentPort } from "worker_threads";
import { Adapter } from "../headers";

export default <Adapter>{
    async fork(filename: string) {
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