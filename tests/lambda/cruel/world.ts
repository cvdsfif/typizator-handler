import { HandlerProps, lambdaConnector } from "../../../src";
import { simpleApiS } from "./../shared/simple-api-definition";

export const cruelWorldImpl = async (_: HandlerProps, val: string) => `Goodbye, cruel ${val}`;
export const world = lambdaConnector(
    simpleApiS.metadata.implementation.cruel.world,
    cruelWorldImpl
);