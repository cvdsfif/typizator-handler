import { apiS, stringS } from "typizator";

export const simpleApiWithCacheS = apiS({
    cacheConnected: { args: [], retVal: stringS.notNull },
})
