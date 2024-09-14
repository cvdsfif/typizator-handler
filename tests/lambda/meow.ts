import { lambdaConnector } from "../../src";
import { simpleApiS } from "./shared/simple-api-definition";

export const meowImpl = async () => "Miaou";
export const meow = lambdaConnector(
    simpleApiS.metadata.implementation.meow,
    meowImpl
)