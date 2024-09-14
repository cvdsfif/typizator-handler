import { lambdaConnector } from "../../src";
import { simpleApiWithFirebaseS } from "./shared/simple-api-definition";

export const telegrafInlineImpl = async () => { throw new Error("Pas de miaou"); }
export const telegrafInline = lambdaConnector(
    simpleApiWithFirebaseS.metadata.implementation.telegrafInline,
    telegrafInlineImpl,
    {
        telegraf: true
    }
)