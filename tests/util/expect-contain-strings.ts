declare global {
    namespace jest {
        interface Matchers<R> {
            toContainAllStrings(...strs: string[]): CustomMatcherResult;
        }
    }
}

export const extendExpectWithToContainStrings = () =>
    expect.extend({
        toContainAllStrings(received: any, ...expected: string[]) {
            const receivedMessage = received.message ?? received
            return {
                pass: !expected.find(part => !receivedMessage.includes(part)),
                message: () => `Received ${receivedMessage
                    } result doesn't contain all of ${expected
                    }. First mismatch found: ${expected.find(part => !receivedMessage.includes(part))}`
            }
        }
    });