import { lambdaConnector } from "../../src";
import { simpleApiS } from "./shared/simple-api-definition";

export const noMeowImpl = async () => { throw new Error("Pas de miaou"); }
export const noMeow = lambdaConnector(
    simpleApiS.metadata.implementation.noMeow,
    noMeowImpl
)