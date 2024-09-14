import { lambdaConnector } from "../../src"
import { simpleApiS } from "./shared/simple-api-definition"

export const secretsConnectedImpl = async () => { throw new Error("Pas de miaou"); }
export const secretsConnected = lambdaConnector(
    simpleApiS.metadata.implementation.noMeow,
    secretsConnectedImpl,
    {
        secretsUsed: true
    }
)