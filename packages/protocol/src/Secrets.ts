/**
 * Compare a presented secret with an expected one in time that depends only on their lengths, so a caller cannot
 * learn a secret one character at a time from response times.
 */
export const secretsEqual = (presented: string, expected: string): boolean => {
  let difference = presented.length ^ expected.length
  for (let index = 0; index < expected.length; index++) {
    difference |= (presented.charCodeAt(index) | 0) ^ expected.charCodeAt(index)
  }
  return difference === 0
}
