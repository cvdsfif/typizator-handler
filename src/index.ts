import { ArrayMetadata, FunctionCallDefinition, InferArguments, InferTargetFromSchema, NotImplementedError, ObjectMetadata, Schema } from "typizator";
import JSONBig from "json-bigint";

export const PING = "@@ping";
export type HandlerEvent = { body: string };

export type HandlerResponse = {
    data?: string,
    errorMessage?: string
} | string;

export const describeJsonSchema = (schema: Schema<any, any, any>) => {
    return schema.metadata.dataType === "object" ?
        `{${Array.from((schema.metadata as ObjectMetadata).fields).map(
            ([key, value]): string => `"${key}":${describeJsonSchema(value)}`
        )}}` :
        schema.metadata.dataType === "array" ?
            `"${(schema.metadata as ArrayMetadata).elements.metadata.dataType}[]"` :
            `"${schema.metadata.dataType}"`;
}

export const describeJsonFunction = (definition: FunctionCallDefinition) =>
    `{"args":[${definition.args.map(arg => describeJsonSchema(arg!)).join(",")
    }],"retVal":${definition.retVal ? describeJsonSchema(definition.retVal) : `"void"`
    }}`;

const callImplementation = async <T extends FunctionCallDefinition>(
    eventBody: string,
    definition: T,
    implementation: ((...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>)):
    Promise<string> => {
    let args = [];
    if (definition.args.length > 0) {
        const jsonArgs = JSONBig.parse(eventBody);
        if (!Array.isArray(jsonArgs))
            throw new Error(`Call arguments must be an array. Got ${eventBody}.`);
        args = definition.args.map((schema, index) => {
            const receivedArg = jsonArgs[index];
            if (receivedArg === undefined && !schema?.metadata.optional)
                throw new Error(`Argument ${index} is undefined and it should't be`);
            if (receivedArg === null && schema?.metadata.notNull)
                throw new Error(`Argument ${index} is null and it should't be`);
            return definition.args[index]?.unbox(receivedArg)
        })

    }
    return JSONBig.stringify(await implementation(...args as any));
}

export const handlerImpl = <T extends FunctionCallDefinition>(
    definition: T,
    implementation: ((...args: InferArguments<T["args"]>) => Promise<InferTargetFromSchema<T["retVal"]>>)):
    ((event: HandlerEvent) => Promise<HandlerResponse>) => {
    return async (event: HandlerEvent) => {
        if (event.body === PING) return { data: describeJsonFunction(definition) }
        return callImplementation(event.body, definition, implementation)
            .then(retval => ({ data: retval }))
            .catch(e => {
                console.error(`Error caught: ${e.message ?? e}`);
                console.error(e.stack);
                return JSONBig.stringify({
                    errorMessage: `Handler error: ${e.message ?? e}`
                });
            });
    };
}
