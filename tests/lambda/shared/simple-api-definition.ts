import { apiS, bigintS, stringS } from "typizator";

export const simpleApiS = apiS({
    meow: { args: [], retVal: stringS.notNull },
    noMeow: { args: [] },
    helloWorld: { args: [stringS.notNull, bigintS.notNull], retVal: stringS.notNull },
    cruel: {
        world: { args: [stringS.notNull], retVal: stringS.notNull }
    }
})

export const simpleApiWithFirebaseS = apiS({
    meow: { args: [], retVal: stringS.notNull },
    noMeow: { args: [], hidden: true },
    firebaseConnected: { args: [] },
    secretsConnected: { args: [] },
    telegrafConnected: { args: [] },
    telegrafInline: { args: [] },
    helloWorld: { args: [stringS.notNull, bigintS.notNull], retVal: stringS.notNull },
    cruel: {
        world: { args: [stringS.notNull], retVal: stringS.notNull }
    }
})

export const simpleApiWithWrongTelegrafS = apiS({
    meow: { args: [], retVal: stringS.notNull },
    noMeow: { args: [], hidden: true },
    firebaseConnected: { args: [] },
    secretsConnected: { args: [] },
    telegrafConnected: { args: [], hidden: true },
    telegrafInline: { args: [] },
    helloWorld: { args: [stringS.notNull, bigintS.notNull], retVal: stringS.notNull },
    cruel: {
        world: { args: [stringS.notNull], retVal: stringS.notNull }
    }
})