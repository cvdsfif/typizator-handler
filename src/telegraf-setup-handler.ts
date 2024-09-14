import { ConnectedResources, createTelegrafConnection } from "./"
import { CdkCustomResourceResponse, CloudFormationCustomResourceEvent } from "./lib/cloud-formation-types"
import { successResponse } from "./migration/postgres/postgres-migration-handler"

export const telegrafSetupHandler = ():
    (event: CloudFormationCustomResourceEvent) => Promise<CdkCustomResourceResponse> => {
    const fn = async (event: CloudFormationCustomResourceEvent) => {
        let resourceId: string
        if (event.RequestType === "Create")
            resourceId = `custom-${event.RequestId}`
        else resourceId = event.PhysicalResourceId;
        const apiUrl = process.env.TELEGRAF_API_URL
        if (!apiUrl) throw new Error("TELEGRAF_API_URL is not set")

        const telegraf = await createTelegrafConnection()
        if (event.RequestType !== "Create") {
            await telegraf.telegram.deleteWebhook()
        }
        if (event.RequestType !== "Delete") {
            await telegraf.telegram.setWebhook(apiUrl)
        }
        return successResponse(`Telegram bot set at URL: ${apiUrl}`, resourceId, event)
    }
    fn.connectedResources = [ConnectedResources.TELEGRAF]
    return fn
}