import { lambdaConnector } from "../../src";
import { simpleApiS } from "./shared/simple-api-definition";

export const firebaseConnectedImpl = async () => { throw new Error("Pas de miaou"); }
export const firebaseConnected = lambdaConnector(
    simpleApiS.metadata.implementation.noMeow,
    firebaseConnectedImpl,
    {
        firebaseAdminConnected: true
    }
)