import { ConnectedResources } from "../../src"

export const setup = async () => {
    return
}

const setupAny: any = setup
setupAny.isSetupHandler = true
setupAny.connectedResources = [ConnectedResources.DATABASE]
