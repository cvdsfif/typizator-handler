export type SpecialHeaderNames = "x-security-token" | "x-forwarded-for"
export type SpecialHeders = {
    [K in SpecialHeaderNames]?: string
}

export type HandlerEvent = {
    headers?: SpecialHeders,
    cookies?: string[],
    body: string,
    requestContext?: {
        http?: {
            sourceIp?: string
        }
    }
}

/**
 * Response object returned from the AWS Lambda handler. You rarely need to use it directly
 */
export type HandlerResponse = {
    data: string
} | string | {
    body: string
}
