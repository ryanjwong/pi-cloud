export const secretsEqual = (presented: string, expected: string): boolean => {
  let difference = presented.length ^ expected.length
  for (let index = 0; index < expected.length; index++) {
    difference |= (presented.charCodeAt(index) | 0) ^ expected.charCodeAt(index)
  }
  return difference === 0
}
