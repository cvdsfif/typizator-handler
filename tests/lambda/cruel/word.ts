import { HandlerProps, lambdaConnector } from "../../../src";
import { simpleApiS } from "../shared/simple-api-definition";

export const cruelWordImpl = async (_: HandlerProps, val: string) => `Goodbye, cruel ${val}`;
export const word = lambdaConnector(
    simpleApiS.metadata.implementation.cruel.word,
    cruelWordImpl
);