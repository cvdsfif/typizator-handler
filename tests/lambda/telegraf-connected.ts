import { lambdaConnector } from "../../src";
import { simpleApiWithFirebaseS } from "./shared/simple-api-definition";

export const telegrafConnectedImpl = async () => { throw new Error("Pas de miaou"); }
export const telegrafConnected = lambdaConnector(
    simpleApiWithFirebaseS.metadata.implementation.telegrafConnected,
    telegrafConnectedImpl,
    {
        telegraf: true
    }
)