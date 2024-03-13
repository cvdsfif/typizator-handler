export type HandlerEvent = { body: string };

/**
 * Response object returned from the AWS Lambda handler. You rarely need to use it directly
 */
export type HandlerResponse = {
    data: string
} | string;
