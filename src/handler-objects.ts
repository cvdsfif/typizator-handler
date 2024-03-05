export type HandlerEvent = { body: string };

/**
 * Response object returned from the AWS Lambda handler
 */
export type HandlerResponse = {
    data: string
} | string;
