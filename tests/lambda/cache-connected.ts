import { HandlerProps, lambdaConnector } from "../../src"
import { simpleApiWithCacheS } from "./shared/cache-api-definition"

export const cacheConnectedImpl = async (_: HandlerProps) => "ok"

export const cacheConnected = lambdaConnector(
    simpleApiWithCacheS.metadata.implementation.cacheConnected,
    cacheConnectedImpl,
    { cacheConnected: true }
)
